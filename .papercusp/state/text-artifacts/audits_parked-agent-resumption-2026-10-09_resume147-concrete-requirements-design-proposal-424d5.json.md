---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume147-concrete-requirements-design-proposal-424d5.json"
updated_at: 1792254564905
_body: "content"
---

{
  "schemaVersion": "parked-concrete-requirements-design-proposal-v1",
  "status": "DRAFT_NOT_APPLIED_NOT_ACCEPTANCE",
  "at": "2026-10-17T16:28:55.459793+00:00",
  "parent": "WI-6554700010008887",
  "plan": {
    "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
    "version": 66,
    "contentHash": "f46c23ae46f17d96ba532461780a19207876be7d827f7c7931dcfa971211316d"
  },
  "sourceArtifact": "audits/parked-agent-resumption-2026-10-09/fire98-atomic-outcome-decomposition-and-discharge-draft-424d5.json",
  "sourceArtifactSha256": "6be79578696b3f4def941b5281ea7ce037a2d660494b175cebb0cf3e47324e93",
  "childBridgeArtifact": "audits/parked-agent-resumption-2026-10-09/resume146-fourth-producer-draft-proof-map-424d5.json",
  "proposedRequirementsAppendix": "**R-15 — The agents-stranded standing alarm is active at a measured stranded count of at least 5.**\n```requirement\n{\"intent\":{\"request\":\"The agents-stranded standing alarm is active at a measured stranded count of at least 5.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-012\"]},\"acceptance\":{\"condition\":\"The agents-stranded standing alarm is active at a measured stranded count of at least 5.\",\"falsifier\":\"A readable stranded count of 5 or more produces no agents-stranded alarm.\",\"evidencePlane\":\"live\",\"requiredScope\":[\"packages/operator-core/lib/system-health/agent-strand-census.ts\",\"packages/operator-core/lib/system-health/liveness-alarm.ts\"],\"requiredTestLayers\":[\"e2e\"]},\"verification\":{\"method\":\"Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Use the maintained current-build isolated operator-api route after its clean prerequisite preflight; record the actual loaded runtime. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: exact 4/5 boundary; independent of wedged count; reuse census/silent-halt any-live predicate.\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts\",\"packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts\"]}}}\n```\n\n**R-16 — An unobserved census leg preserves its existing population alarm.**\n```requirement\n{\"intent\":{\"request\":\"An unobserved census leg preserves its existing population alarm.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-012\"]},\"acceptance\":{\"condition\":\"An unobserved census leg preserves its existing population alarm.\",\"falsifier\":\"An unreadable leg, errored panel, or missing census snapshot clears its existing alarm.\",\"evidencePlane\":\"live\",\"requiredScope\":[\"packages/operator-core/lib/system-health/agent-strand-census.ts\",\"packages/operator-core/lib/system-health/liveness-alarm.ts\"],\"requiredTestLayers\":[\"e2e\"]},\"verification\":{\"method\":\"Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Use the maintained current-build isolated operator-api route after its clean prerequisite preflight; record the actual loaded runtime. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: unreadable wedged leg; unreadable stranded leg; errored panel; older-build missing-census snapshot; readable below-threshold recovery control.\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts\",\"packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts\"]}}}\n```\n\n**R-17 — The coordination panel exposes each measured wedged-host class count.**\n```requirement\n{\"intent\":{\"request\":\"The coordination panel exposes each measured wedged-host class count.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-012\"]},\"acceptance\":{\"condition\":\"The coordination panel exposes each measured wedged-host class count.\",\"falsifier\":\"A measured host class has an absent or incorrect panel count.\",\"evidencePlane\":\"live\",\"requiredScope\":[\"packages/operator-core/lib/system-health/agent-strand-census.ts\",\"packages/operator-core/lib/system-health/liveness-alarm.ts\",\"packages/operator-core/lib/system-health/compute.ts\"],\"requiredTestLayers\":[\"e2e\"]},\"verification\":{\"method\":\"Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Use the maintained current-build isolated operator-api route after its clean prerequisite preflight; record the actual loaded runtime. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: same census writer and class partition; no rederived liveness; unobserved class remains unknown.\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/system-health/agent-strand-census.test.ts\",\"packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts\",\"packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts\"]}}}\n```\n\n**R-18 — A population strand condition leaves the coordination panel at WARN severity.**\n```requirement\n{\"intent\":{\"request\":\"A population strand condition leaves the coordination panel at WARN severity.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-012\"]},\"acceptance\":{\"condition\":\"A population strand condition leaves the coordination panel at WARN severity.\",\"falsifier\":\"The population condition elevates the coordination panel to CRIT and duplicates its population alarm through panel:coordination.\",\"evidencePlane\":\"live\",\"requiredScope\":[\"packages/operator-core/lib/system-health/agent-strand-census.ts\",\"packages/operator-core/lib/system-health/liveness-alarm.ts\",\"packages/operator-core/lib/system-health/compute.ts\"],\"requiredTestLayers\":[\"e2e\"]},\"verification\":{\"method\":\"Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Use the maintained current-build isolated operator-api route after its clean prerequisite preflight; record the actual loaded runtime. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: wedged-only condition; stranded-only condition; both populations; nonpopulation panel conditions remain independent.\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts\",\"packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts\"]}}}\n```\n\n**R-19 — Repeated observations of one open population-alarm episode produce one owner page.**\n```requirement\n{\"intent\":{\"request\":\"Repeated observations of one open population-alarm episode produce one owner page.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-012\"]},\"acceptance\":{\"condition\":\"Repeated observations of one open population-alarm episode produce one owner page.\",\"falsifier\":\"The same open episode produces another owner page before its documented recovery and flap-suppression boundary.\",\"evidencePlane\":\"live\",\"requiredScope\":[\"packages/operator-core/lib/system-health/agent-strand-census.ts\",\"packages/operator-core/lib/system-health/liveness-alarm.ts\"],\"requiredTestLayers\":[\"e2e\"]},\"verification\":{\"method\":\"Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Use the maintained current-build isolated operator-api route after its clean prerequisite preflight; record the actual loaded runtime. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: episode dedupe; flap suppression; observed recovery then genuine new episode.\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts\",\"packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts\"]}}}\n```\n\n**R-20 — The eligible delayed census binding-stranded count does not exceed the frozen original live baseline.**\n```requirement\n{\"intent\":{\"request\":\"The eligible delayed census binding-stranded count does not exceed the frozen original live baseline.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\"]},\"acceptance\":{\"condition\":\"The eligible delayed census binding-stranded count does not exceed the frozen original live baseline.\",\"falsifier\":\"The eligible delayed count exceeds that exact baseline.\",\"evidencePlane\":\"live\",\"requiredScope\":[\"parked-agent census rerun\"],\"requiredTestLayers\":[\"e2e\"]},\"verification\":{\"method\":\"Reuse the maintained parked-agent-census instrument from original R14. Resolve exact baseline and all-fix runtime anchor from WI-10008164. Before anchor+24h return not-yet-eligible. At the eligible delayed time archive original query configuration, exact population and complete per-owner outcomes; use the exact preserved baseline/owner bound for this outcome. Missing inputs remain unknown. Bind the maintained e2e proof; do not invent a test filename or waive actual elapsed time. Controls: exact original baseline artifact and population; same scripted query; final all-fix loaded-runtime anchor; actual elapsed interval at least 24h; missing baseline or anchor is unknown.\",\"check\":{\"kind\":\"instrument\",\"instrumentKey\":\"parked-agent-census\"}}}\n```\n\n**R-21 — The eligible delayed AUTO+claims+no-wake count satisfies the owner-approved near-zero bound frozen before outcomes.**\n```requirement\n{\"intent\":{\"request\":\"The eligible delayed AUTO+claims+no-wake count satisfies the owner-approved near-zero bound frozen before outcomes.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\"]},\"acceptance\":{\"condition\":\"The eligible delayed AUTO+claims+no-wake count satisfies the owner-approved near-zero bound frozen before outcomes.\",\"falsifier\":\"The eligible delayed count exceeds that frozen owner-approved bound.\",\"evidencePlane\":\"live\",\"requiredScope\":[\"parked-agent census rerun\"],\"requiredTestLayers\":[\"e2e\"]},\"verification\":{\"method\":\"Reuse the maintained parked-agent-census instrument from original R14. Resolve exact baseline and all-fix runtime anchor from WI-10008164. Before anchor+24h return not-yet-eligible. At the eligible delayed time archive original query configuration, exact population and complete per-owner outcomes; use the exact preserved baseline/owner bound for this outcome. Missing inputs remain unknown. Bind the maintained e2e proof; do not invent a test filename or waive actual elapsed time. Controls: owner-authored bound before outcome observation; same no-wake definition and population; typed blocker-only versus mixed actionable holds; final all-fix runtime anchor; actual elapsed interval at least 24h.\",\"check\":{\"kind\":\"instrument\",\"instrumentKey\":\"parked-agent-census\"}}}\n```\n\n**R-22 — An otherwise eligible parked autonomous session receives a silent-halt verdict exactly when it holds actionable work without an eligible live wake source.**\n```requirement\n{\"intent\":{\"request\":\"Silent-halt classifies a parked autonomous session as stranded exactly when it holds actionable work without an eligible live wake source.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-006\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-008\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-009\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-023\"]},\"acceptance\":{\"condition\":\"An otherwise eligible parked autonomous session receives a silent-halt verdict exactly when it holds actionable work without an eligible live wake source.\",\"falsifier\":\"An own-inbox or dead-target watch hides actionable held work, a live untimed event watch is rejected, or blocker-only held work is counted as actionable.\",\"evidencePlane\":\"tree\",\"requiredScope\":[\"packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\"],\"requiredTestLayers\":[\"unit\"]},\"verification\":{\"method\":\"Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: own inbox exclusion; self-held done/terminal/missing target exclusions; any-live untimed watch positive control; blocked or needs-human plus active typed external blocker excluded; wip/plain blocked/internal-dependency holds stay actionable; mixed holds retain actionable verdict and excluded IDs; retain eligibility/cadence/recent-turn/fleet-control exclusions; do not broaden candidate population.\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts\"]}}}\n```\n\n**R-23 — A silent-halt recovery attempt wakes an eligible host that does not require relaunch.**\n```requirement\n{\"intent\":{\"request\":\"A silent-halt recovery attempt wakes an eligible host that does not require relaunch.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-006\"]},\"acceptance\":{\"condition\":\"A silent-halt recovery attempt wakes an eligible host that does not require relaunch.\",\"falsifier\":\"A healthy, recoverable-on-wake, no-host, or read-failure branch suppresses the bounded wake attempt.\",\"evidencePlane\":\"tree\",\"requiredScope\":[\"packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\"],\"requiredTestLayers\":[\"unit\"]},\"verification\":{\"method\":\"Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: host classification; existing wake fan bound; measured pickup remains distinct from queued wake.\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts\"]}}}\n```\n\n**R-24 — A silent-halt verdict for a host requiring relaunch produces an actionable host-recovery page.**\n```requirement\n{\"intent\":{\"request\":\"A silent-halt verdict for a host requiring relaunch produces an actionable host-recovery page.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-006\"]},\"acceptance\":{\"condition\":\"A silent-halt verdict for a host requiring relaunch produces an actionable host-recovery page.\",\"falsifier\":\"An unhealthy host receives only a futile wake or no page naming its measured condition and remedy.\",\"evidencePlane\":\"tree\",\"requiredScope\":[\"packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\"],\"requiredTestLayers\":[\"unit\"]},\"verification\":{\"method\":\"Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: auth/quota/unbound/pending-turn classes; no ordinary wake on needs-relaunch; new-page versus existing-page behavior.\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts\"]}}}\n```\n\n**R-25 — A fleet member's newly created silent-halt page alerts its fleet leader once per halt epoch.**\n```requirement\n{\"intent\":{\"request\":\"A fleet member's newly created silent-halt page alerts its fleet leader once per halt epoch.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-006\"]},\"acceptance\":{\"condition\":\"A fleet member's newly created silent-halt page alerts its fleet leader once per halt epoch.\",\"falsifier\":\"A new fleet-member page omits its leader alert or a deduped page repeats that alert in the same epoch.\",\"evidencePlane\":\"tree\",\"requiredScope\":[\"packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\"],\"requiredTestLayers\":[\"unit\"]},\"verification\":{\"method\":\"Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: new page alerts and wakes leader; deduped page does not repeat; nonfleet control; next halt epoch.\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts\"]}}}\n```\n\n**R-26 — Existing deduped silent-halt pages leave the configured new-page budget available to new halts.**\n```requirement\n{\"intent\":{\"request\":\"Existing deduped silent-halt pages leave the configured new-page budget available to new halts.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-006\"]},\"acceptance\":{\"condition\":\"Existing deduped silent-halt pages leave the configured new-page budget available to new halts.\",\"falsifier\":\"A deduped page consumes that budget or new pages exceed the configured cap.\",\"evidencePlane\":\"tree\",\"requiredScope\":[\"packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\"],\"requiredTestLayers\":[\"unit\"]},\"verification\":{\"method\":\"Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: standing pages ahead of new halt; all-new mass halt capped; separate wake budget.\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts\"]}}}\n```\n\n**R-27 — A stalled-loop disarm remains visible to the bounded silent-halt fallback.**\n```requirement\n{\"intent\":{\"request\":\"A stalled-loop disarm remains visible to the bounded silent-halt fallback.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-006\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-009\"]},\"acceptance\":{\"condition\":\"A stalled-loop disarm remains visible to the bounded silent-halt fallback.\",\"falsifier\":\"A detector-created at-disarm await exempts the disarmed session from that fallback.\",\"evidencePlane\":\"tree\",\"requiredScope\":[\"packages/operator-core/lib/harness/routines/stalled-loops-guard.ts\",\"packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\"],\"requiredTestLayers\":[\"unit\"]},\"verification\":{\"method\":\"Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: no synthetic at-disarm exemption; existing genuine external awaits keep their any-live semantics; threshold max(30min,5intervals).\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/harness/routines/stalled-loops-guard.test.ts\",\"packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts\"]}}}\n```\n\n**R-28 — A Codex quota-wall host record publishes the parsed provider reset instant.**\n```requirement\n{\"intent\":{\"request\":\"A Codex quota-wall host record publishes the parsed provider reset instant.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-013\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-014\"]},\"acceptance\":{\"condition\":\"A Codex quota-wall host record publishes the parsed provider reset instant.\",\"falsifier\":\"A supported provider reset statement yields a missing or incorrect quotaResetAtMs on the host record.\",\"evidencePlane\":\"tree\",\"requiredScope\":[\"apps/operator/scripts/psu-pty-host.mjs\"],\"requiredTestLayers\":[\"unit\"]},\"verification\":{\"method\":\"Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: absolute local-time reset; relative duration; ANSI/wrapped statement; latest statement; no-stated-reset unknown control.\",\"check\":{\"kind\":\"tests\",\"files\":[\"apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts\"]}}}\n```\n\n**R-29 — A Codex quota latch releases the next same-route recovery attempt when its stated reset becomes due.**\n```requirement\n{\"intent\":{\"request\":\"A Codex quota latch releases the next same-route recovery attempt when its stated reset becomes due.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-013\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-014\"]},\"acceptance\":{\"condition\":\"A Codex quota latch releases the next same-route recovery attempt when its stated reset becomes due.\",\"falsifier\":\"The reset is due but the unchanged-route attempt remains indefinitely latched.\",\"evidencePlane\":\"tree\",\"requiredScope\":[\"apps/operator/scripts/psu-pty-host.mjs\"],\"requiredTestLayers\":[\"unit\"]},\"verification\":{\"method\":\"Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: before/at reset; same account/model/owner/carry; expiry consumed once.\",\"check\":{\"kind\":\"tests\",\"files\":[\"apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts\"]}}}\n```\n\n**R-30 — A latched Codex quota wall permits one deferred wake when its bounded backoff probe becomes due.**\n```requirement\n{\"intent\":{\"request\":\"A latched Codex quota wall permits one deferred wake when its bounded backoff probe becomes due.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-014\"]},\"acceptance\":{\"condition\":\"A latched Codex quota wall permits one deferred wake when its bounded backoff probe becomes due.\",\"falsifier\":\"An early top-up cannot be discovered before the stated reset or more than one wake bypasses the same probe interval.\",\"evidencePlane\":\"tree\",\"requiredScope\":[\"apps/operator/scripts/psu-pty-host.mjs\"],\"requiredTestLayers\":[\"unit\"]},\"verification\":{\"method\":\"Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: initial interval; one deferred wake; backoff progression; early capacity return; non-Codex control.\",\"check\":{\"kind\":\"tests\",\"files\":[\"apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts\"]}}}\n```\n\n**R-31 — A still-walled Codex probe re-establishes the quota latch from its current provider response.**\n```requirement\n{\"intent\":{\"request\":\"A still-walled Codex probe re-establishes the quota latch from its current provider response.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-013\",\"plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-014\"]},\"acceptance\":{\"condition\":\"A still-walled Codex probe re-establishes the quota latch from its current provider response.\",\"falsifier\":\"The failed probe leaves unlimited wake admission or retains an obsolete reset instead of re-latching.\",\"evidencePlane\":\"tree\",\"requiredScope\":[\"apps/operator/scripts/psu-pty-host.mjs\"],\"requiredTestLayers\":[\"unit\"]},\"verification\":{\"method\":\"Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: new provider reset; banner repaint; bounded subsequent probe; new episode resets base interval; D014 withdrawal of blanket default-route prohibition.\",\"check\":{\"kind\":\"tests\",\"files\":[\"apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts\"]}}}\n```\n\n**R-32 — Rendered fleet-scope-admission guidance reserves loop:end for a legitimate completion or stop.**\n```requirement\n{\"intent\":{\"request\":\"Rendered fleet-scope-admission guidance reserves loop:end for a legitimate completion or stop.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\"]},\"acceptance\":{\"condition\":\"Rendered fleet-scope-admission guidance reserves loop:end for a legitimate completion or stop.\",\"falsifier\":\"A rendered external-blocker branch instructs an agent with retained unfinished obligations to call loop:end.\",\"evidencePlane\":\"tree\",\"requiredScope\":[\"packages/operator-core/lib/scheduler/fleet-scope-admission.ts\"],\"requiredTestLayers\":[\"unit\",\"llm\"]},\"verification\":{\"method\":\"Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Reuse the exact completed hermetic unit/LLM/mutation recipes and independently audited item-local S41 clauses in WI-6554700010015848; keep their immutable original failures/caps/retractions. Require a separately qualified parent binding rather than treating a child close as parent acceptance. Controls: fourth producer rendered seam; done/released/handed-off/owner-stop controls; maintained su LLM receipt at current render.\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts\",\"packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"]}}}\n```\n\n**R-33 — Rendered fleet-scope-admission guidance directs a partially blocked agent to continue its independent work.**\n```requirement\n{\"intent\":{\"request\":\"Rendered fleet-scope-admission guidance directs a partially blocked agent to continue its independent work.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\"]},\"acceptance\":{\"condition\":\"Rendered fleet-scope-admission guidance directs a partially blocked agent to continue its independent work.\",\"falsifier\":\"A partial blocker makes the rendered guidance direct whole-task parking before independent work is exhausted.\",\"evidencePlane\":\"tree\",\"requiredScope\":[\"packages/operator-core/lib/scheduler/fleet-scope-admission.ts\"],\"requiredTestLayers\":[\"unit\",\"llm\"]},\"verification\":{\"method\":\"Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Reuse the exact completed hermetic unit/LLM/mutation recipes and independently audited item-local S41 clauses in WI-6554700010015848; keep their immutable original failures/caps/retractions. Require a separately qualified parent binding rather than treating a child close as parent acceptance. Controls: independent step remains; all remaining steps genuinely blocked control; maintained su LLM receipt.\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts\",\"packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"]}}}\n```\n\n**R-34 — Rendered fleet-scope-admission guidance gives a fully blocked agent a bounded wake on its specific unblocking event.**\n```requirement\n{\"intent\":{\"request\":\"Rendered fleet-scope-admission guidance gives a fully blocked agent a bounded wake on its specific unblocking event.\",\"sourceRefs\":[\"session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20\"]},\"acceptance\":{\"condition\":\"Rendered fleet-scope-admission guidance gives a fully blocked agent a bounded wake on its specific unblocking event.\",\"falsifier\":\"The rendered advice uses an untimed generic watch, a self-deadlocking held-item done event, or no wake-on-timeout bound.\",\"evidencePlane\":\"tree\",\"requiredScope\":[\"packages/operator-core/lib/scheduler/fleet-scope-admission.ts\"],\"requiredTestLayers\":[\"unit\",\"llm\"]},\"verification\":{\"method\":\"Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Reuse the exact completed hermetic unit/LLM/mutation recipes and independently audited item-local S41 clauses in WI-6554700010015848; keep their immutable original failures/caps/retractions. Require a separately qualified parent binding rather than treating a child close as parent acceptance. Controls: record actual typed blocker; exact event key; on_timeout wake and bound; no held-item done self-deadlock; maintained su LLM receipt.\",\"check\":{\"kind\":\"tests\",\"files\":[\"packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts\",\"packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"]}}}\n```",
  "proposedDesignAppendix": "### Proposed atomic supplement map (DRAFT; apply only after independent review and readiness checks)\n\n| proposed BAR | Fire98 draft | original obligation | plan items | plane | current disposition |\n| --- | --- | --- | --- | --- | --- |\n| R-15 | F98-15A | R-12 | P-011 | live | SOURCE_MAP_ONLY |\n| R-16 | F98-15B | R-12 | P-011 | live | SOURCE_MAP_ONLY |\n| R-17 | F98-15C | R-12 | P-011 | live | SOURCE_MAP_ONLY |\n| R-18 | F98-15D | R-12 | P-011 | live | SOURCE_MAP_ONLY |\n| R-19 | F98-15E | R-12 | P-011 | live | SOURCE_MAP_ONLY |\n| R-20 | F98-16 | R-14 | P-013 | live | BLOCKED_INPUT |\n| R-21 | F98-17 | R-14 | P-013 | live | BLOCKED_INPUT |\n| R-22 | F98-18A | R-7 | P-007, P-013 | tree | SOURCE_MAP_ONLY |\n| R-23 | F98-18B | R-7 | P-007 | tree | SOURCE_MAP_ONLY |\n| R-24 | F98-18C | R-7 | P-007 | tree | SOURCE_MAP_ONLY |\n| R-25 | F98-18D | R-7 | P-007 | tree | SOURCE_MAP_ONLY |\n| R-26 | F98-18E | R-7 | P-007 | tree | SOURCE_MAP_ONLY |\n| R-27 | F98-18F | R-7 | P-007 | tree | SOURCE_MAP_ONLY |\n| R-28 | F98-19A | R-7 | P-004, P-012 | tree | SOURCE_MAP_ONLY |\n| R-29 | F98-19B | R-7 | P-004, P-012 | tree | SOURCE_MAP_ONLY |\n| R-30 | F98-19C | R-7 | P-004, P-012 | tree | SOURCE_MAP_ONLY |\n| R-31 | F98-19D | R-7 | P-004, P-012 | tree | SOURCE_MAP_ONLY |\n| R-32 | F98-20A | R-8 | P-008 | tree | PROPOSED_CHILD_EVIDENCE_BRIDGE |\n| R-33 | F98-20B | R-8 | P-008 | tree | PROPOSED_CHILD_EVIDENCE_BRIDGE |\n| R-34 | F98-20C | R-8 | P-008 | tree | PROPOSED_CHILD_EVIDENCE_BRIDGE |",
  "rows": [
    {
      "draftId": "F98-15A",
      "proposedBarId": "R-15",
      "originalObligation": "R-12",
      "planItems": [
        "P-011"
      ],
      "sourceDecisions": [
        "D-012"
      ],
      "proposedRequirement": {
        "intent": {
          "request": "The agents-stranded standing alarm is active at a measured stranded count of at least 5.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-012"
          ]
        },
        "acceptance": {
          "condition": "The agents-stranded standing alarm is active at a measured stranded count of at least 5.",
          "falsifier": "A readable stranded count of 5 or more produces no agents-stranded alarm.",
          "evidencePlane": "live",
          "requiredScope": [
            "packages/operator-core/lib/system-health/agent-strand-census.ts",
            "packages/operator-core/lib/system-health/liveness-alarm.ts"
          ],
          "requiredTestLayers": [
            "e2e"
          ]
        },
        "verification": {
          "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Use the maintained current-build isolated operator-api route after its clean prerequisite preflight; record the actual loaded runtime. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: exact 4/5 boundary; independent of wedged count; reuse census/silent-halt any-live predicate.",
          "check": {
            "kind": "tests",
            "files": [
              "packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts",
              "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts"
            ]
          }
        }
      },
      "locatedCaseRefs": [
        {
          "path": "packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts",
          "line": 152,
          "text": "it('does not fire one below the threshold', () => {"
        },
        {
          "path": "packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts",
          "line": 156,
          "text": "it('fires agents-stranded AT its threshold, independently of the wedged count', () => {"
        }
      ],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [],
      "disposition": "SOURCE_MAP_ONLY",
      "remaining": [
        "Named source and unit controls exist. The inspected current-build e2e declares agents-wedged and three hosted signals only; it does not exercise agents-stranded or live panel class/WARN presentation. No e2e/live receipt for this supplement is claimed. The ongoing selected R12 case cannot discharge it."
      ]
    },
    {
      "draftId": "F98-15B",
      "proposedBarId": "R-16",
      "originalObligation": "R-12",
      "planItems": [
        "P-011"
      ],
      "sourceDecisions": [
        "D-012"
      ],
      "proposedRequirement": {
        "intent": {
          "request": "An unobserved census leg preserves its existing population alarm.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-012"
          ]
        },
        "acceptance": {
          "condition": "An unobserved census leg preserves its existing population alarm.",
          "falsifier": "An unreadable leg, errored panel, or missing census snapshot clears its existing alarm.",
          "evidencePlane": "live",
          "requiredScope": [
            "packages/operator-core/lib/system-health/agent-strand-census.ts",
            "packages/operator-core/lib/system-health/liveness-alarm.ts"
          ],
          "requiredTestLayers": [
            "e2e"
          ]
        },
        "verification": {
          "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Use the maintained current-build isolated operator-api route after its clean prerequisite preflight; record the actual loaded runtime. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: unreadable wedged leg; unreadable stranded leg; errored panel; older-build missing-census snapshot; readable below-threshold recovery control.",
          "check": {
            "kind": "tests",
            "files": [
              "packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts",
              "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts"
            ]
          }
        }
      },
      "locatedCaseRefs": [
        {
          "path": "packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts",
          "line": 165,
          "text": "it('an unreadable leg raises nothing for that leg and is unobservable, not recovered', () => {"
        },
        {
          "path": "packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts",
          "line": 174,
          "text": "it('a computed panel MISSING the census (an older build wrote it) keeps both alarms open', () => {"
        },
        {
          "path": "packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts",
          "line": 180,
          "text": "it('an errored coordination panel keeps both alarms open', () => {"
        },
        {
          "path": "packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts",
          "line": 186,
          "text": "it('a readable census below threshold is an observed recovery', () => {"
        }
      ],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [],
      "disposition": "SOURCE_MAP_ONLY",
      "remaining": [
        "Named source and unit controls exist. The inspected current-build e2e declares agents-wedged and three hosted signals only; it does not exercise agents-stranded or live panel class/WARN presentation. No e2e/live receipt for this supplement is claimed. The ongoing selected R12 case cannot discharge it."
      ]
    },
    {
      "draftId": "F98-15C",
      "proposedBarId": "R-17",
      "originalObligation": "R-12",
      "planItems": [
        "P-011"
      ],
      "sourceDecisions": [
        "D-012"
      ],
      "proposedRequirement": {
        "intent": {
          "request": "The coordination panel exposes each measured wedged-host class count.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-012"
          ]
        },
        "acceptance": {
          "condition": "The coordination panel exposes each measured wedged-host class count.",
          "falsifier": "A measured host class has an absent or incorrect panel count.",
          "evidencePlane": "live",
          "requiredScope": [
            "packages/operator-core/lib/system-health/agent-strand-census.ts",
            "packages/operator-core/lib/system-health/liveness-alarm.ts",
            "packages/operator-core/lib/system-health/compute.ts"
          ],
          "requiredTestLayers": [
            "e2e"
          ]
        },
        "verification": {
          "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Use the maintained current-build isolated operator-api route after its clean prerequisite preflight; record the actual loaded runtime. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: same census writer and class partition; no rederived liveness; unobserved class remains unknown.",
          "check": {
            "kind": "tests",
            "files": [
              "packages/operator-core/lib/system-health/agent-strand-census.test.ts",
              "packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts",
              "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts"
            ]
          }
        }
      },
      "locatedCaseRefs": [
        {
          "path": "packages/operator-core/lib/system-health/agent-strand-census.test.ts",
          "line": 20,
          "text": "it('counts only verdicts that carry wedged, by class', () => {"
        },
        {
          "path": "packages/operator-core/lib/system-health/agent-strand-census.test.ts",
          "line": 78,
          "text": "it('passes the roster to the oracle and folds both legs', async () => {"
        }
      ],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [
        "Include the measured coordination-panel writer compute.ts in requiredScope; do not infer panel output from the census helper alone."
      ],
      "disposition": "SOURCE_MAP_ONLY",
      "remaining": [
        "Named source and unit controls exist. The inspected current-build e2e declares agents-wedged and three hosted signals only; it does not exercise agents-stranded or live panel class/WARN presentation. No e2e/live receipt for this supplement is claimed. The ongoing selected R12 case cannot discharge it."
      ]
    },
    {
      "draftId": "F98-15D",
      "proposedBarId": "R-18",
      "originalObligation": "R-12",
      "planItems": [
        "P-011"
      ],
      "sourceDecisions": [
        "D-012"
      ],
      "proposedRequirement": {
        "intent": {
          "request": "A population strand condition leaves the coordination panel at WARN severity.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-012"
          ]
        },
        "acceptance": {
          "condition": "A population strand condition leaves the coordination panel at WARN severity.",
          "falsifier": "The population condition elevates the coordination panel to CRIT and duplicates its population alarm through panel:coordination.",
          "evidencePlane": "live",
          "requiredScope": [
            "packages/operator-core/lib/system-health/agent-strand-census.ts",
            "packages/operator-core/lib/system-health/liveness-alarm.ts",
            "packages/operator-core/lib/system-health/compute.ts"
          ],
          "requiredTestLayers": [
            "e2e"
          ]
        },
        "verification": {
          "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Use the maintained current-build isolated operator-api route after its clean prerequisite preflight; record the actual loaded runtime. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: wedged-only condition; stranded-only condition; both populations; nonpopulation panel conditions remain independent.",
          "check": {
            "kind": "tests",
            "files": [
              "packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts",
              "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts"
            ]
          }
        }
      },
      "locatedCaseRefs": [
        {
          "path": "packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts",
          "line": 204,
          "text": "it('warns on any wedged or stranded session but never goes crit (the alarm owns paging)', () => {"
        }
      ],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [
        "Include the measured coordination-panel writer compute.ts in requiredScope; do not infer panel output from the census helper alone."
      ],
      "disposition": "SOURCE_MAP_ONLY",
      "remaining": [
        "Named source and unit controls exist. The inspected current-build e2e declares agents-wedged and three hosted signals only; it does not exercise agents-stranded or live panel class/WARN presentation. No e2e/live receipt for this supplement is claimed. The ongoing selected R12 case cannot discharge it."
      ]
    },
    {
      "draftId": "F98-15E",
      "proposedBarId": "R-19",
      "originalObligation": "R-12",
      "planItems": [
        "P-011"
      ],
      "sourceDecisions": [
        "D-012"
      ],
      "proposedRequirement": {
        "intent": {
          "request": "Repeated observations of one open population-alarm episode produce one owner page.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-012"
          ]
        },
        "acceptance": {
          "condition": "Repeated observations of one open population-alarm episode produce one owner page.",
          "falsifier": "The same open episode produces another owner page before its documented recovery and flap-suppression boundary.",
          "evidencePlane": "live",
          "requiredScope": [
            "packages/operator-core/lib/system-health/agent-strand-census.ts",
            "packages/operator-core/lib/system-health/liveness-alarm.ts"
          ],
          "requiredTestLayers": [
            "e2e"
          ]
        },
        "verification": {
          "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Use the maintained current-build isolated operator-api route after its clean prerequisite preflight; record the actual loaded runtime. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: episode dedupe; flap suppression; observed recovery then genuine new episode.",
          "check": {
            "kind": "tests",
            "files": [
              "packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts",
              "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts"
            ]
          }
        }
      },
      "locatedCaseRefs": [
        {
          "path": "packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts",
          "line": 103,
          "text": "it('pins the emitting artifact and exact threshold observation without changing dedup identity', async () => {"
        }
      ],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [],
      "disposition": "SOURCE_MAP_ONLY",
      "remaining": [
        "Named source and unit controls exist. The inspected current-build e2e declares agents-wedged and three hosted signals only; it does not exercise agents-stranded or live panel class/WARN presentation. No e2e/live receipt for this supplement is claimed. The ongoing selected R12 case cannot discharge it.",
        "Unit identity stability is supporting evidence only; actual repeated owner-page episode and flap/recovery behavior still require exact live witness."
      ]
    },
    {
      "draftId": "F98-16",
      "proposedBarId": "R-20",
      "originalObligation": "R-14",
      "planItems": [
        "P-013"
      ],
      "sourceDecisions": [],
      "proposedRequirement": {
        "intent": {
          "request": "The eligible delayed census binding-stranded count does not exceed the frozen original live baseline.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20"
          ]
        },
        "acceptance": {
          "condition": "The eligible delayed census binding-stranded count does not exceed the frozen original live baseline.",
          "falsifier": "The eligible delayed count exceeds that exact baseline.",
          "evidencePlane": "live",
          "requiredScope": [
            "parked-agent census rerun"
          ],
          "requiredTestLayers": [
            "e2e"
          ]
        },
        "verification": {
          "method": "Reuse the maintained parked-agent-census instrument from original R14. Resolve exact baseline and all-fix runtime anchor from WI-10008164. Before anchor+24h return not-yet-eligible. At the eligible delayed time archive original query configuration, exact population and complete per-owner outcomes; use the exact preserved baseline/owner bound for this outcome. Missing inputs remain unknown. Bind the maintained e2e proof; do not invent a test filename or waive actual elapsed time. Controls: exact original baseline artifact and population; same scripted query; final all-fix loaded-runtime anchor; actual elapsed interval at least 24h; missing baseline or anchor is unknown.",
          "check": {
            "kind": "instrument",
            "instrumentKey": "parked-agent-census"
          }
        }
      },
      "locatedCaseRefs": [],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [],
      "disposition": "BLOCKED_INPUT",
      "remaining": [
        "Resolve the exact original baseline selector without changing its population; preserve an unavailable baseline as unknown."
      ]
    },
    {
      "draftId": "F98-17",
      "proposedBarId": "R-21",
      "originalObligation": "R-14",
      "planItems": [
        "P-013"
      ],
      "sourceDecisions": [],
      "proposedRequirement": {
        "intent": {
          "request": "The eligible delayed AUTO+claims+no-wake count satisfies the owner-approved near-zero bound frozen before outcomes.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20"
          ]
        },
        "acceptance": {
          "condition": "The eligible delayed AUTO+claims+no-wake count satisfies the owner-approved near-zero bound frozen before outcomes.",
          "falsifier": "The eligible delayed count exceeds that frozen owner-approved bound.",
          "evidencePlane": "live",
          "requiredScope": [
            "parked-agent census rerun"
          ],
          "requiredTestLayers": [
            "e2e"
          ]
        },
        "verification": {
          "method": "Reuse the maintained parked-agent-census instrument from original R14. Resolve exact baseline and all-fix runtime anchor from WI-10008164. Before anchor+24h return not-yet-eligible. At the eligible delayed time archive original query configuration, exact population and complete per-owner outcomes; use the exact preserved baseline/owner bound for this outcome. Missing inputs remain unknown. Bind the maintained e2e proof; do not invent a test filename or waive actual elapsed time. Controls: owner-authored bound before outcome observation; same no-wake definition and population; typed blocker-only versus mixed actionable holds; final all-fix runtime anchor; actual elapsed interval at least 24h.",
          "check": {
            "kind": "instrument",
            "instrumentKey": "parked-agent-census"
          }
        }
      },
      "locatedCaseRefs": [],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [],
      "disposition": "BLOCKED_INPUT",
      "remaining": [
        "Owner interpretation of near zero remains pending; no numeric threshold is invented.",
        "This parameterized draft cannot be applied or graded before that answer."
      ]
    },
    {
      "draftId": "F98-18A",
      "proposedBarId": "R-22",
      "originalObligation": "R-7",
      "planItems": [
        "P-007",
        "P-013"
      ],
      "sourceDecisions": [
        "D-006",
        "D-008",
        "D-009",
        "D-023"
      ],
      "proposedRequirement": {
        "intent": {
          "request": "Silent-halt classifies a parked autonomous session as stranded exactly when it holds actionable work without an eligible live wake source.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-006",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-008",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-009",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-023"
          ]
        },
        "acceptance": {
          "condition": "An otherwise eligible parked autonomous session receives a silent-halt verdict exactly when it holds actionable work without an eligible live wake source.",
          "falsifier": "An own-inbox or dead-target watch hides actionable held work, a live untimed event watch is rejected, or blocker-only held work is counted as actionable.",
          "evidencePlane": "tree",
          "requiredScope": [
            "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts"
          ],
          "requiredTestLayers": [
            "unit"
          ]
        },
        "verification": {
          "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: own inbox exclusion; self-held done/terminal/missing target exclusions; any-live untimed watch positive control; blocked or needs-human plus active typed external blocker excluded; wip/plain blocked/internal-dependency holds stay actionable; mixed holds retain actionable verdict and excluded IDs; retain eligibility/cadence/recent-turn/fleet-control exclusions; do not broaden candidate population.",
          "check": {
            "kind": "tests",
            "files": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ]
          }
        }
      },
      "locatedCaseRefs": [
        {
          "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "line": 111,
          "text": "it('active typed external-blocker holds alone do not justify a silent-halt page (D-010/P-010)', () => {"
        },
        {
          "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "line": 121,
          "text": "it('still pages on actionable held work and names coexisting blocker-parked IDs', () => {"
        },
        {
          "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "line": 693,
          "text": "it(\"the candidate read does NOT count the session's own inbox-wake watcher as a wake source\", async () => {"
        },
        {
          "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "line": 705,
          "text": "it('a dead work-item await does not exempt the session either (D-008 (1), via the shared predicate)', async () => {"
        },
        {
          "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "line": 714,
          "text": "it('a live untimed await still exempts the session (D-009: the detector stays lenient)', async () => {"
        },
        {
          "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "line": 984,
          "text": "it('counts none of the four dead shapes, so a stranded session reads as having no wake source', async () => {"
        }
      ],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [],
      "disposition": "SOURCE_MAP_ONLY",
      "remaining": [
        "Exact current ledger/source bindings for the located unit controls remain to be qualified; source location is not a test verdict."
      ]
    },
    {
      "draftId": "F98-18B",
      "proposedBarId": "R-23",
      "originalObligation": "R-7",
      "planItems": [
        "P-007"
      ],
      "sourceDecisions": [
        "D-006"
      ],
      "proposedRequirement": {
        "intent": {
          "request": "A silent-halt recovery attempt wakes an eligible host that does not require relaunch.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-006"
          ]
        },
        "acceptance": {
          "condition": "A silent-halt recovery attempt wakes an eligible host that does not require relaunch.",
          "falsifier": "A healthy, recoverable-on-wake, no-host, or read-failure branch suppresses the bounded wake attempt.",
          "evidencePlane": "tree",
          "requiredScope": [
            "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts"
          ],
          "requiredTestLayers": [
            "unit"
          ]
        },
        "verification": {
          "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: host classification; existing wake fan bound; measured pickup remains distinct from queued wake.",
          "check": {
            "kind": "tests",
            "files": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ]
          }
        }
      },
      "locatedCaseRefs": [
        {
          "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "line": 512,
          "text": "it('caps the wake fan and DEFERS the overflow — it never falls through to the page', async () => {"
        },
        {
          "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "line": 777,
          "text": "it('a healthy, recoverable, or unreadable host keeps the wake-first rung exactly as before', async () => {"
        },
        {
          "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "line": 790,
          "text": "it('a host read that THROWS degrades to the wake-first rung, never to silence', async () => {"
        }
      ],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [],
      "disposition": "SOURCE_MAP_ONLY",
      "remaining": [
        "Exact current ledger/source bindings for the located unit controls remain to be qualified; source location is not a test verdict."
      ]
    },
    {
      "draftId": "F98-18C",
      "proposedBarId": "R-24",
      "originalObligation": "R-7",
      "planItems": [
        "P-007"
      ],
      "sourceDecisions": [
        "D-006"
      ],
      "proposedRequirement": {
        "intent": {
          "request": "A silent-halt verdict for a host requiring relaunch produces an actionable host-recovery page.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-006"
          ]
        },
        "acceptance": {
          "condition": "A silent-halt verdict for a host requiring relaunch produces an actionable host-recovery page.",
          "falsifier": "An unhealthy host receives only a futile wake or no page naming its measured condition and remedy.",
          "evidencePlane": "tree",
          "requiredScope": [
            "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts"
          ],
          "requiredTestLayers": [
            "unit"
          ]
        },
        "verification": {
          "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: auth/quota/unbound/pending-turn classes; no ordinary wake on needs-relaunch; new-page versus existing-page behavior.",
          "check": {
            "kind": "tests",
            "files": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ]
          }
        }
      },
      "locatedCaseRefs": [
        {
          "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "line": 758,
          "text": "it('a host that needs a relaunch is NOT woken; it is paged at once with the HOST UNHEALTHY remedy', async () => {"
        }
      ],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [],
      "disposition": "SOURCE_MAP_ONLY",
      "remaining": [
        "Exact current ledger/source bindings for the located unit controls remain to be qualified; source location is not a test verdict."
      ]
    },
    {
      "draftId": "F98-18D",
      "proposedBarId": "R-25",
      "originalObligation": "R-7",
      "planItems": [
        "P-007"
      ],
      "sourceDecisions": [
        "D-006"
      ],
      "proposedRequirement": {
        "intent": {
          "request": "A fleet member's newly created silent-halt page alerts its fleet leader once per halt epoch.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-006"
          ]
        },
        "acceptance": {
          "condition": "A fleet member's newly created silent-halt page alerts its fleet leader once per halt epoch.",
          "falsifier": "A new fleet-member page omits its leader alert or a deduped page repeats that alert in the same epoch.",
          "evidencePlane": "tree",
          "requiredScope": [
            "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts"
          ],
          "requiredTestLayers": [
            "unit"
          ]
        },
        "verification": {
          "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: new page alerts and wakes leader; deduped page does not repeat; nonfleet control; next halt epoch.",
          "check": {
            "kind": "tests",
            "files": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ]
          }
        }
      },
      "locatedCaseRefs": [
        {
          "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "line": 832,
          "text": "it(\"a fleet member's NEW page also alerts its fleet leader, once; a deduped page does not\", async () => {"
        },
        {
          "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "line": 859,
          "text": "it('a non-fleet session is paged without any fleet-leader alert', async () => {"
        },
        {
          "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "line": 898,
          "text": "it('alerts once for the same owner and epoch, then alerts again for a new epoch', async () => {"
        }
      ],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [],
      "disposition": "SOURCE_MAP_ONLY",
      "remaining": [
        "Exact current ledger/source bindings for the located unit controls remain to be qualified; source location is not a test verdict."
      ]
    },
    {
      "draftId": "F98-18E",
      "proposedBarId": "R-26",
      "originalObligation": "R-7",
      "planItems": [
        "P-007"
      ],
      "sourceDecisions": [
        "D-006"
      ],
      "proposedRequirement": {
        "intent": {
          "request": "Existing deduped silent-halt pages leave the configured new-page budget available to new halts.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-006"
          ]
        },
        "acceptance": {
          "condition": "Existing deduped silent-halt pages leave the configured new-page budget available to new halts.",
          "falsifier": "A deduped page consumes that budget or new pages exceed the configured cap.",
          "evidencePlane": "tree",
          "requiredScope": [
            "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts"
          ],
          "requiredTestLayers": [
            "unit"
          ]
        },
        "verification": {
          "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: standing pages ahead of new halt; all-new mass halt capped; separate wake budget.",
          "check": {
            "kind": "tests",
            "files": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ]
          }
        }
      },
      "locatedCaseRefs": [
        {
          "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "line": 808,
          "text": "it('a DEDUPED page does not consume the per-sweep cap, so standing halts cannot starve a new one', async () => {"
        },
        {
          "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "line": 823,
          "text": "it('the cap still bounds NEWLY created pages', async () => {"
        },
        {
          "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "line": 925,
          "text": "it('does not let existing intents with channel attempts starve a new halt out of the page cap', async () => {"
        }
      ],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [],
      "disposition": "SOURCE_MAP_ONLY",
      "remaining": [
        "Exact current ledger/source bindings for the located unit controls remain to be qualified; source location is not a test verdict."
      ]
    },
    {
      "draftId": "F98-18F",
      "proposedBarId": "R-27",
      "originalObligation": "R-7",
      "planItems": [
        "P-007"
      ],
      "sourceDecisions": [
        "D-006",
        "D-009"
      ],
      "proposedRequirement": {
        "intent": {
          "request": "A stalled-loop disarm remains visible to the bounded silent-halt fallback.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-006",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-009"
          ]
        },
        "acceptance": {
          "condition": "A stalled-loop disarm remains visible to the bounded silent-halt fallback.",
          "falsifier": "A detector-created at-disarm await exempts the disarmed session from that fallback.",
          "evidencePlane": "tree",
          "requiredScope": [
            "packages/operator-core/lib/harness/routines/stalled-loops-guard.ts",
            "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts"
          ],
          "requiredTestLayers": [
            "unit"
          ]
        },
        "verification": {
          "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: no synthetic at-disarm exemption; existing genuine external awaits keep their any-live semantics; threshold max(30min,5intervals).",
          "check": {
            "kind": "tests",
            "files": [
              "packages/operator-core/lib/harness/routines/stalled-loops-guard.test.ts",
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ]
          }
        }
      },
      "locatedCaseRefs": [
        {
          "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "line": 157,
          "text": "it('does not page a loop disarmed seconds ago — most disarms self-heal', () => {"
        },
        {
          "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "line": 183,
          "text": "it('scales the staleness floor with the loop interval, never below the 30m floor', () => {"
        }
      ],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [],
      "disposition": "SOURCE_MAP_ONLY",
      "remaining": [
        "Named cadence/disarm controls support the fallback. Exact cross-producer no-synthetic-at-disarm control and its current ledger proof remain to be qualified; no absence claim is made from this limited source index."
      ]
    },
    {
      "draftId": "F98-19A",
      "proposedBarId": "R-28",
      "originalObligation": "R-7",
      "planItems": [
        "P-004",
        "P-012"
      ],
      "sourceDecisions": [
        "D-013",
        "D-014"
      ],
      "proposedRequirement": {
        "intent": {
          "request": "A Codex quota-wall host record publishes the parsed provider reset instant.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-013",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-014"
          ]
        },
        "acceptance": {
          "condition": "A Codex quota-wall host record publishes the parsed provider reset instant.",
          "falsifier": "A supported provider reset statement yields a missing or incorrect quotaResetAtMs on the host record.",
          "evidencePlane": "tree",
          "requiredScope": [
            "apps/operator/scripts/psu-pty-host.mjs"
          ],
          "requiredTestLayers": [
            "unit"
          ]
        },
        "verification": {
          "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: absolute local-time reset; relative duration; ANSI/wrapped statement; latest statement; no-stated-reset unknown control.",
          "check": {
            "kind": "tests",
            "files": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ]
          }
        }
      },
      "locatedCaseRefs": [
        {
          "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "line": 52,
          "text": "it('parses the incident copy as a local-time instant', () => {"
        },
        {
          "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "line": 56,
          "text": "it('parses the clause after ANSI styling and terminal line wraps', () => {"
        },
        {
          "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "line": 62,
          "text": "it('parses a relative duration from the moment it is read', () => {"
        },
        {
          "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "line": 80,
          "text": "it('uses the newest statement when the window holds an older wall too', () => {"
        },
        {
          "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "line": 151,
          "text": "it('keeps the fail-closed level when no reset is stated and probing is off (control)', () => {"
        }
      ],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [],
      "disposition": "SOURCE_MAP_ONLY",
      "remaining": [
        "Named detector/parser unit controls are located. They alone do not prove the full host-record publication, identity-preserving admission or deferred-wake wiring; qualify the relevant full-host controls and original ledger proof before acceptance."
      ]
    },
    {
      "draftId": "F98-19B",
      "proposedBarId": "R-29",
      "originalObligation": "R-7",
      "planItems": [
        "P-004",
        "P-012"
      ],
      "sourceDecisions": [
        "D-013",
        "D-014"
      ],
      "proposedRequirement": {
        "intent": {
          "request": "A Codex quota latch releases the next same-route recovery attempt when its stated reset becomes due.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-013",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-014"
          ]
        },
        "acceptance": {
          "condition": "A Codex quota latch releases the next same-route recovery attempt when its stated reset becomes due.",
          "falsifier": "The reset is due but the unchanged-route attempt remains indefinitely latched.",
          "evidencePlane": "tree",
          "requiredScope": [
            "apps/operator/scripts/psu-pty-host.mjs"
          ],
          "requiredTestLayers": [
            "unit"
          ]
        },
        "verification": {
          "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: before/at reset; same account/model/owner/carry; expiry consumed once.",
          "check": {
            "kind": "tests",
            "files": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ]
          }
        }
      },
      "locatedCaseRefs": [
        {
          "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "line": 98,
          "text": "it('holds the incident latch until the stated reset, then expires it once', () => {"
        }
      ],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [],
      "disposition": "SOURCE_MAP_ONLY",
      "remaining": [
        "Named detector/parser unit controls are located. They alone do not prove the full host-record publication, identity-preserving admission or deferred-wake wiring; qualify the relevant full-host controls and original ledger proof before acceptance."
      ]
    },
    {
      "draftId": "F98-19C",
      "proposedBarId": "R-30",
      "originalObligation": "R-7",
      "planItems": [
        "P-004",
        "P-012"
      ],
      "sourceDecisions": [
        "D-014"
      ],
      "proposedRequirement": {
        "intent": {
          "request": "A latched Codex quota wall permits one deferred wake when its bounded backoff probe becomes due.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-014"
          ]
        },
        "acceptance": {
          "condition": "A latched Codex quota wall permits one deferred wake when its bounded backoff probe becomes due.",
          "falsifier": "An early top-up cannot be discovered before the stated reset or more than one wake bypasses the same probe interval.",
          "evidencePlane": "tree",
          "requiredScope": [
            "apps/operator/scripts/psu-pty-host.mjs"
          ],
          "requiredTestLayers": [
            "unit"
          ]
        },
        "verification": {
          "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: initial interval; one deferred wake; backoff progression; early capacity return; non-Codex control.",
          "check": {
            "kind": "tests",
            "files": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ]
          }
        }
      },
      "locatedCaseRefs": [
        {
          "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "line": 162,
          "text": "it('probes a latched codex wall before its stated reset, backing off while it stays walled', () => {"
        },
        {
          "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "line": 193,
          "text": "it('starts a new episode at the base interval once a wall returns long after the last probe', () => {"
        },
        {
          "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "line": 205,
          "text": "it('never probes a claude wall (its TUI auto-continues at the reset)', () => {"
        }
      ],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [],
      "disposition": "SOURCE_MAP_ONLY",
      "remaining": [
        "Named detector/parser unit controls are located. They alone do not prove the full host-record publication, identity-preserving admission or deferred-wake wiring; qualify the relevant full-host controls and original ledger proof before acceptance."
      ]
    },
    {
      "draftId": "F98-19D",
      "proposedBarId": "R-31",
      "originalObligation": "R-7",
      "planItems": [
        "P-004",
        "P-012"
      ],
      "sourceDecisions": [
        "D-013",
        "D-014"
      ],
      "proposedRequirement": {
        "intent": {
          "request": "A still-walled Codex probe re-establishes the quota latch from its current provider response.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-013",
            "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-014"
          ]
        },
        "acceptance": {
          "condition": "A still-walled Codex probe re-establishes the quota latch from its current provider response.",
          "falsifier": "The failed probe leaves unlimited wake admission or retains an obsolete reset instead of re-latching.",
          "evidencePlane": "tree",
          "requiredScope": [
            "apps/operator/scripts/psu-pty-host.mjs"
          ],
          "requiredTestLayers": [
            "unit"
          ]
        },
        "verification": {
          "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Controls: new provider reset; banner repaint; bounded subsequent probe; new episode resets base interval; D014 withdrawal of blanket default-route prohibition.",
          "check": {
            "kind": "tests",
            "files": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ]
          }
        }
      },
      "locatedCaseRefs": [
        {
          "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "line": 130,
          "text": "it('re-latches with the new reset when the wall is still up on the next turn', () => {"
        },
        {
          "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "line": 162,
          "text": "it('probes a latched codex wall before its stated reset, backing off while it stays walled', () => {"
        }
      ],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [],
      "disposition": "SOURCE_MAP_ONLY",
      "remaining": [
        "Named detector/parser unit controls are located. They alone do not prove the full host-record publication, identity-preserving admission or deferred-wake wiring; qualify the relevant full-host controls and original ledger proof before acceptance."
      ]
    },
    {
      "draftId": "F98-20A",
      "proposedBarId": "R-32",
      "originalObligation": "R-8",
      "planItems": [
        "P-008"
      ],
      "sourceDecisions": [],
      "proposedRequirement": {
        "intent": {
          "request": "Rendered fleet-scope-admission guidance reserves loop:end for a legitimate completion or stop.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20"
          ]
        },
        "acceptance": {
          "condition": "Rendered fleet-scope-admission guidance reserves loop:end for a legitimate completion or stop.",
          "falsifier": "A rendered external-blocker branch instructs an agent with retained unfinished obligations to call loop:end.",
          "evidencePlane": "tree",
          "requiredScope": [
            "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
          ],
          "requiredTestLayers": [
            "unit",
            "llm"
          ]
        },
        "verification": {
          "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Reuse the exact completed hermetic unit/LLM/mutation recipes and independently audited item-local S41 clauses in WI-6554700010015848; keep their immutable original failures/caps/retractions. Require a separately qualified parent binding rather than treating a child close as parent acceptance. Controls: fourth producer rendered seam; done/released/handed-off/owner-stop controls; maintained su LLM receipt at current render.",
          "check": {
            "kind": "tests",
            "files": [
              "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ]
          }
        }
      },
      "locatedCaseRefs": [
        {
          "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "line": 67,
          "text": "it('rejects a transcript with no recorded initial user turn', () => {"
        },
        {
          "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "line": 118,
          "text": "it('calibration: finished work stops, while missing-event work checkpoints and keeps its loop', () => {"
        },
        {
          "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "line": 169,
          "text": "it('rejects stop-first advice even when a later bounded await succeeds', () => {"
        }
      ],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [
        "Replace unrelated fleet-scope downgrade recovery fixture with the actual maintained S41 behavior-instrument test; retain production admission unit file."
      ],
      "disposition": "PROPOSED_CHILD_EVIDENCE_BRIDGE",
      "remaining": [
        "Completed child evidence is a proposed bridge only. It has not been bound or graded against a newly registered parent supplement. No current serving PID or live event delivery is claimed."
      ],
      "childEvidenceBridge": {
        "items": [
          "P-008"
        ],
        "evidencePlane": "tree",
        "itemLocalClauses": [
          "S41-FINISHED-STOP",
          "S41-BOUNDED-DEPENDENCY",
          "S41-MISSING-EVENT"
        ],
        "cards": [
          "EI-26242152392812789",
          "EI-26242143536635296",
          "EI-26242170721687420"
        ],
        "rationale": "Finished work exercises legitimate stop. Retained blocked and missing-event worlds exercise preservation rather than unconditional stop. The committed admission suite covers nine wind-down branches. These are completed hermetic observations; no live loop delivery is claimed."
      }
    },
    {
      "draftId": "F98-20B",
      "proposedBarId": "R-33",
      "originalObligation": "R-8",
      "planItems": [
        "P-008"
      ],
      "sourceDecisions": [],
      "proposedRequirement": {
        "intent": {
          "request": "Rendered fleet-scope-admission guidance directs a partially blocked agent to continue its independent work.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20"
          ]
        },
        "acceptance": {
          "condition": "Rendered fleet-scope-admission guidance directs a partially blocked agent to continue its independent work.",
          "falsifier": "A partial blocker makes the rendered guidance direct whole-task parking before independent work is exhausted.",
          "evidencePlane": "tree",
          "requiredScope": [
            "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
          ],
          "requiredTestLayers": [
            "unit",
            "llm"
          ]
        },
        "verification": {
          "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Reuse the exact completed hermetic unit/LLM/mutation recipes and independently audited item-local S41 clauses in WI-6554700010015848; keep their immutable original failures/caps/retractions. Require a separately qualified parent binding rather than treating a child close as parent acceptance. Controls: independent step remains; all remaining steps genuinely blocked control; maintained su LLM receipt.",
          "check": {
            "kind": "tests",
            "files": [
              "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ]
          }
        }
      },
      "locatedCaseRefs": [
        {
          "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "line": 111,
          "text": "it('calibration: finishes independent work before blocking and registering an exact bounded wake', () => {"
        },
        {
          "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "line": 164,
          "text": "it('still rejects awaiting an existing blocker before finishing independent work', () => {"
        }
      ],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [
        "Replace unrelated fleet-scope downgrade recovery fixture with the actual maintained S41 behavior-instrument test; retain production admission unit file."
      ],
      "disposition": "PROPOSED_CHILD_EVIDENCE_BRIDGE",
      "remaining": [
        "Completed child evidence is a proposed bridge only. It has not been bound or graded against a newly registered parent supplement. No current serving PID or live event delivery is claimed."
      ],
      "childEvidenceBridge": {
        "items": [
          "P-008"
        ],
        "evidencePlane": "tree",
        "itemLocalClauses": [
          "S41-INDEPENDENT-WORK"
        ],
        "cards": [
          "EI-26242161755267876"
        ],
        "rationale": "The original independent-work matrix records all three repeats; its assertion checks local work before the specific bounded dependency await in the same turn. Historical two-of-three failure remains preserved."
      }
    },
    {
      "draftId": "F98-20C",
      "proposedBarId": "R-34",
      "originalObligation": "R-8",
      "planItems": [
        "P-008"
      ],
      "sourceDecisions": [],
      "proposedRequirement": {
        "intent": {
          "request": "Rendered fleet-scope-admission guidance gives a fully blocked agent a bounded wake on its specific unblocking event.",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20"
          ]
        },
        "acceptance": {
          "condition": "Rendered fleet-scope-admission guidance gives a fully blocked agent a bounded wake on its specific unblocking event.",
          "falsifier": "The rendered advice uses an untimed generic watch, a self-deadlocking held-item done event, or no wake-on-timeout bound.",
          "evidencePlane": "tree",
          "requiredScope": [
            "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
          ],
          "requiredTestLayers": [
            "unit",
            "llm"
          ]
        },
        "verification": {
          "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall. Reuse the exact completed hermetic unit/LLM/mutation recipes and independently audited item-local S41 clauses in WI-6554700010015848; keep their immutable original failures/caps/retractions. Require a separately qualified parent binding rather than treating a child close as parent acceptance. Controls: record actual typed blocker; exact event key; on_timeout wake and bound; no held-item done self-deadlock; maintained su LLM receipt.",
          "check": {
            "kind": "tests",
            "files": [
              "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ]
          }
        }
      },
      "locatedCaseRefs": [
        {
          "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "line": 111,
          "text": "it('calibration: finishes independent work before blocking and registering an exact bounded wake', () => {"
        },
        {
          "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "line": 188,
          "text": "it('rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops', () => {"
        },
        {
          "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "line": 206,
          "text": "it('rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop', async () => {"
        }
      ],
      "locatedCaseRefsArePassingEvidence": false,
      "proposedChangesFromFire98": [
        "Replace unrelated fleet-scope downgrade recovery fixture with the actual maintained S41 behavior-instrument test; retain production admission unit file."
      ],
      "disposition": "PROPOSED_CHILD_EVIDENCE_BRIDGE",
      "remaining": [
        "Completed child evidence is a proposed bridge only. It has not been bound or graded against a newly registered parent supplement. No current serving PID or live event delivery is claimed."
      ],
      "childEvidenceBridge": {
        "items": [
          "P-008"
        ],
        "evidencePlane": "tree",
        "itemLocalClauses": [
          "S41-BOUNDED-DEPENDENCY",
          "S41-MISSING-EVENT"
        ],
        "cards": [
          "EI-26242143536635296",
          "EI-26242170721687420"
        ],
        "rationale": "Bounded recorded-dependency and absent-event worlds distinguish an exact bounded wake from fabricated blocker/event refs; actual mutation probes catch the wrong effects. A missing event retains the loop and checkpoint. No live event delivery or parent BAR coverage is inferred."
      }
    }
  ],
  "sourceInspection": [
    {
      "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
      "sha256": "247aaaaf5f403b1224810a398e858b7974b590cb5c03f2e9a65c7074c41d26bb",
      "headSha256": "247aaaaf5f403b1224810a398e858b7974b590cb5c03f2e9a65c7074c41d26bb",
      "workingEqualsHead": true
    },
    {
      "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
      "sha256": "7e795ea6d8515518508e392783977b71db25d0802474580fd383f6b9bbe3ab90",
      "headSha256": "7e795ea6d8515518508e392783977b71db25d0802474580fd383f6b9bbe3ab90",
      "workingEqualsHead": true
    },
    {
      "path": "packages/operator-core/lib/harness/routines/stalled-loops-guard.test.ts",
      "sha256": "b2d2a0ba178e9448fcd18ae6537cae1d2f8fb89f89342bbad6b7e152a7edccaf",
      "headSha256": "b2d2a0ba178e9448fcd18ae6537cae1d2f8fb89f89342bbad6b7e152a7edccaf",
      "workingEqualsHead": true
    },
    {
      "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
      "sha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
      "headSha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
      "workingEqualsHead": true
    },
    {
      "path": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
      "sha256": "7655c60b1641682af3b977217e1f440eca32908f240d471caa31b70c2df9a29c",
      "headSha256": "7655c60b1641682af3b977217e1f440eca32908f240d471caa31b70c2df9a29c",
      "workingEqualsHead": true
    },
    {
      "path": "packages/operator-core/lib/system-health/agent-strand-census.test.ts",
      "sha256": "527cdeb52b71928154c83496b5f427de77b3215631d03726c20f8df87c5f6d17",
      "headSha256": "527cdeb52b71928154c83496b5f427de77b3215631d03726c20f8df87c5f6d17",
      "workingEqualsHead": true
    },
    {
      "path": "packages/operator-core/lib/system-health/compute.ts",
      "sha256": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
      "headSha256": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
      "workingEqualsHead": true
    },
    {
      "path": "packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts",
      "sha256": "dc46dc6a13858427ef82ca6effa08be92f1787bfadc449490df07d0418844261",
      "headSha256": "dc46dc6a13858427ef82ca6effa08be92f1787bfadc449490df07d0418844261",
      "workingEqualsHead": true
    },
    {
      "path": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
      "sha256": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6",
      "headSha256": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6",
      "workingEqualsHead": true
    },
    {
      "path": "packages/operator-core/test/liveness-alarm-http-fixture.ts",
      "sha256": "33d7530f66c2e458767fba7ddf6bbd13019f7906bfec71866e693fe093064a9d",
      "headSha256": "33d7530f66c2e458767fba7ddf6bbd13019f7906bfec71866e693fe093064a9d",
      "workingEqualsHead": true
    }
  ],
  "coverage": {
    "population": [
      "F98-15A",
      "F98-15B",
      "F98-15C",
      "F98-15D",
      "F98-15E",
      "F98-16",
      "F98-17",
      "F98-18A",
      "F98-18B",
      "F98-18C",
      "F98-18D",
      "F98-18E",
      "F98-18F",
      "F98-19A",
      "F98-19B",
      "F98-19C",
      "F98-19D",
      "F98-20A",
      "F98-20B",
      "F98-20C"
    ],
    "checked": [
      "F98-15A",
      "F98-15B",
      "F98-15C",
      "F98-15D",
      "F98-15E",
      "F98-16",
      "F98-17",
      "F98-18A",
      "F98-18B",
      "F98-18C",
      "F98-18D",
      "F98-18E",
      "F98-18F",
      "F98-19A",
      "F98-19B",
      "F98-19C",
      "F98-19D",
      "F98-20A",
      "F98-20B",
      "F98-20C"
    ],
    "notChecked": [],
    "notApplicable": [],
    "residue": [
      "Outside-lineage construction review before any application.",
      "F98-16 baseline selector and F98-17 owner near-zero bound remain unresolved.",
      "Historical R13 eligibility/scope remains owner-pending; no historical source search resumed.",
      "R12 selected forward proof is pending; stranded/panel e2e coverage remains separate.",
      "P-004 auth-rotation causal hazard still needs source-backed disposition.",
      "R14 final all-fix runtime anchor and actual >=24h observation remain unstarted."
    ]
  },
  "boundaries": {
    "original14RequirementsUnchanged": true,
    "planModified": false,
    "rubricModified": false,
    "newParentBindings": false,
    "newGrades": false,
    "testsRun": false,
    "primaryChildReopened": false,
    "LIVE_GATE_OPS": false
  },
  "reviewQuestion": "Do the concrete twenty proposed Requirements and Design rows preserve the original intent, isolate observable outcomes, and keep unresolved input/live-proof gaps explicit? Identify semantic narrowing or a missing control; do not grant parent acceptance from a completed child."
}
