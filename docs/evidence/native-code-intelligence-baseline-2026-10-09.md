# Native code-intelligence baseline — P-001

Plan: native-code-intelligence-ecosystem-and-dream-2026-10-09. Work item: WI-10007864.
Captured: 2026-10-09T18:29:31.019673+00:00. Machine evidence: docs/evidence/native-code-intelligence-baseline-2026-10-09.json.

The baseline is the current staging source, pinned by individual SHA-256 hashes in the JSON companion. HEAD at capture (4cbb674b8571ea3560c2b8630efe4f157c6bbde2) is context; it does not prove uncommitted source identity. No whole-plan or shipment verdict is claimed.

## Existing routes

| Surface | Current implementation | Boundary |
| --- | --- | --- |
| graph:query callers | First-party TypeScript call hierarchy, in a per-question worker, with labelled unresolved calls | Current JS/TS source; does not certify runtime execution or whole-source completeness |
| graph:query symbol/callees/impact/health | GitNexus facade and index | Index-dependent; per-answer health, freshness and coverage remain required |
| lsp:query | Existing shared daemon, language specs and server-identity/intent capability store | JS/TS and Rust declared; Python/Go unsupported in the present adapter; declarations are not intent certification |
| code:pack | Existing packer facade for pack/diff | Context selection does not prove graph relations |
| dependency snapshot | Both existing GitNexus and source-derived --first-party producer | First-party output is a sibling file; the current reindex action still passes --gitnexus-bin. Producer availability does not prove selector cutover |

The baseline reuses CodeIntelAnswer, graph:query, lsp:query, code:pack, the language-service lifecycle, capability cells, graph snapshot format, fair-comparison runner and arm admission registry. It creates no parallel table, service or tool.

## Distribution and internal-use decision register

Installed package metadata reports GitNexus 1.6.9 and candidate 1.6.12 as PolyForm-Noncommercial-1.0.0. The installed typescript-language-server 6.0.0 and @typescript/typescript6 6.0.2 report Apache-2.0. Package bytes are pinned in the companion; these are installed metadata observations, not fresh upstream or legal determinations.

Existing gitnexus-deterministic-integration-2026-10-05 D-004 excludes GitNexus from shipped surfaces, lockfiles and installers. D-005 records the existing internal route; this baseline grants no broader permission. The comparison admission record leaves GitNexus telemetry unverified and requires offline-only comparison. Other candidates retain the registry's licence pins and telemetry-off environment. Their comparison admission is not distribution approval.

The existing admitArm helper now accepts an explicit distribution purpose. It refuses the noncommercial incumbent exception for that purpose, and requires a separate approved distribution decision with an evidence reference for other engines. Missing distribution review stays unreviewed. Existing comparison behavior is preserved. Integration and installer callers must opt into this purpose as their relevant plan items are implemented; this helper change alone does not prove every distribution path is wired.

D-026 is a historical first-party selection input, not permission to claim every topology route replaced or retire the GitNexus routine. The existing P-012 keep/narrow/scale-back decision remains separate.

## Existing follow-ups and evidence

WI-10006543 reads blocked and retains its original deployed-route/anchoring work. WI-10006809 reads done; its source-derived producer is present. WI-10007660 reads done; the cost-label correction is settled. Existing P-012 and P-018 read todo; neither is closed by this baseline. P-018 specifically requires deployed routine history and an actual gate run. No peer lane was taken over.

A dev:pipeline_position read for query.ts at 18:23:55Z reported the changed path present on staging build ad00f10153 and absent on release build d740fc3802. It also returned bg-host/gateway containment, recorded in JSON. This is a path-containment snapshot, not a behavioral request or final shipment proof.

Tests: the project's Vitest command ran native-ecosystem.test.ts and fair-comparison-admission.test.ts, with 2 files and 15 tests passing. The new negative controls exercise distribution denial, mislabelled incumbent approval, absent/empty approval evidence and preservation of licence/telemetry checks. Existing graph facade, callers, LSP and snapshot suites are source-pinned scope references; no new claim of running their full matrix is made.

## Remaining scope

All 32 plan items remain governed by the approved roadmap. P-002 must freeze the expanded multilingual evaluation before adapters or tuning are judged. P-003 extends the evidence contract; P-004 onward implements the native ecosystem and Dream integrations. Final acceptance, independent grading and exact release evidence remain required. This baseline does not claim those outcomes.
