---
rel_path: "security/acceptance-methods-detector-gaps-20261106T0048Z.json"
updated_at: 1793925877153
_body: "content"
---

{
  "schemaVersion": 1,
  "status": "DRAFT_NOT_APPLIED_NOT_VETTED_NOT_ACCEPTANCE",
  "subject": {
    "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
    "harness": "papercusp",
    "immutableRevision": 41,
    "revisionId": 84496,
    "snapshotSha256": "8ad52fe3c10ca55ecca0e9b5d79f2e075832d5b521d0bd4d995f1b399351cc40",
    "mutableCasBaseline": 38
  },
  "rubric": {
    "ref": "acceptance-app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
    "baselineRevision": 2,
    "criteriaHash": "8e3efcbcdf0805ceccfc97364dd61935bac59103a21ed06ab9cf5d3181e2a2bd",
    "preserve": "All16 original models/BARs, distinct detectors, evidence planes, D-007..D-010 and final P-020 signed-installed holds; no meaning relaxation."
  },
  "reviewRefs": [
    "thread-post:1214636",
    "thread-post:1214656",
    "thread-post:1214662"
  ],
  "reuse": "Extend existing security-manifest/security-qualification/testing:run custody, existing policy/fetch/release suites. No parallel population ledger or speculative 16-file scaffold. Shared custody is necessary but never a substitute for each BAR's runtime detector.",
  "criteria": [
    {
      "key": "r-1",
      "method": "Consume the SAME immutable manifest and tuple-ledger revision from Design 'Security population and proof contract (version 2)', with stable row IDs over actual distribution/install profile x platform x runtime x enforcement mode x entry point/effect/channel. Reconcile the criterion-specific slice in BOTH directions against independently derived P-001 sources. Independently authenticated outside-lineage applicability review, separate from manifest/ledger producer and executor, must be immutably committed with host-owned ordering BEFORE any qualification test/control/canary/mutation result is observed. Partition every applicable slice row exactly once as checked, notChecked or source-justified notApplicable and retain explicitly owned residue. Each checked row needs its OWN authorized positive control, distinct forbidden-effect canary, named detector/observation, killed mutant mapping where relevant, and exact source/test/fixture/loaded-runtime digests. Missing, unknown, omitted, duplicate, merged, late/backdated, altered, unjustified N/A, mismatched-pin or cross-row generic proof FAILS; unknown is never N/A. Genuine source/runtime/population change requires a new ledger, independent pre-execution commitment and affected requalification. Include native macOS 10.15 and actual maintained platform/distribution profiles explicitly; unresolved applicability blocks unqualified rollout. Preserve voice, streams, integrations and permitted collaboration in the relevant normal-journey slice. Evidence plane tree means executed isolated CURRENT-BUILD/runtime effects and controls on the applicable supported rows, not source inspection or aggregate suite green. Current-build acceptance does not wait for production deployment under D-009/D-010. Independently remove declaration, installation grant, caller scope and resource/exact-action approval and substitute invocation identity; observe forbidden effect absent for EACH missing intersection input, with permitted intersection control. R-1 owns effective-authority computation; R-3's typed/nested transport proof does not substitute for it.",
      "candidateExistingPaths": [
        "packages/operator-core/lib/plugin-invocation-policy.test.ts",
        "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts"
      ],
      "pathsAreAcceptanceBindings": false,
      "detectorGap": "Production exported-path positive/negative/restored effects now exist for eleven selected fixture axes. Full independently frozen row slice, concrete resource normalizations, operation classes, other transports/platforms, exact loaded-runtime pins and per-row mutants remain unbound. No acceptance binding. Four isolated injected-reader refusal cases now have fresh positive/refusal/restored filesystem controls; these remain local development proof and do not resolve the listed qualification gaps.",
      "detectorMapping": {
        "kind": "inspected-scope-not-qualification-row-ledger",
        "qualificationRowIds": null,
        "independentPreExecutionCommitment": null,
        "profile": {
          "environment": "local Node/Vitest isolated PG",
          "installation": "fixture plugin/global metadata injected",
          "caller": "fixture system/bearer-token",
          "operation": "fixture:write",
          "effect": "checked service writes temporary filesystem marker",
          "confinement": "not established by this suite",
          "platformsQualified": [],
          "normalJourneysQualified": []
        },
        "currentProductionCases": [
          {
            "caseKey": "r1-production-intersection:manifest",
            "file": "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts",
            "selector": "production signed plugin invocation policy intersects the production manifest axis before the checked effect",
            "perturbation": "Loaded installation manifest omits tasks:write; installed grant, tool declaration, caller and signed exact approval remain.",
            "positive": "Exported pluginInvocationChokepoint + real signed HivePolicy/isolated PG writes marker with authorized bytes.",
            "negative": "Dispatcher refusal/error AND marker absence after removing prior positive marker.",
            "restored": "Restore only fixture authority inputs, dispatch production again; marker contains authorized bytes.",
            "acceptanceRowBindings": "unknown",
            "mutantForThisCase": "not measured"
          },
          {
            "caseKey": "r1-production-intersection:declaration",
            "file": "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts",
            "selector": "production signed plugin invocation policy intersects the production declaration axis before the checked effect",
            "perturbation": "Registered tool capabilities omit tasks:write; loaded manifest, grant, caller and approval remain.",
            "positive": "Exported pluginInvocationChokepoint + real signed HivePolicy/isolated PG writes marker with authorized bytes.",
            "negative": "Dispatcher refusal/error AND marker absence after removing prior positive marker.",
            "restored": "Restore only fixture authority inputs, dispatch production again; marker contains authorized bytes.",
            "acceptanceRowBindings": "unknown",
            "mutantForThisCase": "not measured"
          },
          {
            "caseKey": "r1-production-intersection:grant",
            "file": "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts",
            "selector": "production signed plugin invocation policy intersects the production grant axis before the checked effect",
            "perturbation": "Delete authoritative PG installation capability grant; signed approval and other axes remain.",
            "positive": "Exported pluginInvocationChokepoint + real signed HivePolicy/isolated PG writes marker with authorized bytes.",
            "negative": "Dispatcher refusal/error AND marker absence after removing prior positive marker.",
            "restored": "Restore only fixture authority inputs, dispatch production again; marker contains authorized bytes.",
            "acceptanceRowBindings": "unknown",
            "mutantForThisCase": "not measured"
          },
          {
            "caseKey": "r1-production-intersection:caller",
            "file": "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts",
            "selector": "production signed plugin invocation policy intersects the production caller axis before the checked effect",
            "perturbation": "Authenticated principal has an empty capability set.",
            "positive": "Exported pluginInvocationChokepoint + real signed HivePolicy/isolated PG writes marker with authorized bytes.",
            "negative": "Dispatcher refusal/error AND marker absence after removing prior positive marker.",
            "restored": "Restore only fixture authority inputs, dispatch production again; marker contains authorized bytes.",
            "acceptanceRowBindings": "unknown",
            "mutantForThisCase": "not measured"
          },
          {
            "caseKey": "r1-production-intersection:allowlist",
            "file": "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts",
            "selector": "production signed plugin invocation policy intersects the production allowlist axis before the checked effect",
            "perturbation": "Authenticated principal exact tool allowlist is an empty set.",
            "positive": "Exported pluginInvocationChokepoint + real signed HivePolicy/isolated PG writes marker with authorized bytes.",
            "negative": "Dispatcher refusal/error AND marker absence after removing prior positive marker.",
            "restored": "Restore only fixture authority inputs, dispatch production again; marker contains authorized bytes.",
            "acceptanceRowBindings": "unknown",
            "mutantForThisCase": "not measured"
          },
          {
            "caseKey": "r1-production-intersection:approval",
            "file": "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts",
            "selector": "production signed plugin invocation policy intersects the production approval axis before the checked effect",
            "perturbation": "Validly signed HivePolicy contains no matching operation approval.",
            "positive": "Exported pluginInvocationChokepoint + real signed HivePolicy/isolated PG writes marker with authorized bytes.",
            "negative": "Dispatcher refusal/error AND marker absence after removing prior positive marker.",
            "restored": "Restore only fixture authority inputs, dispatch production again; marker contains authorized bytes.",
            "acceptanceRowBindings": "unknown",
            "mutantForThisCase": "not measured"
          },
          {
            "caseKey": "r1-production-intersection:approval-capability",
            "file": "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts",
            "selector": "production signed plugin invocation policy intersects the production approval-capability axis before the checked effect",
            "perturbation": "Exact signed operation approval grants tasks:read while the checked marker effect requires tasks:write.",
            "positive": "Exported pluginInvocationChokepoint + real signed HivePolicy/isolated PG writes marker with authorized bytes.",
            "negative": "Dispatcher refusal/error AND marker absence after removing prior positive marker.",
            "restored": "Restore only fixture authority inputs, dispatch production again; marker contains authorized bytes.",
            "acceptanceRowBindings": "unknown",
            "mutantForThisCase": "not measured"
          },
          {
            "caseKey": "r1-production-intersection:identity",
            "file": "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts",
            "selector": "production signed plugin invocation policy intersects the production identity axis before the checked effect",
            "perturbation": "Principal slug differs from the signed caller.",
            "positive": "Exported pluginInvocationChokepoint + real signed HivePolicy/isolated PG writes marker with authorized bytes.",
            "negative": "Dispatcher refusal/error AND marker absence after removing prior positive marker.",
            "restored": "Restore only fixture authority inputs, dispatch production again; marker contains authorized bytes.",
            "acceptanceRowBindings": "unknown",
            "mutantForThisCase": "not measured"
          },
          {
            "caseKey": "r1-production-intersection:authentication",
            "file": "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts",
            "selector": "production signed plugin invocation policy intersects the production authentication axis before the checked effect",
            "perturbation": "Principal authMethod differs from the signed bearer-token identity.",
            "positive": "Exported pluginInvocationChokepoint + real signed HivePolicy/isolated PG writes marker with authorized bytes.",
            "negative": "Dispatcher refusal/error AND marker absence after removing prior positive marker.",
            "restored": "Restore only fixture authority inputs, dispatch production again; marker contains authorized bytes.",
            "acceptanceRowBindings": "unknown",
            "mutantForThisCase": "not measured"
          },
          {
            "caseKey": "r1-production-intersection:trust",
            "file": "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts",
            "selector": "production signed plugin invocation policy intersects the production trust axis before the checked effect",
            "perturbation": "Principal provenance is unverified-loopback.",
            "positive": "Exported pluginInvocationChokepoint + real signed HivePolicy/isolated PG writes marker with authorized bytes.",
            "negative": "Dispatcher refusal/error AND marker absence after removing prior positive marker.",
            "restored": "Restore only fixture authority inputs, dispatch production again; marker contains authorized bytes.",
            "acceptanceRowBindings": "unknown",
            "mutantForThisCase": "not measured"
          },
          {
            "caseKey": "r1-production-intersection:workspace",
            "file": "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts",
            "selector": "production signed plugin invocation policy intersects the production workspace axis before the checked effect",
            "perturbation": "Host context workspace differs from the unchanged authenticated principal workspace.",
            "positive": "Exported pluginInvocationChokepoint + real signed HivePolicy/isolated PG writes marker with authorized bytes.",
            "negative": "Dispatcher refusal/error AND marker absence after removing prior positive marker.",
            "restored": "Restore only fixture authority inputs, dispatch production again; marker contains authorized bytes.",
            "acceptanceRowBindings": "unknown",
            "mutantForThisCase": "not measured"
          }
        ],
        "otherInspectedAssertions": [
          {
            "file": "packages/operator-core/lib/plugin-invocation-policy.test.ts",
            "selector": "denies a missing %s axis before the actual effect",
            "variants": [
              "installation",
              "caller",
              "declaration",
              "approval"
            ],
            "observation": "Refusal/error and marker absence; positive is separate test, not paired inside each variant.",
            "limitations": "Injected PDP, manifest reader and grant reader; declaration variant changes tool declaration, not loaded manifest."
          },
          {
            "file": "packages/operator-core/lib/plugin-invocation-policy.test.ts",
            "selector": "does not turn caller arguments or a plugin authorizer allow into host approval",
            "observation": "No host policy bound: forged invocation/bypass arguments and plugin authorize allow cannot produce marker."
          },
          {
            "file": "packages/operator-core/lib/plugin-invocation-policy.test.ts",
            "selector": "refuses a binding copied from another invocation and wildcard resource approvals",
            "observation": "Other-invocation binding refused; independently restored policy then tasks:* approval refused; no marker."
          },
          {
            "file": "packages/plugin-loader/src/capabilities.test.ts",
            "selector": "denies before a filesystem effect when the ${axis} grant is missing",
            "variants": [
              "manifest",
              "declaration",
              "installation",
              "caller",
              "tool",
              "approval"
            ],
            "observation": "Checked service throws MissingCapabilityError and marker absent, including forged argument authority.",
            "limitations": "Host-created context unit fixture; no PG/transport/loader proof."
          },
          {
            "file": "packages/plugin-loader/src/capabilities.test.ts",
            "selector": "requires an exact tool allowlist, including when it is absent",
            "variants": [
              "undefined",
              "fixture:*",
              "fixture:child"
            ],
            "observation": "Each separately built context refuses fixture:parent filesystem effect."
          },
          {
            "file": "packages/plugin-loader/src/capabilities.test.ts",
            "selector": "keeps resource approvals independent of broader declarations and caller grants",
            "observation": "Fixture secret PUBLIC service called; PRIVATE service denied; reads array contains PUBLIC only.",
            "limitations": "Substituted secrets service returns fixture string; no real secret confinement."
          },
          {
            "file": "packages/operator-core/lib/plugin-invocation-policy.test.ts",
            "selector": "isolates %s refusal between authorized filesystem effects",
            "variant": "grant-read",
            "observation": "Each fresh fixture: authorized marker write; remove marker; perturb exactly one input; require refusal and marker absence; restore original authority; authorized marker write.",
            "limitations": "Injected host PDP/manifest/grant readers, local checked filesystem effects. No transport, confinement, independently frozen qualification row or full import-closure claim.",
            "developmentProofRef": "security/p002-isolated-refusals-and-p003-preparation-20261106.json",
            "acceptanceRowBindings": "unknown",
            "mutantForThisCase": "not measured"
          },
          {
            "file": "packages/operator-core/lib/plugin-invocation-policy.test.ts",
            "selector": "isolates %s refusal between authorized filesystem effects",
            "variant": "allowlist",
            "observation": "Each fresh fixture: authorized marker write; remove marker; perturb exactly one input; require refusal and marker absence; restore original authority; authorized marker write.",
            "limitations": "Injected host PDP/manifest/grant readers, local checked filesystem effects. No transport, confinement, independently frozen qualification row or full import-closure claim.",
            "developmentProofRef": "security/p002-isolated-refusals-and-p003-preparation-20261106.json",
            "acceptanceRowBindings": "unknown",
            "mutantForThisCase": "not measured"
          },
          {
            "file": "packages/operator-core/lib/plugin-invocation-policy.test.ts",
            "selector": "isolates %s refusal between authorized filesystem effects",
            "variant": "expiry",
            "observation": "Each fresh fixture: authorized marker write; remove marker; perturb exactly one input; require refusal and marker absence; restore original authority; authorized marker write.",
            "limitations": "Injected host PDP/manifest/grant readers, local checked filesystem effects. No transport, confinement, independently frozen qualification row or full import-closure claim.",
            "developmentProofRef": "security/p002-isolated-refusals-and-p003-preparation-20261106.json",
            "acceptanceRowBindings": "unknown",
            "mutantForThisCase": "not measured"
          },
          {
            "file": "packages/operator-core/lib/plugin-invocation-policy.test.ts",
            "selector": "isolates %s refusal between authorized filesystem effects",
            "variant": "policy-read",
            "observation": "Each fresh fixture: authorized marker write; remove marker; perturb exactly one input; require refusal and marker absence; restore original authority; authorized marker write.",
            "limitations": "Injected host PDP/manifest/grant readers, local checked filesystem effects. No transport, confinement, independently frozen qualification row or full import-closure claim.",
            "developmentProofRef": "security/p002-isolated-refusals-and-p003-preparation-20261106.json",
            "acceptanceRowBindings": "unknown",
            "mutantForThisCase": "not measured"
          }
        ],
        "unmapped": [
          "Independently reconciled complete tuple population and immutable outside-lineage pre-result applicability",
          "Concrete normalized resource/destination/action classes beyond fixture tools",
          "Installation/profile/platform/runtime/transport complete slices including native10.15",
          "Packaged loader, OS confinement, real transport authentication and live loaded-runtime provenance",
          "Every acceptance row unique positive/negative/detector/mutant and exact source closure"
        ],
        "supersededCombinedCase": {
          "file": "packages/operator-core/lib/plugin-invocation-policy.test.ts",
          "selector": "fails closed on grant read failure, missing exact allowlist, expiry or current-policy read failure",
          "observation": "Refusal on combined sequential fixture states.",
          "limitations": "Final absent-allowlist assertion retains throwing isCurrent, so cannot by itself isolate absent-allowlist enforcement.",
          "supersededBy": [
            "grant-read",
            "allowlist",
            "expiry",
            "policy-read"
          ],
          "reason": "Maintained test now starts a fresh authorized fixture per refusal axis; the old retained throwing isCurrent masking limitation no longer describes this test source."
        }
      }
    },
    {
      "key": "r-2",
      "method": "Consume the SAME immutable manifest and tuple-ledger revision from Design 'Security population and proof contract (version 2)', with stable row IDs over actual distribution/install profile x platform x runtime x enforcement mode x entry point/effect/channel. Reconcile the criterion-specific slice in BOTH directions against independently derived P-001 sources. Independently authenticated outside-lineage applicability review, separate from manifest/ledger producer and executor, must be immutably committed with host-owned ordering BEFORE any qualification test/control/canary/mutation result is observed. Partition every applicable slice row exactly once as checked, notChecked or source-justified notApplicable and retain explicitly owned residue. Each checked row needs its OWN authorized positive control, distinct forbidden-effect canary, named detector/observation, killed mutant mapping where relevant, and exact source/test/fixture/loaded-runtime digests. Missing, unknown, omitted, duplicate, merged, late/backdated, altered, unjustified N/A, mismatched-pin or cross-row generic proof FAILS; unknown is never N/A. Genuine source/runtime/population change requires a new ledger, independent pre-execution commitment and affected requalification. Include native macOS 10.15 and actual maintained platform/distribution profiles explicitly; unresolved applicability blocks unqualified rollout. Preserve voice, streams, integrations and permitted collaboration in the relevant normal-journey slice. Evidence plane tree means executed isolated CURRENT-BUILD/runtime effects and controls on the applicable supported rows, not source inspection or aggregate suite green. Current-build acceptance does not wait for production deployment under D-009/D-010. For EACH direct/transitive loader class (preloads, module initialization, native constructors, dynamic imports, worker/bootstrap and interpreter startup), fail confinement setup before its first untrusted byte. Observe no load/effect sentinel before confinement and raw exec/files/socket/network denial under real OS facilities; include post-confinement permitted effects and unavailable-facility refusal. R-2 owns pre-load confinement and fallback, independently of R-4's identity/material boundary.",
      "candidateExistingPaths": [
        "packages/operator-core/lib/agent-tools/capability/exec-sandbox.integration.test.ts"
      ],
      "pathsAreAcceptanceBindings": false,
      "detectorGap": "Existing exec sandbox suite explicitly permits some missing-credential paths and is not a full handler pre-load detector. Need maintained per-runtime/platform earliest-load/fail-closed cases; do not bind existing sandbox green as full R-2.",
      "sourcePreparation": {
        "workItem": "WI-6554700010044292",
        "claim": "self",
        "state": "blocked",
        "needsDesign": true,
        "sourceCheckpoint": "7651b8bc1481",
        "sources": [
          "libs/generic/plugin-loader/src/loader.ts",
          "packages/plugin-loader/src/index.ts",
          "packages/plugin-loader/src/daemon/supervisor.ts",
          "packages/plugin-loader/src/daemon/bwrap-args.ts",
          "packages/operator-core/lib/plugin-host-runtime.ts"
        ],
        "facts": [
          "Generic admission precedes runtimeDispatch and entry import; reuse these ports.",
          "Ordinary JS import uses in-host createRequire.",
          "Provider mode always spawns via fixed bwrap even after an inconclusive probe; completed probe failure refuses.",
          "Legacy ordinary daemon mode has plain-spawn fallback.",
          "initializeDaemonPlugin does not select provider mode for ordinary action daemons."
        ],
        "notMeasured": [
          "All-runtime/platform earliest-load containment",
          "Raw direct/transitive file/socket/network/exec effects",
          "Typed broker migration and normal journeys",
          "Independent frozen row population/controls/mutants",
          "Actual native macOS10.15"
        ],
        "next": "Required P003 design using existing loader and provider/supervisor seams; P002 prerequisite remains open."
      }
    },
    {
      "key": "r-3",
      "method": "Consume the SAME immutable manifest and tuple-ledger revision from Design 'Security population and proof contract (version 2)', with stable row IDs over actual distribution/install profile x platform x runtime x enforcement mode x entry point/effect/channel. Reconcile the criterion-specific slice in BOTH directions against independently derived P-001 sources. Independently authenticated outside-lineage applicability review, separate from manifest/ledger producer and executor, must be immutably committed with host-owned ordering BEFORE any qualification test/control/canary/mutation result is observed. Partition every applicable slice row exactly once as checked, notChecked or source-justified notApplicable and retain explicitly owned residue. Each checked row needs its OWN authorized positive control, distinct forbidden-effect canary, named detector/observation, killed mutant mapping where relevant, and exact source/test/fixture/loaded-runtime digests. Missing, unknown, omitted, duplicate, merged, late/backdated, altered, unjustified N/A, mismatched-pin or cross-row generic proof FAILS; unknown is never N/A. Genuine source/runtime/population change requires a new ledger, independent pre-execution commitment and affected requalification. Include native macOS 10.15 and actual maintained platform/distribution profiles explicitly; unresolved applicability blocks unqualified rollout. Preserve voice, streams, integrations and permitted collaboration in the relevant normal-journey slice. Evidence plane tree means executed isolated CURRENT-BUILD/runtime effects and controls on the applicable supported rows, not source inspection or aggregate suite green. Current-build acceptance does not wait for production deployment under D-009/D-010. Observe authorized typed backup comparison without arbitrary Bash authority, declared/granted explicit-shell positive control, and denial of argument/operation/resource/context substitution across every typed broker and nested tool entry. Revalidate host-derived caller/workspace/channel/invocation, normalized resource, argument digest, nonce/freshness, cancellation and revocation immediately before effect. R-3 owns typed routing/nested preservation, with distinct observations from R-1's policy intersection.",
      "candidateExistingPaths": [
        "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts"
      ],
      "pathsAreAcceptanceBindings": false,
      "detectorGap": "Nested attenuation fixtures exist; typed backup service, bound IPC replay and alternate-entry full row coverage need detector implementation/mapping.",
      "detectorMapping": {
        "kind": "inspected-scope-not-qualification-row-ledger",
        "qualificationRowIds": null,
        "productionNestedCases": [
          {
            "caseKey": "r3-production-parent-attenuation:declaration",
            "file": "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts",
            "selector": "production signed plugin invocation policy attenuates a separately signed production child by its parent declaration across awaits",
            "positive": "Broader signed parent invokes separately signed child across awaits; child tasks:read marker written.",
            "isolationControl": "After narrowing parent or substituting independently approved child identity, standalone child still writes its marker.",
            "negative": "Same child nested under restricted parent refuses and marker absent.",
            "scope": "Same fixture loaded installation and isolated PG; both invocations call exported production chokepoint. No actual IPC or typed backup service.",
            "mutantForThisCase": "not measured"
          },
          {
            "caseKey": "r3-production-parent-attenuation:caller",
            "file": "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts",
            "selector": "production signed plugin invocation policy attenuates a separately signed production child by its parent caller across awaits",
            "positive": "Broader signed parent invokes separately signed child across awaits; child tasks:read marker written.",
            "isolationControl": "After narrowing parent or substituting independently approved child identity, standalone child still writes its marker.",
            "negative": "Same child nested under restricted parent refuses and marker absent.",
            "scope": "Same fixture loaded installation and isolated PG; both invocations call exported production chokepoint. No actual IPC or typed backup service.",
            "mutantForThisCase": "not measured"
          },
          {
            "caseKey": "r3-production-parent-attenuation:approval",
            "file": "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts",
            "selector": "production signed plugin invocation policy attenuates a separately signed production child by its parent approval across awaits",
            "positive": "Broader signed parent invokes separately signed child across awaits; child tasks:read marker written.",
            "isolationControl": "After narrowing parent or substituting independently approved child identity, standalone child still writes its marker.",
            "negative": "Same child nested under restricted parent refuses and marker absent.",
            "scope": "Same fixture loaded installation and isolated PG; both invocations call exported production chokepoint. No actual IPC or typed backup service.",
            "mutantForThisCase": "not measured"
          },
          {
            "caseKey": "r3-production-parent-attenuation:allowlist",
            "file": "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts",
            "selector": "production signed plugin invocation policy attenuates a separately signed production child by its parent allowlist across awaits",
            "positive": "Broader signed parent invokes separately signed child across awaits; child tasks:read marker written.",
            "isolationControl": "After narrowing parent or substituting independently approved child identity, standalone child still writes its marker.",
            "negative": "Same child nested under restricted parent refuses and marker absent.",
            "scope": "Same fixture loaded installation and isolated PG; both invocations call exported production chokepoint. No actual IPC or typed backup service.",
            "mutantForThisCase": "not measured"
          },
          {
            "caseKey": "r3-production-parent-attenuation:identity",
            "file": "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts",
            "selector": "production signed plugin invocation policy attenuates a separately signed production child by its parent identity across awaits",
            "positive": "Broader signed parent invokes separately signed child across awaits; child tasks:read marker written.",
            "isolationControl": "After narrowing parent or substituting independently approved child identity, standalone child still writes its marker.",
            "negative": "Same child nested under restricted parent refuses and marker absent.",
            "scope": "Same fixture loaded installation and isolated PG; both invocations call exported production chokepoint. No actual IPC or typed backup service.",
            "mutantForThisCase": "not measured"
          }
        ],
        "additionalInspectedAssertions": [
          {
            "file": "packages/plugin-loader/src/capabilities.test.ts",
            "selector": "attenuates explicit children and rechecks parent revocation",
            "observation": "Child tasks:read positive; tasks:write denial and no marker; parent revoke denies saved child and prevents runWithInvocationCapabilities entry."
          },
          {
            "file": "packages/plugin-loader/src/capabilities.test.ts",
            "selector": "refuses a child that changes principal or workspace or supplies a forged parent",
            "observation": "Each override separately denies checked filesystem effect."
          },
          {
            "file": "packages/plugin-loader/src/capabilities.test.ts",
            "selector": "cannot omit its ambient parent, including after an await and after returning the child",
            "observation": "Returned child remains narrowed by ambient parent across await; write refused."
          },
          {
            "file": "packages/plugin-loader/src/capabilities.test.ts",
            "selector": "limits prebuilt and legacy child services inside asynchronous checked service calls",
            "observation": "Both prebuilt invocation context and legacy service checked under narrow ambient parent; write denied."
          },
          {
            "file": "packages/plugin-loader/src/capabilities.test.ts",
            "selector": "intersects the parent exact tool allowlist and isolates concurrent invocations",
            "observation": "Parallel narrow invocation denies marker; independent wide invocation writes its own marker."
          }
        ],
        "unmapped": [
          "Typed backup comparison without arbitrary shell authority and explicitly granted shell positive control",
          "Actual broker/IPC nested-entry population, operation/resource/context substitution",
          "Nonce/freshness/replay/cancel/revoke at each real typed effect",
          "Native10.15 and supported profile/runtime/effect/channel slices with independent precommitted row identities"
        ]
      }
    },
    {
      "key": "r-4",
      "method": "Consume the SAME immutable manifest and tuple-ledger revision from Design 'Security population and proof contract (version 2)', with stable row IDs over actual distribution/install profile x platform x runtime x enforcement mode x entry point/effect/channel. Reconcile the criterion-specific slice in BOTH directions against independently derived P-001 sources. Independently authenticated outside-lineage applicability review, separate from manifest/ledger producer and executor, must be immutably committed with host-owned ordering BEFORE any qualification test/control/canary/mutation result is observed. Partition every applicable slice row exactly once as checked, notChecked or source-justified notApplicable and retain explicitly owned residue. Each checked row needs its OWN authorized positive control, distinct forbidden-effect canary, named detector/observation, killed mutant mapping where relevant, and exact source/test/fixture/loaded-runtime digests. Missing, unknown, omitted, duplicate, merged, late/backdated, altered, unjustified N/A, mismatched-pin or cross-row generic proof FAILS; unknown is never N/A. Genuine source/runtime/population change requires a new ledger, independent pre-execution commitment and affected requalification. Include native macOS 10.15 and actual maintained platform/distribution profiles explicitly; unresolved applicability blocks unqualified rollout. Preserve voice, streams, integrations and permitted collaboration in the relevant normal-journey slice. Evidence plane tree means executed isolated CURRENT-BUILD/runtime effects and controls on the applicable supported rows, not source inspection or aggregate suite green. Current-build acceptance does not wait for production deployment under D-009/D-010. Under actual restricted identities, exercise protected files, process memory/environment, inherited descriptors, privileged sockets/tokens, live decryption/signing material and enforcement code/config writes. Observe canary unreadability and protected-write absence on each route; prove a narrowly trusted service can still perform its authorized operation. Include initial privileged-verifier/bootstrap isolation separately from a preinstalled verifier. Distinguish R-4 identity/material isolation from R-2 setup confinement.",
      "candidateExistingPaths": [],
      "pathsAreAcceptanceBindings": false,
      "detectorGap": "Real OS identity/material/bootstrap detectors for the complete frozen slice remain unbound."
    },
    {
      "key": "r-5",
      "method": "Consume the SAME immutable manifest and tuple-ledger revision from Design 'Security population and proof contract (version 2)', with stable row IDs over actual distribution/install profile x platform x runtime x enforcement mode x entry point/effect/channel. Reconcile the criterion-specific slice in BOTH directions against independently derived P-001 sources. Independently authenticated outside-lineage applicability review, separate from manifest/ledger producer and executor, must be immutably committed with host-owned ordering BEFORE any qualification test/control/canary/mutation result is observed. Partition every applicable slice row exactly once as checked, notChecked or source-justified notApplicable and retain explicitly owned residue. Each checked row needs its OWN authorized positive control, distinct forbidden-effect canary, named detector/observation, killed mutant mapping where relevant, and exact source/test/fixture/loaded-runtime digests. Missing, unknown, omitted, duplicate, merged, late/backdated, altered, unjustified N/A, mismatched-pin or cross-row generic proof FAILS; unknown is never N/A. Genuine source/runtime/population change requires a new ledger, independent pre-execution commitment and affected requalification. Include native macOS 10.15 and actual maintained platform/distribution profiles explicitly; unresolved applicability blocks unqualified rollout. Preserve voice, streams, integrations and permitted collaboration in the relevant normal-journey slice. Final evidence plane deployed belongs to P-020 on the EXACT signed installed artifact: bind artifact digest, loaded runtime and policy/config digests, authenticated separated human/agent/automation author and approver identities, reviewed revision, Apple signing/notarization/update trust where applicable, signer/trust-root identity and epoch, version, freshness, rollback counter, signed metadata, and SAME stable row IDs/manifest/ledger pins. Current-build tests are preparatory and cannot satisfy final installed proof. Missing initial privileged-verifier/bootstrap establishment or authenticated complete author sets remains OPEN and blocks final proof; an already installed verifier is not bootstrap evidence. For each promotion/install/update/rollback profile, demonstrate authorized exact-reviewed-artifact activation and deny post-review source/config/policy mutation, wrong/revoked signer, rotated/stale trust root, frozen/stale metadata, wrong policy digest, disallowed rollback and author/approver identity collapse. Authenticate EVERY human, agent and automation author/approver, including complete source provenance. Prove initial administrator bootstrap plus subsequent verifier updates under the intended trust root. Distinct R-5 observation is unauthorized activation absence; R-16 whole-population closure cannot substitute.",
      "candidateExistingPaths": [
        "packages/operator-core/lib/release/tauri-update-authorization-native.test.ts",
        "packages/operator-core/lib/release/updater-signature-and-loopback-transport.test.ts"
      ],
      "pathsAreAcceptanceBindings": false,
      "detectorGap": "Local fixture/native development evidence only. Authentic Apple Developer ID Application AND Installer, notarization, complete authenticated authors, bootstrap and exact installed artifact remain open; no final binding."
    },
    {
      "key": "r-6",
      "method": "Consume the SAME immutable manifest and tuple-ledger revision from Design 'Security population and proof contract (version 2)', with stable row IDs over actual distribution/install profile x platform x runtime x enforcement mode x entry point/effect/channel. Reconcile the criterion-specific slice in BOTH directions against independently derived P-001 sources. Independently authenticated outside-lineage applicability review, separate from manifest/ledger producer and executor, must be immutably committed with host-owned ordering BEFORE any qualification test/control/canary/mutation result is observed. Partition every applicable slice row exactly once as checked, notChecked or source-justified notApplicable and retain explicitly owned residue. Each checked row needs its OWN authorized positive control, distinct forbidden-effect canary, named detector/observation, killed mutant mapping where relevant, and exact source/test/fixture/loaded-runtime digests. Missing, unknown, omitted, duplicate, merged, late/backdated, altered, unjustified N/A, mismatched-pin or cross-row generic proof FAILS; unknown is never N/A. Genuine source/runtime/population change requires a new ledger, independent pre-execution commitment and affected requalification. Include native macOS 10.15 and actual maintained platform/distribution profiles explicitly; unresolved applicability blocks unqualified rollout. Preserve voice, streams, integrations and permitted collaboration in the relevant normal-journey slice. Evidence plane tree means executed isolated CURRENT-BUILD/runtime effects and controls on the applicable supported rows, not source inspection or aggregate suite green. Current-build acceptance does not wait for production deployment under D-009/D-010. Cross each actual HTTP/WebSocket/native IPC local/remote entry with hostile origins, unrelated localhost ports, forged Host/origin, foreign peers, unauthenticated mutation and cross-window/session/operation substitution. Observe protected API/native effect absence and intended authenticated app-origin/window/desktop/remote transport success; retain hosted UID and ingress protections. Include reconnect and live-session binding, not origin string comparisons alone.",
      "candidateExistingPaths": [],
      "pathsAreAcceptanceBindings": false,
      "detectorGap": "Full actual transport/native-window detector mapping remains unbound."
    },
    {
      "key": "r-7",
      "method": "Consume the SAME immutable manifest and tuple-ledger revision from Design 'Security population and proof contract (version 2)', with stable row IDs over actual distribution/install profile x platform x runtime x enforcement mode x entry point/effect/channel. Reconcile the criterion-specific slice in BOTH directions against independently derived P-001 sources. Independently authenticated outside-lineage applicability review, separate from manifest/ledger producer and executor, must be immutably committed with host-owned ordering BEFORE any qualification test/control/canary/mutation result is observed. Partition every applicable slice row exactly once as checked, notChecked or source-justified notApplicable and retain explicitly owned residue. Each checked row needs its OWN authorized positive control, distinct forbidden-effect canary, named detector/observation, killed mutant mapping where relevant, and exact source/test/fixture/loaded-runtime digests. Missing, unknown, omitted, duplicate, merged, late/backdated, altered, unjustified N/A, mismatched-pin or cross-row generic proof FAILS; unknown is never N/A. Genuine source/runtime/population change requires a new ledger, independent pre-execution commitment and affected requalification. Include native macOS 10.15 and actual maintained platform/distribution profiles explicitly; unresolved applicability blocks unqualified rollout. Preserve voice, streams, integrations and permitted collaboration in the relevant normal-journey slice. Evidence plane tree means executed isolated CURRENT-BUILD/runtime effects and controls on the applicable supported rows, not source inspection or aggregate suite green. Current-build acceptance does not wait for production deployment under D-009/D-010. For EVERY credential audience/workspace/operation and established connection, queued/nested/background job stage, expire or revoke at a barrier BETWEEN admission and next protected effect. Observe next-effect absence and reconnect rejection with permitted owner/admin controls; include deterministic-clock boundary and real connection/job effects. Token parse or issuance tests alone do not discharge revocation.",
      "candidateExistingPaths": [],
      "pathsAreAcceptanceBindings": false,
      "detectorGap": "Scoped revocation before each protected effect and job/connection row detectors remain unbound."
    },
    {
      "key": "r-8",
      "method": "Consume the SAME immutable manifest and tuple-ledger revision from Design 'Security population and proof contract (version 2)', with stable row IDs over actual distribution/install profile x platform x runtime x enforcement mode x entry point/effect/channel. Reconcile the criterion-specific slice in BOTH directions against independently derived P-001 sources. Independently authenticated outside-lineage applicability review, separate from manifest/ledger producer and executor, must be immutably committed with host-owned ordering BEFORE any qualification test/control/canary/mutation result is observed. Partition every applicable slice row exactly once as checked, notChecked or source-justified notApplicable and retain explicitly owned residue. Each checked row needs its OWN authorized positive control, distinct forbidden-effect canary, named detector/observation, killed mutant mapping where relevant, and exact source/test/fixture/loaded-runtime digests. Missing, unknown, omitted, duplicate, merged, late/backdated, altered, unjustified N/A, mismatched-pin or cross-row generic proof FAILS; unknown is never N/A. Genuine source/runtime/population change requires a new ledger, independent pre-execution commitment and affected requalification. Include native macOS 10.15 and actual maintained platform/distribution profiles explicitly; unresolved applicability blocks unqualified rollout. Preserve voice, streams, integrations and permitted collaboration in the relevant normal-journey slice. Evidence plane tree means executed isolated CURRENT-BUILD/runtime effects and controls on the applicable supported rows, not source inspection or aggregate suite green. Current-build acceptance does not wait for production deployment under D-009/D-010. Remove the ambiguous 'wherever supported' escape through explicit source-backed applicability: cover each provider/credential and sink (model input, logs, spill, scratch artifact, transcript, subprocess environment, backup and restore readers), including encoded output. Trace row-unique secret canaries; observe unauthorized visibility absence and a legitimate scoped service using the secret without returning it. Unsupported/unknown secret confinement stays explicit and blocks qualification.",
      "candidateExistingPaths": [],
      "pathsAreAcceptanceBindings": false,
      "detectorGap": "Per-sink/provider current-build canary and authorized-service detector mapping remains unbound."
    },
    {
      "key": "r-9",
      "method": "Consume the SAME immutable manifest and tuple-ledger revision from Design 'Security population and proof contract (version 2)', with stable row IDs over actual distribution/install profile x platform x runtime x enforcement mode x entry point/effect/channel. Reconcile the criterion-specific slice in BOTH directions against independently derived P-001 sources. Independently authenticated outside-lineage applicability review, separate from manifest/ledger producer and executor, must be immutably committed with host-owned ordering BEFORE any qualification test/control/canary/mutation result is observed. Partition every applicable slice row exactly once as checked, notChecked or source-justified notApplicable and retain explicitly owned residue. Each checked row needs its OWN authorized positive control, distinct forbidden-effect canary, named detector/observation, killed mutant mapping where relevant, and exact source/test/fixture/loaded-runtime digests. Missing, unknown, omitted, duplicate, merged, late/backdated, altered, unjustified N/A, mismatched-pin or cross-row generic proof FAILS; unknown is never N/A. Genuine source/runtime/population change requires a new ledger, independent pre-execution commitment and affected requalification. Include native macOS 10.15 and actual maintained platform/distribution profiles explicitly; unresolved applicability blocks unqualified rollout. Preserve voice, streams, integrations and permitted collaboration in the relevant normal-journey slice. Evidence plane tree means executed isolated CURRENT-BUILD/runtime effects and controls on the applicable supported rows, not source inspection or aggregate suite green. Current-build acceptance does not wait for production deployment under D-009/D-010. Define enforcing CSP from observed current-build headers/runtime for EVERY supported browser/desktop entry point and external report/plugin/model HTML view. Attempt scripts, forbidden destinations and native-command reachability; observe blocked execution/effects. Prove voice media/session control, SSE/WebSocket reconnect/backpressure/cancellation, OAuth state/PKCE/callback/custom-scheme, integration install/auth/event/action and intended-window IPC journeys across each applicable row. Report-only telemetry or a generic 'qualified CSP' label cannot pass.",
      "candidateExistingPaths": [],
      "pathsAreAcceptanceBindings": false,
      "detectorGap": "Real rendered malicious fixtures plus complete preserved-journey matrix need maintained detector mapping."
    },
    {
      "key": "r-10",
      "method": "Consume the SAME immutable manifest and tuple-ledger revision from Design 'Security population and proof contract (version 2)', with stable row IDs over actual distribution/install profile x platform x runtime x enforcement mode x entry point/effect/channel. Reconcile the criterion-specific slice in BOTH directions against independently derived P-001 sources. Independently authenticated outside-lineage applicability review, separate from manifest/ledger producer and executor, must be immutably committed with host-owned ordering BEFORE any qualification test/control/canary/mutation result is observed. Partition every applicable slice row exactly once as checked, notChecked or source-justified notApplicable and retain explicitly owned residue. Each checked row needs its OWN authorized positive control, distinct forbidden-effect canary, named detector/observation, killed mutant mapping where relevant, and exact source/test/fixture/loaded-runtime digests. Missing, unknown, omitted, duplicate, merged, late/backdated, altered, unjustified N/A, mismatched-pin or cross-row generic proof FAILS; unknown is never N/A. Genuine source/runtime/population change requires a new ledger, independent pre-execution commitment and affected requalification. Include native macOS 10.15 and actual maintained platform/distribution profiles explicitly; unresolved applicability blocks unqualified rollout. Preserve voice, streams, integrations and permitted collaboration in the relevant normal-journey slice. Evidence plane tree means executed isolated CURRENT-BUILD/runtime effects and controls on the applicable supported rows, not source inspection or aggregate suite green. Current-build acceptance does not wait for production deployment under D-009/D-010. Enumerate ALL outward-facing, destructive and privilege-changing action classes from the frozen effect inventory. Inject malicious external content through actual workflows; observe forbidden-effect absence regardless of model compliance. Mutate approval destination, normalized resource, operation, argument/content digest/version, scope, validity and authenticated approver, replay it across sessions/invocations and revoke before effect; each class needs its own valid exact-action control.",
      "candidateExistingPaths": [],
      "pathsAreAcceptanceBindings": false,
      "detectorGap": "Actual workflow/effect approval substitution and replay detector mapping remains unbound."
    },
    {
      "key": "r-11",
      "method": "Consume the SAME immutable manifest and tuple-ledger revision from Design 'Security population and proof contract (version 2)', with stable row IDs over actual distribution/install profile x platform x runtime x enforcement mode x entry point/effect/channel. Reconcile the criterion-specific slice in BOTH directions against independently derived P-001 sources. Independently authenticated outside-lineage applicability review, separate from manifest/ledger producer and executor, must be immutably committed with host-owned ordering BEFORE any qualification test/control/canary/mutation result is observed. Partition every applicable slice row exactly once as checked, notChecked or source-justified notApplicable and retain explicitly owned residue. Each checked row needs its OWN authorized positive control, distinct forbidden-effect canary, named detector/observation, killed mutant mapping where relevant, and exact source/test/fixture/loaded-runtime digests. Missing, unknown, omitted, duplicate, merged, late/backdated, altered, unjustified N/A, mismatched-pin or cross-row generic proof FAILS; unknown is never N/A. Genuine source/runtime/population change requires a new ledger, independent pre-execution commitment and affected requalification. Include native macOS 10.15 and actual maintained platform/distribution profiles explicitly; unresolved applicability blocks unqualified rollout. Preserve voice, streams, integrations and permitted collaboration in the relevant normal-journey slice. Evidence plane tree means executed isolated CURRENT-BUILD/runtime effects and controls on the applicable supported rows, not source inspection or aggregate suite green. Current-build acceptance does not wait for production deployment under D-009/D-010. Cross each workspace/object-sensitive tool, HTTP endpoint, WebSocket subscription, report/file/secret API, cache/export and background/nested job with two authenticated workspace/user fixtures. Substitute object/workspace IDs and reconnect/queued context; observe foreign data/mutation/subscription absence plus permitted collaboration controls. Server resolution must establish identity at each effect; handler-selected workspace is not authority.",
      "candidateExistingPaths": [],
      "pathsAreAcceptanceBindings": false,
      "detectorGap": "Full cross-protocol object and background-context detector mapping remains unbound."
    },
    {
      "key": "r-12",
      "method": "Consume the SAME immutable manifest and tuple-ledger revision from Design 'Security population and proof contract (version 2)', with stable row IDs over actual distribution/install profile x platform x runtime x enforcement mode x entry point/effect/channel. Reconcile the criterion-specific slice in BOTH directions against independently derived P-001 sources. Independently authenticated outside-lineage applicability review, separate from manifest/ledger producer and executor, must be immutably committed with host-owned ordering BEFORE any qualification test/control/canary/mutation result is observed. Partition every applicable slice row exactly once as checked, notChecked or source-justified notApplicable and retain explicitly owned residue. Each checked row needs its OWN authorized positive control, distinct forbidden-effect canary, named detector/observation, killed mutant mapping where relevant, and exact source/test/fixture/loaded-runtime digests. Missing, unknown, omitted, duplicate, merged, late/backdated, altered, unjustified N/A, mismatched-pin or cross-row generic proof FAILS; unknown is never N/A. Genuine source/runtime/population change requires a new ledger, independent pre-execution commitment and affected requalification. Include native macOS 10.15 and actual maintained platform/distribution profiles explicitly; unresolved applicability blocks unqualified rollout. Preserve voice, streams, integrations and permitted collaboration in the relevant normal-journey slice. Evidence plane tree means executed isolated CURRENT-BUILD/runtime effects and controls on the applicable supported rows, not source inspection or aggregate suite green. Current-build acceptance does not wait for production deployment under D-009/D-010. For EVERY route in the frozen inventory (browser/plugin/child-process/direct broker/fetch/resource operation), include an explicit PERMITTED concrete-destination/path control and separate forbidden internal/metadata/operator, redirect/DNS rebinding, symlink/path-race and credential-forwarding canary. Revalidate actual resolved destination/redirect/resource immediately before effect and observe target-side receipt/absence. Fetch library unit green cannot cover alternate effect routes.",
      "candidateExistingPaths": [
        "packages/operator-core/lib/agent-tools/capability/fetch-policy.integration.test.ts"
      ],
      "pathsAreAcceptanceBindings": false,
      "detectorGap": "Real-socket fetch tests provide scoped allowed POST and confined loopback denial; full alternate routes, redirects/DNS/path-races and credential-forwarding rows remain unbound."
    },
    {
      "key": "r-13",
      "method": "Consume the SAME immutable manifest and tuple-ledger revision from Design 'Security population and proof contract (version 2)', with stable row IDs over actual distribution/install profile x platform x runtime x enforcement mode x entry point/effect/channel. Reconcile the criterion-specific slice in BOTH directions against independently derived P-001 sources. Independently authenticated outside-lineage applicability review, separate from manifest/ledger producer and executor, must be immutably committed with host-owned ordering BEFORE any qualification test/control/canary/mutation result is observed. Partition every applicable slice row exactly once as checked, notChecked or source-justified notApplicable and retain explicitly owned residue. Each checked row needs its OWN authorized positive control, distinct forbidden-effect canary, named detector/observation, killed mutant mapping where relevant, and exact source/test/fixture/loaded-runtime digests. Missing, unknown, omitted, duplicate, merged, late/backdated, altered, unjustified N/A, mismatched-pin or cross-row generic proof FAILS; unknown is never N/A. Genuine source/runtime/population change requires a new ledger, independent pre-execution commitment and affected requalification. Include native macOS 10.15 and actual maintained platform/distribution profiles explicitly; unresolved applicability blocks unqualified rollout. Preserve voice, streams, integrations and permitted collaboration in the relevant normal-journey slice. Evidence plane tree means executed isolated CURRENT-BUILD/runtime effects and controls on the applicable supported rows, not source inspection or aggregate suite green. Current-build acceptance does not wait for production deployment under D-009/D-010. Enumerate EVERY configured CPU/memory/process/connection/output/time/job budget and admission/execution/queued/nested/background/cancellation stage from the frozen sources. Drive bounded runaway/large-output/connections/jobs; falsify each enforcement fail-open independently. Observe enforced bounds, cancellation/timeout next-effect absence, complete descendant/job cleanup and unrelated-neighbor continuity. Unexercised mutants and framework failures cannot count as killed budget detectors.",
      "candidateExistingPaths": [],
      "pathsAreAcceptanceBindings": false,
      "detectorGap": "Per-budget/stage real runtime cleanup/late-effect and neighboring-session controls remain unbound."
    },
    {
      "key": "r-14",
      "method": "Consume the SAME immutable manifest and tuple-ledger revision from Design 'Security population and proof contract (version 2)', with stable row IDs over actual distribution/install profile x platform x runtime x enforcement mode x entry point/effect/channel. Reconcile the criterion-specific slice in BOTH directions against independently derived P-001 sources. Independently authenticated outside-lineage applicability review, separate from manifest/ledger producer and executor, must be immutably committed with host-owned ordering BEFORE any qualification test/control/canary/mutation result is observed. Partition every applicable slice row exactly once as checked, notChecked or source-justified notApplicable and retain explicitly owned residue. Each checked row needs its OWN authorized positive control, distinct forbidden-effect canary, named detector/observation, killed mutant mapping where relevant, and exact source/test/fixture/loaded-runtime digests. Missing, unknown, omitted, duplicate, merged, late/backdated, altered, unjustified N/A, mismatched-pin or cross-row generic proof FAILS; unknown is never N/A. Genuine source/runtime/population change requires a new ledger, independent pre-execution commitment and affected requalification. Include native macOS 10.15 and actual maintained platform/distribution profiles explicitly; unresolved applicability blocks unqualified rollout. Preserve voice, streams, integrations and permitted collaboration in the relevant normal-journey slice. Evidence plane tree means executed isolated CURRENT-BUILD/runtime effects and controls on the applicable supported rows, not source inspection or aggregate suite green. Current-build acceptance does not wait for production deployment under D-009/D-010. Attempt handler-controlled audit identity/approval injection, record deletion and canary disclosure against the actual access-controlled audit writer/store. Revoke/stop a selected live identity/invocation at the pre-effect barrier; observe correct host-owned caller/tool/resource/policy attribution, next-effect denial and scoped active-job cleanup with unrelated-session continuity. Audit message strings without protected store effects are insufficient.",
      "candidateExistingPaths": [],
      "pathsAreAcceptanceBindings": false,
      "detectorGap": "Access-controlled audit authenticity and emergency-stop full population detectors remain unbound."
    },
    {
      "key": "r-15",
      "method": "Consume the SAME immutable manifest and tuple-ledger revision from Design 'Security population and proof contract (version 2)', with stable row IDs over actual distribution/install profile x platform x runtime x enforcement mode x entry point/effect/channel. Reconcile the criterion-specific slice in BOTH directions against independently derived P-001 sources. Independently authenticated outside-lineage applicability review, separate from manifest/ledger producer and executor, must be immutably committed with host-owned ordering BEFORE any qualification test/control/canary/mutation result is observed. Partition every applicable slice row exactly once as checked, notChecked or source-justified notApplicable and retain explicitly owned residue. Each checked row needs its OWN authorized positive control, distinct forbidden-effect canary, named detector/observation, killed mutant mapping where relevant, and exact source/test/fixture/loaded-runtime digests. Missing, unknown, omitted, duplicate, merged, late/backdated, altered, unjustified N/A, mismatched-pin or cross-row generic proof FAILS; unknown is never N/A. Genuine source/runtime/population change requires a new ledger, independent pre-execution commitment and affected requalification. Include native macOS 10.15 and actual maintained platform/distribution profiles explicitly; unresolved applicability blocks unqualified rollout. Preserve voice, streams, integrations and permitted collaboration in the relevant normal-journey slice. Evidence plane tree means executed isolated CURRENT-BUILD/runtime effects and controls on the applicable supported rows, not source inspection or aggregate suite green. Current-build acceptance does not wait for production deployment under D-009/D-010. Enumerate each actual backup/snapshot/install/recovery and key/credential rotation variant, including interrupted/partial failure, revoked identities, stale policy and rollback floors, from frozen sources. Perform isolated usable encrypted-state restore and rotation drills; observe canary secrecy, authorization/audit continuity, compromised-credential invalidation and refusal to reactivate vulnerable/revoked policy. Include initial verifier bootstrap and protected trust/key recovery; never substitute production destructive data or a backup-creation-only test.",
      "candidateExistingPaths": [],
      "pathsAreAcceptanceBindings": false,
      "detectorGap": "Isolated complete restore/rotation/trust-recovery variant detectors remain unbound."
    },
    {
      "key": "r-16",
      "method": "Consume the SAME immutable manifest and tuple-ledger revision from Design 'Security population and proof contract (version 2)', with stable row IDs over actual distribution/install profile x platform x runtime x enforcement mode x entry point/effect/channel. Reconcile the criterion-specific slice in BOTH directions against independently derived P-001 sources. Independently authenticated outside-lineage applicability review, separate from manifest/ledger producer and executor, must be immutably committed with host-owned ordering BEFORE any qualification test/control/canary/mutation result is observed. Partition every applicable slice row exactly once as checked, notChecked or source-justified notApplicable and retain explicitly owned residue. Each checked row needs its OWN authorized positive control, distinct forbidden-effect canary, named detector/observation, killed mutant mapping where relevant, and exact source/test/fixture/loaded-runtime digests. Missing, unknown, omitted, duplicate, merged, late/backdated, altered, unjustified N/A, mismatched-pin or cross-row generic proof FAILS; unknown is never N/A. Genuine source/runtime/population change requires a new ledger, independent pre-execution commitment and affected requalification. Include native macOS 10.15 and actual maintained platform/distribution profiles explicitly; unresolved applicability blocks unqualified rollout. Preserve voice, streams, integrations and permitted collaboration in the relevant normal-journey slice. Final evidence plane deployed belongs to P-020 on the EXACT signed installed artifact: bind artifact digest, loaded runtime and policy/config digests, authenticated separated human/agent/automation author and approver identities, reviewed revision, Apple signing/notarization/update trust where applicable, signer/trust-root identity and epoch, version, freshness, rollback counter, signed metadata, and SAME stable row IDs/manifest/ledger pins. Current-build tests are preparatory and cannot satisfy final installed proof. Missing initial privileged-verifier/bootstrap establishment or authenticated complete author sets remains OPEN and blocks final proof; an already installed verifier is not bootstrap evidence. Census the ENTIRE frozen population against independently captured maintained and observed sources in BOTH directions, including every actual platform/distribution/runtime/entry/effect/channel tuple, native macOS 10.15, reviewed trusted exceptions and explicit unknowns. Reconcile criterion-specific R-1..R-15 observations with exact row IDs/pins without double-counting shared generic tests. Prove default-on rollout preflight/policy-load/enforcement-toggle fail-closed mutants, independent qualification/review, exact installed normal journeys and authorized rollback rehearsal. An exception is never called confined; population closure is distinct from R-5's unauthorized activation detector.",
      "candidateExistingPaths": [
        "packages/operator-core/lib/coverage-census/security-manifest.test.ts",
        "packages/operator-core/lib/coverage-census/security-qualification.test.ts",
        "packages/operator-core/lib/agent-tools/testing/run-security-qualification.test.ts"
      ],
      "pathsAreAcceptanceBindings": false,
      "detectorGap": "Existing shared census/custody tests explicitly certify custody ONLY; they cannot discharge real confinement, complete population or exact signed installed shipment."
    }
  ],
  "next": "First reconcile existing candidate assertions/fixtures/mutations to row-bound authorized/forbidden observations; implement missing maintained detectors under original implementing P-items. Then prepare rubrics:amend dryRun with complete criteria, exact immutable plan pin distinct from CAS expectedSubjectPlanRevision, platform-routed outside-lineage review, apply approved amendment and re-vet whole rubric. Do NOT replace unresolved bindings with generic green custody checks, attest, bind proof, emit cards or grade.",
  "scopeMappingSourcePins": {
    "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts": "144d27b836c643efb45970c5d9c5f4a0e117f1b34c6cb86b7647c3f2d366264e",
    "packages/operator-core/lib/plugin-invocation-policy.test.ts": "5781970c71322d2e09ac73835dd692f5a92dc75fedb083caf59a48d398ca9e19",
    "packages/plugin-loader/src/capabilities.test.ts": "2a8a65b1f7b21284056695f262b3c44b66204c0f75b97ecac92fa5784447c760",
    "packages/plugin-loader/src/capabilities.ts": "35b699a868b4f0d812ad7923811d0f3968144d1424991e6fe1e982bd12a68e94",
    "packages/operator-core/lib/plugin-invocation-policy.ts": "bff2e296fdbf4bdbc5d5d9fc6f633cc3682387ef73b9ecfaab519221681c85cf",
    "packages/operator-core/lib/plugin-invocation-policy-store.ts": "c354f49619a332f2b0330ed9cc3f9f39f6c71f31758efa5f449ecbd41884ecdf"
  },
  "scopeMappingVerification": {
    "run": "23bb0c39-93c5-4802-b69a-dd496686350c",
    "originRun": "6ee10835-420e-4bf1-a655-b50afa1240db",
    "snapshotArtifact": "security/p002-production-axes-run-20261106T0014Z.json",
    "status": "pass",
    "exitCode": 0,
    "scope": "one requested/executed/matched current working-source PG test file; HEAD7ca8016e82, uncommitted named path; full imported-source closure unknown",
    "counts": "not reconstructed: lifecycle snapshot output truncated; report file removed by runner",
    "skipObservation": "TEST_FILE_RESULT skippedTests=0",
    "typecheck": {
      "log": "/tmp/security-p002-production-axes-types-20261106.log",
      "status": "clean",
      "exitCode": 0,
      "scope": "changed test file only",
      "nativeSession": 55758,
      "terminal": true
    },
    "historicalMutants": [
      {
        "scope": "plugin-loader unit suite caller axis exclusion; not per-production-case proof",
        "log": "/tmp/security-p002-mutation-caller-browser-final-20261102.log",
        "ledger": [
          "23009940",
          "23009945",
          "23009946"
        ],
        "verdict": "caught",
        "currentRequalification": "not claimed"
      },
      {
        "scope": "plugin-loader unit suite parent recursion bypass; not per-production-case proof",
        "log": "/tmp/security-p002-mutation-parent-browser-final-20261102.log",
        "ledger": [
          "23010465",
          "23010469",
          "23010470"
        ],
        "verdict": "caught",
        "currentRequalification": "not claimed"
      }
    ]
  },
  "predecessorDraft": "security/acceptance-methods-detector-gaps-20261106T0016Z.json",
  "isolatedControlVerification": {
    "file": "packages/operator-core/lib/plugin-invocation-policy.test.ts",
    "sha256": "5781970c71322d2e09ac73835dd692f5a92dc75fedb083caf59a48d398ca9e19",
    "selector": "isolates %s refusal between authorized filesystem effects",
    "variants": [
      "grant-read",
      "allowlist",
      "expiry",
      "policy-read"
    ],
    "controls": "Each fresh fixture: authorized marker write; remove marker; perturb exactly one input; require refusal and marker absence; restore original authority; authorized marker write.",
    "limitation": "Injected host PDP/manifest/grant readers, local checked filesystem effects. No transport, confinement, independently frozen qualification row or full import-closure claim.",
    "runId": "41bb0a5f-40c5-4872-a19e-8878d35333ab",
    "originRunId": "a14adbc7-ab94-47da-82fc-e2434fb9292f",
    "status": "pass",
    "exitCode": 0,
    "passed": 16,
    "failed": 0,
    "pending": 0,
    "todo": 0,
    "reportPath": "/home/marsh-office/.papercusp/test-artifacts/testing-run/detached-recovery/run-2bcc44d8ea4f36b7a0707711/report-4f69ec36948e0bfb186d7c2a/reports/papercusp-testing-run-detached-555b845e-f35d-41b0-a160-9c4d3927310d.json",
    "reportSha256": "07c3d9f86503084a7290192f04fbfe9194ca08a3228538507ffdf4407712e235",
    "reportHashVerified": true,
    "snapshotRead": "/tmp/security-p002-isolated-refusals-status2-20261106.json",
    "typecheck": {
      "log": "/tmp/security-p002-isolated-refusals-types-20261106.log",
      "scope": "named changed file and resolved importers",
      "status": "clean",
      "exitCode": 0,
      "terminalNativeSession": 95194
    },
    "proofScope": "DEVELOPMENT_ONLY_NOT_QUALIFICATION"
  },
  "supplementRef": "security/p002-isolated-refusals-and-p003-preparation-20261106.json"
}
