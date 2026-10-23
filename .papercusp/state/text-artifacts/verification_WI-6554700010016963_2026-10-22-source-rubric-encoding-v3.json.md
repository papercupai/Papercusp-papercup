---
rel_path: "verification/WI-6554700010016963/2026-10-22-source-rubric-encoding-v3.json"
updated_at: 1792709897207
_body: "content"
---

{
  "schemaVersion": 1,
  "purpose": "Canonical source-rubric encoding repair proof; NOT current product acceptance, source-runtime/latency fix, scientific benefit or shipment.",
  "workItem": "WI-6554700010016963",
  "program": "WI-6554700010016092",
  "critiqueRef": "thread-post:1197185",
  "prior": {
    "rubricRevision": 1,
    "criteriaHash": "49bb491384c730835f935fc70032d42dfcda6f19d675f83138af2ef68b41e813",
    "barSetHash": "fd9e237dd89fd8a35858f8f3b98dcde8202b454828503fcfa8ea1ed6270e3e58",
    "barModels": [
      {
        "key": "r-1",
        "model": "Return raw and resolved scoped controls, references, bounded ledger rows, timestamp and serving identity via maintained reads."
      },
      {
        "key": "r-2",
        "model": "No setup, telemetry, control or paid-run writes. No inference of execution or benefit from controls/dispatches/absence."
      },
      {
        "key": "r-3",
        "model": "Conventional focused tests cover success plus invalid, missing, stale, wrong-scope/runtime and no-write cases; current-build proof remains distinct from shipment."
      },
      {
        "key": "r-4",
        "model": "Extend maintained typed observations for full Dream/Gym admission inputs, open reservations, live gates and spend; actual supplied Scout maxIdeators/lens/origin/cap; ordinary attempts or explicit pre-attempt policy skips with model/usage/spend provenance. Unknown and dispatch-only evidence cannot pass. Exercise the exact candidate predicates on a valid current-schema fixture and wrong-scope/hash/runtime/stale/retracted/dispatch-only negative controls. Produce one immutable edition with raw reads, runtime/source identity, timestamps and canonical assertion-bearing run; c6/SAME4f572 retain independent METHOD review and acceptance authority. Historical WI16926/run21355021 remain complete; no reconstruction reruns."
      }
    ]
  },
  "amendment": {
    "previewRef": "thread-post:1197241",
    "approval": {
      "id": 1197250,
      "thread_id": "issue-thread-WI-6554700010016963",
      "author_id": "su-d6db18ae-4121-4951-ac61-4b2ee2c14e84",
      "body": "approve thread-post:1197241 on\nVerified against live rubric revision 1 and subject plan v7 Requirements. Prior hashes match R-1 through R-4. The candidate preserves the original BAR models, adds criterion-specific methods/falsifiers/replication and assertion-bearing checks, re-planes R-3 conventional/current-build proof to tree while keeping shipment distinct, and keeps R-4 live with an authoritative staging/background current-witness join, immutable-edition constraints, D-001 boundaries, and independent c6/SAME4f572 authority.",
      "created_ts": "2026-10-22T22:43:54.499Z"
    },
    "appliedIdempotencyKey": "dream-source-rubric-1197185-additive-v2",
    "decisionRef": "dream-loaded-control-observations-2026-10-17#D-002",
    "subjectVersion": 8,
    "methodRefAmendmentIdempotencyKey": "dream-source-rubric-procedure-map-v3"
  },
  "rubric": {
    "rubricId": "acceptance-dream-loaded-control-observations-2026-10-17",
    "revision": 3,
    "workspaceId": "papercusp-workspace",
    "kind": "acceptance",
    "subjectPlan": "dream-loaded-control-observations-2026-10-17",
    "subjectHarnessSlug": "papercusp",
    "barSetHash": "94bbdf3cfbd9a48a46585f68d3c30469af5dddf8a8f96f7e9f67698be5b66557",
    "barContract": {
      "schemaVersion": 1,
      "adoptionEpoch": 1,
      "cohort": "post-epoch",
      "subjectPlanRevision": 8,
      "seededAt": "2026-10-22T22:45:34.153Z",
      "seededBy": "su-4acaa6da-4e2e-4349-a77e-5887a902bf20",
      "meaningRevision": 2
    },
    "characteristic": "plan-acceptance",
    "title": "Acceptance BAR — Authoritative Dream, Gym and Scout control observations",
    "description": "Predeclared acceptance BARs for dream-loaded-control-observations-2026-10-17.",
    "criteria": [
      {
        "key": "r-1",
        "title": "Authoritative observations",
        "model": "Return raw and resolved scoped controls, references, bounded ledger rows, timestamp and serving identity via maintained reads.",
        "bar": "Return raw and resolved scoped controls, references, bounded ledger rows, timestamp and serving identity via maintained reads.",
        "barKey": "R-1",
        "barHash": "7d7fdc633d47a732ec788d90a964a3a6ef6c9a0115a741820a64a1ff303e0ad7",
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
          "lifecycle": "legacy-backfilled",
          "declaredAt": "2026-10-22T20:18:36.730Z",
          "declaredBy": "su-4acaa6da-4e2e-4349-a77e-5887a902bf20"
        },
        "method": "Facet R-1 owns representation from maintained reads (plan R-1/P-001), distinct from R-2 side effects/honesty, R-3 verification provenance and R-4 integrated live closure. Named checks assert actual persisted raw per-mode controls against resolved Dream caps, loaded Gym floor and NULL budget refusal; bounded actual rows (limit 20/hasMore), raw Scout origin/lens/cost, and timestamp/serving/source references. Inspect the assertions and maintained read, not path existence or counts. The positive observed case executes real reader queries so a missing/gutted mechanism cannot satisfy negative assertions. Record R-1-specific values and per-case canonical IDs. Distinguishing failure: omitted raw/source data fails R-1 with SELECT-only behavior and a sound verification procedure still possible.",
        "driftMarkers": "Raw control/resolved value absent or inconsistent with maintained reads; default replaces persisted override or NULL; scope/origin/reference mismatch; rows exceed 20 or hasMore is concealed; capture/expiry/serving identity absent. Missing model usage must stay unknown.",
        "replication": "REPLICATION DRILL: use testing:run for changed/unproven bound conventional cases and resolve every selector in the canonical per-case ledger. With 21 actual Dream rows require 20 returned plus hasMore=true and NULL usage/cost intact; the positive controls fixture must still expose persisted overrides and the loaded Gym floor. Missing/skipped/zero-match cases are unknown, never healthy.",
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/dream/dream-control-observations.test.ts"
          ],
          "cases": [
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "reads actual persisted per-mode limits, loaded floor and NULL budgets without setup or paid dispatch"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "keeps missing usage/cost NULL and exposes bounded actual rows and one-ideator zero-route raw provenance"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "preserves a real NULL Gym refusal separately from an unreadable control"
            }
          ]
        }
      },
      {
        "key": "r-2",
        "title": "Read-only honesty",
        "model": "No setup, telemetry, control or paid-run writes. No inference of execution or benefit from controls/dispatches/absence.",
        "bar": "No setup, telemetry, control or paid-run writes. No inference of execution or benefit from controls/dispatches/absence.",
        "barKey": "R-2",
        "barHash": "52ba65d364cf2ef050a91754f64491aad823b42c25b71eae29f041c56e291b39",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "integration",
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "legacy-backfilled",
          "declaredAt": "2026-10-22T20:18:36.730Z",
          "declaredBy": "su-4acaa6da-4e2e-4349-a77e-5887a902bf20"
        },
        "method": "Facet R-2 owns read-only behavior and honest inference (plan R-2/P-001; D-001 missing records are not policy skips). The real-PostgreSQL named positive runs the maintained reader in READ ONLY, returns the exact scoped Scout row, excludes foreign workspace/pot/origin rows and preserves controls before/after. The missing-pot case stays unknown and creates zero setup rows. The named unit case rejects non-SELECT SQL and asserts modelExecution=not-established, preLedgerPolicySkips=not-recorded-in-attempt-ledger and outputQuality=not-evaluated. Inspect the reader call graph for setup/telemetry/control/paid-run mutation: SQL-only tests cannot prove safety of an unexercised external call. Pair every no-write negative with the successful positive to prevent deletion/failure vacuity. Use R-2-specific side-effect/inference evidence. Distinguishing failure: extra telemetry write fails R-2 while the returned representation and test provenance can remain correct.",
        "driftMarkers": "Any setup/telemetry/control/paid-run write on the observation path; routine payload/active state changes; an unprovisioned pot gets setup rows; non-SELECT SQL; execution/quality/benefit or policy skip inferred from controls, dispatch or absence. A no-write negative without a surviving successful observation cannot pass.",
        "replication": "REPLICATION DRILL: testing:run uses conventional unit and real-PostgreSQL routes. Require the exact same-pot @singleton positive row and unchanged routine controls, and require missing-pot unknown plus no newly materialized routines. An inserted write must fail READ ONLY; a deleted/throwing reader must fail the positive control.",
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/dream/dream-control-observations.test.ts",
            "packages/operator-core/lib/dream/dream-control-observations.integration.test.ts"
          ],
          "cases": [
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "reads actual persisted per-mode limits, loaded floor and NULL budgets without setup or paid dispatch"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.integration.test.ts",
              "testName": "runs in a READ ONLY transaction, preserving controls and the exact scoped zero-route row"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.integration.test.ts",
              "testName": "does not materialize missing controls during a read"
            }
          ]
        }
      },
      {
        "key": "r-3",
        "title": "Verification",
        "model": "Conventional focused tests cover success plus invalid, missing, stale, wrong-scope/runtime and no-write cases; current-build proof remains distinct from shipment.",
        "bar": "Conventional focused tests cover success plus invalid, missing, stale, wrong-scope/runtime and no-write cases; current-build proof remains distinct from shipment.",
        "barKey": "R-3",
        "barHash": "2cfda541f8d0dd034b763f9ab8c0ee83b2c8d2faff1d12ee210e46f65457be8a",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "integration",
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "legacy-backfilled",
          "declaredAt": "2026-10-22T20:18:36.730Z",
          "declaredBy": "su-4acaa6da-4e2e-4349-a77e-5887a902bf20"
        },
        "method": "Facet R-3 owns verification coverage and current-build provenance (plan R-3/P-001), separate from data truth, side effects and R-4 live closure. Tree/current-build proof remains distinct from final deployed shipment. Read the bound assertions: positive observed controls; invalid/missing/oversized/future scope and foreign workspace; missing controls; wrong runtime before reads; stale time/process/build/scope/window and altered TTL; degraded flags; real-PG success and no-write. Confirm assertion-bearing executed canonical per-case results, no collection failure/skips, clean commit and actual source/test/fixture hashes. When claiming current-build containment, select operator-api through dev:pipeline_position and check servingRuntimes against tested bytes. A green count or edited file is insufficient. Preserve historical clean receipts as history and rerun only changed or missing proof; never replay unchanged historical METHOD just to chase fingerprints. Distinguishing failure: a missing/skipped detector or mismatched tested build fails R-3 even if a separate observation returns correct data without writes.",
        "driftMarkers": "Missing or vacuous success; invalid/missing/stale/wrong-scope/runtime/no-write class without an executed detector; zero-match selector; skipped/failed/collection-failed or dirty/source-mismatched receipt offered as current clean proof; fixture/e2e relabeled native operational evidence; current-build result offered as final shipment.",
        "replication": "REPLICATION DRILL: through testing:run execute changed/unproven conventional checks, retain canonical run/per-case IDs and clean source/test/fixture hashes. The wrong expected process refuses before flags/SQL, expiry/altered TTL is noncurrent, missing controls are unknown, and a positive current-schema read survives. For runtime containment use the supported current-build operator-api route and actual loaded bytes; final-release is not a prerequisite. Missing/skipped/mismatched proof cannot be healthy; do not replay run21772236.",
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/dream/dream-control-observations.test.ts",
            "packages/operator-core/lib/dream/dream-control-observations.integration.test.ts"
          ],
          "cases": [
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "reads actual persisted per-mode limits, loaded floor and NULL budgets without setup or paid dispatch"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "rejects missing/invalid/oversized/future scope before reading and refuses another workspace"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "reports missing controls as unknown rather than approved defaults"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "refuses another serving runtime before touching flags or stores"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "invalidates stored evidence on time, process, build, scope or window changes"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "refuses degraded flags instead of certifying a default as a loaded runtime override"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.integration.test.ts",
              "testName": "runs in a READ ONLY transaction, preserving controls and the exact scoped zero-route row"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.integration.test.ts",
              "testName": "does not materialize missing controls during a read"
            }
          ]
        }
      },
      {
        "key": "r-4",
        "title": "Complete operational evidence (WI-6554700010016963)",
        "model": "Extend maintained typed observations for full Dream/Gym admission inputs, open reservations, live gates and spend; actual supplied Scout maxIdeators/lens/origin/cap; ordinary attempts or explicit pre-attempt policy skips with model/usage/spend provenance. Unknown and dispatch-only evidence cannot pass. Exercise the exact candidate predicates on a valid current-schema fixture and wrong-scope/hash/runtime/stale/retracted/dispatch-only negative controls. Produce one immutable edition with raw reads, runtime/source identity, timestamps and canonical assertion-bearing run; c6/SAME4f572 retain independent METHOD review and acceptance authority. Historical WI16926/run21355021 remain complete; no reconstruction reruns.",
        "bar": "Extend maintained typed observations for full Dream/Gym admission inputs, open reservations, live gates and spend; actual supplied Scout maxIdeators/lens/origin/cap; ordinary attempts or explicit pre-attempt policy skips with model/usage/spend provenance. Unknown and dispatch-only evidence cannot pass. Exercise the exact candidate predicates on a valid current-schema fixture and wrong-scope/hash/runtime/stale/retracted/dispatch-only negative controls. Produce one immutable edition with raw reads, runtime/source identity, timestamps and canonical assertion-bearing run; c6/SAME4f572 retain independent METHOD review and acceptance authority. Historical WI16926/run21355021 remain complete; no reconstruction reruns.",
        "barKey": "R-4",
        "barHash": "9bb8ebc5c7b117af0ca1bc353bd12eeb825ba4742cf96344a994c77b7cdc10c2",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "evidenceRuntime": "staging-operator",
        "requiredTestLayers": [
          "integration",
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "legacy-backfilled",
          "declaredAt": "2026-10-22T20:18:36.730Z",
          "declaredBy": "su-4acaa6da-4e2e-4349-a77e-5887a902bf20"
        },
        "method": "Integrated R-4 owns one coherent CURRENT operational closure; R-1/R-2/R-3 are prerequisite facets graded on their own evidence, never copied/co-rated here. Trace: plan R-4/P-002, WI-6554700010016963 and D-001. Every original BAR sentence stays binding. R-4's unique evidence is ONE unaltered canonical operational edition plus an authoritative current runtime/environment witness joined to its exact content hash, source/test/fixture identities, scope/window, capture/consumer/expiry and canonical assertion-bearing native run. Candidate/unit checks are necessary method guards and cannot alone earn healthy on this live criterion. Until the live join and every clause are measured, keep unknown/unhealthy; read-only collection authorizes neither paid cycles nor control changes.\n\nFive product clauses, individually open until evidenced in that same edition: (1) r2:dream-action-decisions -> /actionDecisions: authentic ordinary Dream action journal; exact unit/process/build/workspace/pot/window; complete ordered passed/refused/not-reached gate chain. (2) r2:gym-admission-decisions -> /gymDecisions: authentic Gym gate records; all passed or refusal with complete passed prefix; exact producer identity/scope/window; no clipped/truncated/unread records. (3) r2:full-admission-and-spend -> /productionAdmission, /observations/governors, /observations/rollingSpend: full maintained Dream/Gym admission inputs, open reservations, native and later live gates and conservative spend accounting; budget-only controls are insufficient. (4) r2:scout-zero-route-lens-cap-provenance -> /observations/activity/value/scout: complete bounded same-origin ordinary Scout rows; supplied/resolved maxIdeators=1 and actual cost cap; one executed ideator and zero routes per tick; at least two qualifying ticks with changing lenses in scope/window. Missing cap/cost or a preflight with no slots is unknown; overspend/extra ideator fails. (5) r2:actual-attempts-or-explicit-policy-skips -> /actionDecisions plus /observations/activity/value/dream: ordinary attempt runRefs join actual same-scope Dream rows with nonempty model, measured nonnegative input/output usage and spend; explicit pre-attempt policy skip has authoritative disposition/reason, complete refusal chain, paidCalls=0, model=null, usage=null, costUsd=0. Absence/dispatch is never a policy skip.\n\n(6) Candidate guards: exact frozen candidate SQL against migrated current PostgreSQL column types; coherent positive fixture yields seven true predicates; wrong-scope/hash/retracted/dispatch-only/missing-assertion/runtime/stale negative controls each make the conjunction false. Bound unit fixtures positively prove all five maintained clauses for both measured-attempt and explicit policy-skip and reject the named provenance defects. These are synthetic method checks, not current product health or permission to apply frozen candidate amendments/signatures.\n\n(7) Edition/current-witness join: preserve canonical raw artifact SHA-256, native run ID, independently measured source/runtime identities and original timestamps. Every rawRef must resolve inside the same edition with its exact scope/source/capturedAt/expiresAt. Immediately before current acceptance read plans:get-spec-evidence for the exact new binding with measured current fingerprints and require applicable source/test/fixture/rubric/environment dimensions CURRENT rather than stale/unknown. Independently verify actually loaded staging API and background producer unit/process/build against the edition and source bytes: API :3170 identity does not prove bg-host identity. Original consumer lies within the 60s TTL; later current acceptance needs its own authoritative currentness witness rather than restamping expired history. D-001 accepts run21772236/binding64593 METHOD ADEQUATE AS COLLECTED only, not current health or a detector-rewrite hypothesis.\n\n(8) Authority/non-regression: c6/SAME4f572 independent review remains a prerequisite separate from product pass; historical WI16926/run21355021 remain complete with no reconstruction reruns. Preserve fixed19/eight-repair/three-residue, unit/real-PG, science/human/native/source-plan/final-artifact gates. Historical adequacy or this author repair supplies no parser signature, amendment/apply, grade, activation or shipment authority. Distinguishing failure: a missing current environment witness/qualifying production event or hash-mismatched edition keeps R-4 unknown with R-1/R-2/R-3 healthy. A failed facet blocks final conjunction without automatically duplicating that facet's rating/evidence into R-4.",
        "driftMarkers": "(1) Missing/dispatch-only/wrong-process Dream decisions or incomplete chain. (2) Missing/wrong-unit/runtime/clipped/truncated/read-error Gym gates or fail-open prefix. (3) Missing admission inputs/reservations/later gates/spend; budget-only proxy. (4) Foreign scope/origin/window, incomplete rows, unchanged lens, cap mismatch/absence, missing cost, no slots, extra ideator, overspend. (5) Attempt lacks joined model/usage/spend/runRefs or skip lacks explicit authoritative zero-paid pre-attempt provenance; absence claimed skip. (6) Positive fixture fails or any wrong-scope/hash/retracted/dispatch-only/missing-assertion/runtime/stale control passes; substitute SQL used. (7) Dangling refs, mutated/restamped edition, source/hash/runtime/environment mismatch, expired capture treated current, tree/e2e/dispatch substituted for native proof, one host's identity used for another producer. (8) Historical METHOD/fixture pass used to close current clauses; original BAR narrowed; c6/SAME bypassed; completed history reconstructed; spending/authority gate bypassed. Missing current evidence is unknown/unhealthy.",
        "replication": "REPLICATION DRILL: read existing exact source/test/fixture/run evidence before deciding on reruns. For changed or unproven method guards, testing:run executes the current-schema real-PG candidate file and named unit cases; coherent positive passes, each seven perturbations breaks at least one frozen predicate. Separately collect read-only current runtime witness and unaltered canonical operational edition when product acceptance needs it, preserving all five statuses/refs and the source/test/fixture/rubric/environment join. Both ordinary measured-attempt and explicit zero-paid policy-skip fixtures stay positive; removing cap/usage/decision/producer identity is unhealthy. No paid cycle, e2e relabeling, historical restamp or unchanged historical METHOD rerun.",
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/dream/dream-control-observations.test.ts",
            "packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts"
          ],
          "cases": [
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "emits maintained typed clauses with authoritative scope, refs and timestamps for policy-skip"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "emits maintained typed clauses with authoritative scope, refs and timestamps for measured-attempt"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "keeps absent-gym unhealthy without treating missing evidence as successful execution"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "keeps dispatch-only unhealthy without treating missing evidence as successful execution"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "keeps missing-cap unhealthy without treating missing evidence as successful execution"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "keeps over-cap unhealthy without treating missing evidence as successful execution"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "keeps unchanged-lens unhealthy without treating missing evidence as successful execution"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "keeps foreign-origin unhealthy without treating missing evidence as successful execution"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "keeps truncated-scout unhealthy without treating missing evidence as successful execution"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "keeps wrong-runtime unhealthy without treating missing evidence as successful execution"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "keeps stale unhealthy without treating missing evidence as successful execution"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "keeps usage-null unhealthy without treating missing evidence as successful execution"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "keeps early-skip-no-slots unhealthy without treating missing evidence as successful execution"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "keeps early-skip-empty-slots unhealthy without treating missing evidence as successful execution"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "keeps ideator-excess unhealthy without treating missing evidence as successful execution"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "uses open reservations in lifetime governor decisions, preserving native and later-gate limits"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "preserves actual per-tick Scout cap provenance and refuses valid ambiguity"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "preserves actual per-tick Scout cap provenance and refuses missing ambiguity"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "preserves actual per-tick Scout cap provenance and refuses mismatch ambiguity"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "preserves actual per-tick Scout cap provenance and refuses overspend ambiguity"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "preserves actual per-tick Scout cap provenance and refuses missing-cost ambiguity"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "preserves actual per-tick Scout cap provenance and refuses invalid-supplied ambiguity"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "requires an actual complete Dream refusal chain: valid"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "requires an actual complete Dream refusal chain: missing-gates"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "requires an actual complete Dream refusal chain: unknown"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "requires an actual complete Dream refusal chain: wrong-prefix"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "requires an actual complete Dream refusal chain: dispatch-only"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "validates actual Gym gate records and preserves valid uncertainty"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "validates actual Gym gate records and preserves refusal uncertainty"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "validates actual Gym gate records and preserves missing-prefix uncertainty"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "validates actual Gym gate records and preserves fail-open uncertainty"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "validates actual Gym gate records and preserves wrong-runtime uncertainty"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "validates actual Gym gate records and preserves wrong-unit uncertainty"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "validates actual Gym gate records and preserves clipped uncertainty"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "validates actual Gym gate records and preserves truncated uncertainty"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "validates actual Gym gate records and preserves absent uncertainty"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "accepts only an authentic complete actual action skip: valid"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "accepts only an authentic complete actual action skip: absent"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "accepts only an authentic complete actual action skip: dispatch"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "accepts only an authentic complete actual action skip: wrong-runtime"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "accepts only an authentic complete actual action skip: wrong-scope"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "accepts only an authentic complete actual action skip: wrong-window"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "accepts only an authentic complete actual action skip: clipped"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "accepts only an authentic complete actual action skip: truncated"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "accepts only an authentic complete actual action skip: read-error"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "accepts only an authentic complete actual action skip: paid-skip"
            },
            {
              "file": "packages/operator-core/lib/dream/dream-control-observations.test.ts",
              "testName": "does not certify requested action currentness from absent journal records or a different expected action process"
            },
            {
              "file": "packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts",
              "testName": "accepts a complete coherent synthetic edition in all seven exact frozen predicates"
            },
            {
              "file": "packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts",
              "testName": "rejects wrong-scope without mutating live controls"
            },
            {
              "file": "packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts",
              "testName": "rejects wrong-hash without mutating live controls"
            },
            {
              "file": "packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts",
              "testName": "rejects retracted without mutating live controls"
            },
            {
              "file": "packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts",
              "testName": "rejects dispatch-only without mutating live controls"
            },
            {
              "file": "packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts",
              "testName": "rejects missing-assertion without mutating live controls"
            },
            {
              "file": "packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts",
              "testName": "rejects wrong-runtime without mutating live controls"
            },
            {
              "file": "packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts",
              "testName": "rejects stale without mutating live controls"
            }
          ]
        }
      }
    ],
    "ratingScale": [
      "healthy",
      "degraded",
      "broken",
      "unknown"
    ],
    "criteriaHash": "cda7c8d9693e626d707651eb04abeaf581f6924fb82ba21aac1e0de5cb0ed221",
    "methodRef": "verification-system-map",
    "gradingAuthority": "independent",
    "status": "active",
    "createdBy": "su-4acaa6da-4e2e-4349-a77e-5887a902bf20",
    "proposedBy": "su-4acaa6da-4e2e-4349-a77e-5887a902bf20",
    "ratifiedBy": null,
    "createdAt": "2026-10-22",
    "updatedAt": "2026-10-22T22:49:22.382Z"
  },
  "verification": {
    "allFourOriginalModelsPreserved": true,
    "originalLegacyProvenancePreserved": true,
    "requiredCriterionMethodsPresent": true,
    "caseSelectorSQL": "WITH wanted(bar,file_path,title) AS (VALUES ('r-1','packages/operator-core/lib/dream/dream-control-observations.test.ts','reads actual persisted per-mode limits, loaded floor and NULL budgets without setup or paid dispatch'),('r-1','packages/operator-core/lib/dream/dream-control-observations.test.ts','keeps missing usage/cost NULL and exposes bounded actual rows and one-ideator zero-route raw provenance'),('r-1','packages/operator-core/lib/dream/dream-control-observations.test.ts','preserves a real NULL Gym refusal separately from an unreadable control'),('r-2','packages/operator-core/lib/dream/dream-control-observations.test.ts','reads actual persisted per-mode limits, loaded floor and NULL budgets without setup or paid dispatch'),('r-2','packages/operator-core/lib/dream/dream-control-observations.integration.test.ts','runs in a READ ONLY transaction, preserving controls and the exact scoped zero-route row'),('r-2','packages/operator-core/lib/dream/dream-control-observations.integration.test.ts','does not materialize missing controls during a read'),('r-3','packages/operator-core/lib/dream/dream-control-observations.test.ts','reads actual persisted per-mode limits, loaded floor and NULL budgets without setup or paid dispatch'),('r-3','packages/operator-core/lib/dream/dream-control-observations.test.ts','rejects missing/invalid/oversized/future scope before reading and refuses another workspace'),('r-3','packages/operator-core/lib/dream/dream-control-observations.test.ts','reports missing controls as unknown rather than approved defaults'),('r-3','packages/operator-core/lib/dream/dream-control-observations.test.ts','refuses another serving runtime before touching flags or stores'),('r-3','packages/operator-core/lib/dream/dream-control-observations.test.ts','invalidates stored evidence on time, process, build, scope or window changes'),('r-3','packages/operator-core/lib/dream/dream-control-observations.test.ts','refuses degraded flags instead of certifying a default as a loaded runtime override'),('r-3','packages/operator-core/lib/dream/dream-control-observations.integration.test.ts','runs in a READ ONLY transaction, preserving controls and the exact scoped zero-route row'),('r-3','packages/operator-core/lib/dream/dream-control-observations.integration.test.ts','does not materialize missing controls during a read'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','emits maintained typed clauses with authoritative scope, refs and timestamps for policy-skip'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','emits maintained typed clauses with authoritative scope, refs and timestamps for measured-attempt'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','keeps absent-gym unhealthy without treating missing evidence as successful execution'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','keeps dispatch-only unhealthy without treating missing evidence as successful execution'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','keeps missing-cap unhealthy without treating missing evidence as successful execution'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','keeps over-cap unhealthy without treating missing evidence as successful execution'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','keeps unchanged-lens unhealthy without treating missing evidence as successful execution'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','keeps foreign-origin unhealthy without treating missing evidence as successful execution'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','keeps truncated-scout unhealthy without treating missing evidence as successful execution'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','keeps wrong-runtime unhealthy without treating missing evidence as successful execution'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','keeps stale unhealthy without treating missing evidence as successful execution'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','keeps usage-null unhealthy without treating missing evidence as successful execution'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','keeps early-skip-no-slots unhealthy without treating missing evidence as successful execution'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','keeps early-skip-empty-slots unhealthy without treating missing evidence as successful execution'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','keeps ideator-excess unhealthy without treating missing evidence as successful execution'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','uses open reservations in lifetime governor decisions, preserving native and later-gate limits'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','preserves actual per-tick Scout cap provenance and refuses valid ambiguity'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','preserves actual per-tick Scout cap provenance and refuses missing ambiguity'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','preserves actual per-tick Scout cap provenance and refuses mismatch ambiguity'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','preserves actual per-tick Scout cap provenance and refuses overspend ambiguity'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','preserves actual per-tick Scout cap provenance and refuses missing-cost ambiguity'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','preserves actual per-tick Scout cap provenance and refuses invalid-supplied ambiguity'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','requires an actual complete Dream refusal chain: valid'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','requires an actual complete Dream refusal chain: missing-gates'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','requires an actual complete Dream refusal chain: unknown'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','requires an actual complete Dream refusal chain: wrong-prefix'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','requires an actual complete Dream refusal chain: dispatch-only'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','validates actual Gym gate records and preserves valid uncertainty'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','validates actual Gym gate records and preserves refusal uncertainty'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','validates actual Gym gate records and preserves missing-prefix uncertainty'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','validates actual Gym gate records and preserves fail-open uncertainty'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','validates actual Gym gate records and preserves wrong-runtime uncertainty'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','validates actual Gym gate records and preserves wrong-unit uncertainty'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','validates actual Gym gate records and preserves clipped uncertainty'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','validates actual Gym gate records and preserves truncated uncertainty'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','validates actual Gym gate records and preserves absent uncertainty'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','accepts only an authentic complete actual action skip: valid'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','accepts only an authentic complete actual action skip: absent'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','accepts only an authentic complete actual action skip: dispatch'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','accepts only an authentic complete actual action skip: wrong-runtime'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','accepts only an authentic complete actual action skip: wrong-scope'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','accepts only an authentic complete actual action skip: wrong-window'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','accepts only an authentic complete actual action skip: clipped'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','accepts only an authentic complete actual action skip: truncated'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','accepts only an authentic complete actual action skip: read-error'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','accepts only an authentic complete actual action skip: paid-skip'),('r-4','packages/operator-core/lib/dream/dream-control-observations.test.ts','does not certify requested action currentness from absent journal records or a different expected action process'),('r-4','packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts','accepts a complete coherent synthetic edition in all seven exact frozen predicates'),('r-4','packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts','rejects wrong-scope without mutating live controls'),('r-4','packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts','rejects wrong-hash without mutating live controls'),('r-4','packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts','rejects retracted without mutating live controls'),('r-4','packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts','rejects dispatch-only without mutating live controls'),('r-4','packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts','rejects missing-assertion without mutating live controls'),('r-4','packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts','rejects wrong-runtime without mutating live controls'),('r-4','packages/operator-core/lib/dream/r2-method-predicates.integration.test.ts','rejects stale without mutating live controls')), files AS (SELECT DISTINCT file_path FROM wanted), latest AS (SELECT f.file_path,r.id,r.workspace_id,r.harness_slug,r.commit_sha,r.worktree_dirty FROM files f LEFT JOIN LATERAL (SELECT id,workspace_id,harness_slug,commit_sha,worktree_dirty FROM harness_shared.test_runs WHERE file_path=f.file_path AND status='pass' ORDER BY id DESC LIMIT 1) r ON true), matched AS (SELECT w.bar,w.file_path,w.title,l.id,l.workspace_id,l.harness_slug,l.commit_sha,l.worktree_dirty,(SELECT count(*) FROM harness_shared.test_case_runs c WHERE c.test_run_id=l.id AND (c.case_key=w.title OR right(c.case_key,length(w.title)+3)=' > '||w.title)) AS n FROM wanted w JOIN latest l USING(file_path)) SELECT file_path,id::text,workspace_id,harness_slug,commit_sha,worktree_dirty,count(*)::int AS selectors,json_agg(json_build_object('bar',bar,'title',title)) FILTER (WHERE n=0) AS unmatched FROM matched GROUP BY file_path,id,workspace_id,harness_slug,commit_sha,worktree_dirty ORDER BY file_path",
    "caseSelectorResult": "Historical case-title identity check returned no unmatched selectors for the bound three files; same-table positive control passed. The selected rows are explicitly dirty/historical (one has harness null); this is title validation only, not accepted, current, clean or product proof. No test matrix or unchanged historical METHOD was rerun.",
    "newTestsRun": "none: rubric metadata repair, actual existing assertion bodies and recorded case titles inspected; canonical preview/apply and full rubric/spec readbacks verified."
  },
  "specsSnapshotAfterMeaningAmendment": {
    "ok": true,
    "slug": "dream-loaded-control-observations-2026-10-17",
    "harnessSlug": "papercusp",
    "specs": [
      {
        "planSlug": "dream-loaded-control-observations-2026-10-17",
        "specId": "AUTO-BAR-R-1-P-001",
        "sourceValId": null,
        "currentRevision": 2,
        "revision": 2,
        "planItemId": "P-001",
        "behavior": "Return raw and resolved scoped controls, references, bounded ledger rows, timestamp and serving identity via maintained reads.",
        "behaviorClass": "happy-path",
        "requiredEvidence": [
          "tree"
        ],
        "requiredTestLayers": [
          "unit"
        ],
        "mutationRequired": false,
        "lifecycleStatus": "draft",
        "supersedes": null,
        "exemption": null,
        "falsifier": {
          "observation": "Raw control/resolved value absent or inconsistent with maintained reads; default replaces persisted override or NULL; scope/origin/reference mismatch; rows exceed 20 or hasMore is concealed; capture/expiry/serving identity absent. Missing model usage must stay unknown."
        },
        "contentHash": "fafe4349c4c82406e9faca3a758bba31034ce0e23e35a406fd4fb68e4d9bf831",
        "createdBy": "su-4acaa6da-4e2e-4349-a77e-5887a902bf20",
        "createdAt": "2026-10-22T22:45:34.153Z",
        "acceptedBy": null,
        "acceptedAt": null,
        "acceptanceRef": "acceptance-dream-loaded-control-observations-2026-10-17@2:R-1",
        "sourceBar": {
          "barKey": "R-1",
          "barHash": "7d7fdc633d47a732ec788d90a964a3a6ef6c9a0115a741820a64a1ff303e0ad7",
          "barSetHash": "94bbdf3cfbd9a48a46585f68d3c30469af5dddf8a8f96f7e9f67698be5b66557",
          "rubricSlug": "acceptance-dream-loaded-control-observations-2026-10-17",
          "rubricRevision": 2,
          "evidencePlane": "tree"
        }
      },
      {
        "planSlug": "dream-loaded-control-observations-2026-10-17",
        "specId": "AUTO-BAR-R-2-P-001",
        "sourceValId": null,
        "currentRevision": 2,
        "revision": 2,
        "planItemId": "P-001",
        "behavior": "No setup, telemetry, control or paid-run writes. No inference of execution or benefit from controls/dispatches/absence.",
        "behaviorClass": "happy-path",
        "requiredEvidence": [
          "tree"
        ],
        "requiredTestLayers": [
          "integration",
          "unit"
        ],
        "mutationRequired": false,
        "lifecycleStatus": "draft",
        "supersedes": null,
        "exemption": null,
        "falsifier": {
          "observation": "Any setup/telemetry/control/paid-run write on the observation path; routine payload/active state changes; an unprovisioned pot gets setup rows; non-SELECT SQL; execution/quality/benefit or policy skip inferred from controls, dispatch or absence. A no-write negative without a surviving successful observation cannot pass."
        },
        "contentHash": "8351ee201bca33944ee3f10f3ed250825e11eb44c040039e8322399b5ba7e27f",
        "createdBy": "su-4acaa6da-4e2e-4349-a77e-5887a902bf20",
        "createdAt": "2026-10-22T22:45:34.153Z",
        "acceptedBy": null,
        "acceptedAt": null,
        "acceptanceRef": "acceptance-dream-loaded-control-observations-2026-10-17@2:R-2",
        "sourceBar": {
          "barKey": "R-2",
          "barHash": "52ba65d364cf2ef050a91754f64491aad823b42c25b71eae29f041c56e291b39",
          "barSetHash": "94bbdf3cfbd9a48a46585f68d3c30469af5dddf8a8f96f7e9f67698be5b66557",
          "rubricSlug": "acceptance-dream-loaded-control-observations-2026-10-17",
          "rubricRevision": 2,
          "evidencePlane": "tree"
        }
      },
      {
        "planSlug": "dream-loaded-control-observations-2026-10-17",
        "specId": "AUTO-BAR-R-3-P-001",
        "sourceValId": null,
        "currentRevision": 2,
        "revision": 2,
        "planItemId": "P-001",
        "behavior": "Conventional focused tests cover success plus invalid, missing, stale, wrong-scope/runtime and no-write cases; current-build proof remains distinct from shipment.",
        "behaviorClass": "happy-path",
        "requiredEvidence": [
          "tree"
        ],
        "requiredTestLayers": [
          "integration",
          "unit"
        ],
        "mutationRequired": false,
        "lifecycleStatus": "draft",
        "supersedes": null,
        "exemption": null,
        "falsifier": {
          "observation": "Missing or vacuous success; invalid/missing/stale/wrong-scope/runtime/no-write class without an executed detector; zero-match selector; skipped/failed/collection-failed or dirty/source-mismatched receipt offered as current clean proof; fixture/e2e relabeled native operational evidence; current-build result offered as final shipment."
        },
        "contentHash": "9b1604e47199bde5748481878ddeadbbe8cfa8f90e71eee4efa9222a5c04f7d1",
        "createdBy": "su-4acaa6da-4e2e-4349-a77e-5887a902bf20",
        "createdAt": "2026-10-22T22:45:34.153Z",
        "acceptedBy": null,
        "acceptedAt": null,
        "acceptanceRef": "acceptance-dream-loaded-control-observations-2026-10-17@2:R-3",
        "sourceBar": {
          "barKey": "R-3",
          "barHash": "2cfda541f8d0dd034b763f9ab8c0ee83b2c8d2faff1d12ee210e46f65457be8a",
          "barSetHash": "94bbdf3cfbd9a48a46585f68d3c30469af5dddf8a8f96f7e9f67698be5b66557",
          "rubricSlug": "acceptance-dream-loaded-control-observations-2026-10-17",
          "rubricRevision": 2,
          "evidencePlane": "tree"
        }
      },
      {
        "planSlug": "dream-loaded-control-observations-2026-10-17",
        "specId": "AUTO-BAR-R-4-P-002",
        "sourceValId": null,
        "currentRevision": 2,
        "revision": 2,
        "planItemId": "P-002",
        "behavior": "Extend maintained typed observations for full Dream/Gym admission inputs, open reservations, live gates and spend; actual supplied Scout maxIdeators/lens/origin/cap; ordinary attempts or explicit pre-attempt policy skips with model/usage/spend provenance. Unknown and dispatch-only evidence cannot pass. Exercise the exact candidate predicates on a valid current-schema fixture and wrong-scope/hash/runtime/stale/retracted/dispatch-only negative controls. Produce one immutable edition with raw reads, runtime/source identity, timestamps and canonical assertion-bearing run; c6/SAME4f572 retain independent METHOD review and acceptance authority. Historical WI16926/run21355021 remain complete; no reconstruction reruns.",
        "behaviorClass": "happy-path",
        "requiredEvidence": [
          "live"
        ],
        "requiredTestLayers": [
          "integration",
          "unit"
        ],
        "mutationRequired": false,
        "lifecycleStatus": "draft",
        "supersedes": null,
        "exemption": null,
        "falsifier": {
          "observation": "(1) Missing/dispatch-only/wrong-process Dream decisions or incomplete chain. (2) Missing/wrong-unit/runtime/clipped/truncated/read-error Gym gates or fail-open prefix. (3) Missing admission inputs/reservations/later gates/spend; budget-only proxy. (4) Foreign scope/origin/window, incomplete rows, unchanged lens, cap mismatch/absence, missing cost, no slots, extra ideator, overspend. (5) Attempt lacks joined model/usage/spend/runRefs or skip lacks explicit authoritative zero-paid pre-attempt provenance; absence claimed skip. (6) Positive fixture fails or any wrong-scope/hash/retracted/dispatch-only/missing-assertion/runtime/stale control passes; substitute SQL used. (7) Dangling refs, mutated/restamped edition, source/hash/runtime/environment mismatch, expired capture treated current, tree/e2e/dispatch substituted for native proof, one host's identity used for another producer. (8) Historical METHOD/fixture pass used to close current clauses; original BAR narrowed; c6/SAME bypassed; completed history reconstructed; spending/authority gate bypassed. Missing current evidence is unknown/unhealthy."
        },
        "contentHash": "cb96c7415cbc08ba463de7013976018fe86b3ae2611f2f0edf0450ca49d085d9",
        "createdBy": "su-4acaa6da-4e2e-4349-a77e-5887a902bf20",
        "createdAt": "2026-10-22T22:45:34.153Z",
        "acceptedBy": null,
        "acceptedAt": null,
        "acceptanceRef": "acceptance-dream-loaded-control-observations-2026-10-17@2:R-4",
        "sourceBar": {
          "barKey": "R-4",
          "barHash": "9bb8ebc5c7b117af0ca1bc353bd12eeb825ba4742cf96344a994c77b7cdc10c2",
          "barSetHash": "94bbdf3cfbd9a48a46585f68d3c30469af5dddf8a8f96f7e9f67698be5b66557",
          "rubricSlug": "acceptance-dream-loaded-control-observations-2026-10-17",
          "rubricRevision": 2,
          "evidencePlane": "live"
        }
      }
    ],
    "count": 4,
    "mode": "current"
  },
  "freshVetting": {
    "revision": 3,
    "criteriaHash": "cda7c8d9693e626d707651eb04abeaf581f6924fb82ba21aac1e0de5cb0ed221",
    "barSetHash": "94bbdf3cfbd9a48a46585f68d3c30469af5dddf8a8f96f7e9f67698be5b66557",
    "conversationId": "conv-request-911f4916a593c46ec8848696c86405786b180fda8d2fee67dc1f3b92569d7695",
    "status": "awaiting_responder",
    "answeringOwner": "su-99dcaf22-b90c-45e5-ba2a-4fc80eabe1e7",
    "pickupConfirmed": true,
    "sourceOwner": "su-0416b1d6-7ae2-4eb6-8dfa-2ee0b8e36bb8",
    "note": "Canonical requester policy rubric-vetting, archive bypass, min-fill below relevance floor, dispatch converted to codex/sol after Claude account walls; independently assess the answer, not its routing score."
  },
  "boundaries": [
    "All5R4currentProductClausesOPEN",
    "D001historicalMETHOD21772236/binding64593unchanged",
    "c6/SAMEauthoritypreserved",
    "fixed19/eight-repair/three-residuepreserved",
    "science/human/native/outcome/finalshipmentgatespreserved",
    "No paid cycles, control mutation, history restamp, unchanged METHOD rerun or LIVE_GATE_OPS"
  ]
}
