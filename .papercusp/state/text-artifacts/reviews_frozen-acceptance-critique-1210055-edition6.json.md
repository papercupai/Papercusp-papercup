---
rel_path: "reviews/frozen-acceptance-critique-1210055-edition6.json"
updated_at: 1793246692790
_body: "content"
---

{
  "rubricRef": "frozen-lineage-red-burndown-2026-10-27-acceptance",
  "criteria": [
    {
      "key": "r-1",
      "title": "The promoted candidate is green and main is promoted from it",
      "intent": {
        "request": "Every one of the 137 round-8 failing test files passes on the candidate the green-checkpoint gate promotes, and main is promoted from that candidate.",
        "rationale": "The burn-down exists so the papercusp gate can promote main again.",
        "sourceRefs": [
          "plan:frozen-lineage-red-burndown-2026-10-27#Goal"
        ]
      },
      "model": "Every original round-8 population check is positively covered by an executed pass or exact provenance-valid active case downgrade in one completed passing gate run G pinned to full candidate SHA C and its accepted promotion receipt, with C an ancestor of observed main and no deleted, skipped or unmeasured check counted as passing.",
      "barKey": "R-1",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "passRatings": [
        "met"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-28T11:49:47.955Z",
        "declaredBy": "su-14d44480-1901-45bd-9a1a-9d538bc87e8c"
      },
      "method": "Pin one grading edition to full candidate C, completed gate run_group_id G, passing verdict and promotion receipts, observedAt and the observed main SHA; C must be an ancestor of main. No independent moving-cell reads or arbitrary CI rows may replace a missing accepted pass-verdict receipt. Build the immutable original population from all six plan bucket lists at round-8 base 8c03b5dc, and record its inventory/hash. Map renames to exact current paths in C, preserving checks; deletion is unmet under R-2. For every original path retain the exact path, CI test_run id, run_group_id=G, full commitSha=C and terminal executed status. Read testing:runs with source:ci, cases:true and bounded pages; the API may accept SHA prefixes/path substrings, so post-filter exact full SHA/path/group equality and exhaust pagination/coverage. Do not combine a latest-per-file result from another run or a local run. Classify each original path once as executed pass, exact case-scoped active downgrade, failed or unknown; retain population, checked, notChecked, notApplicable and explicit residue with no duplicate/omitted path. Exemptions must name their test cases and active downgrade ids at G, satisfy R-2/R-5, and never cover an entire unmeasured file by implication. All missing/skip/cancelled/running/unreadable/truncated coverage is unknown/unmet. Bound tests are mechanism regression guards only. Their passing does not establish the historical/live outcome; the independent grader must retain the pinned outcome receipts described here. Missing, unreadable, truncated or unresolved evidence is unknown, never a presumed pass.",
      "driftMarkers": "Any original path is absent from the complete G/C partition, deleted, skipped, cancelled, running, failed without an exact valid active case exemption, or supported only by a local/other-group/prefix-match row; no positive completed pass verdict/promotion receipt for C; or C is not an ancestor of observed main.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/release/frozen-repair-coverage.test.ts",
          "packages/operator-core/lib/release/promotion-ratchet.test.ts"
        ]
      },
      "requiredTestLayers": [
        "unit"
      ]
    },
    {
      "key": "r-2",
      "title": "Fixes are real repairs, not suppressions",
      "intent": {
        "request": "Each fix repairs the failing behaviour or test. None skips, focuses, deletes or loosens a test to get green.",
        "rationale": "A suppressed red ships known-broken code under a green verdict.",
        "sourceRefs": [
          "plan:frozen-lineage-red-burndown-2026-10-27#Goal"
        ]
      },
      "model": "Every plan-window repair preserves the round-8 population checks without prohibited weakening or an expectation-change or downgrade lacking its required Decision and provenance.",
      "barKey": "R-2",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "passRatings": [
        "met"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-28T11:49:47.955Z",
        "declaredBy": "su-14d44480-1901-45bd-9a1a-9d538bc87e8c"
      },
      "method": "Pin base 8c03b5dc, candidate C and the plan-window cutoff to the grading edition. Review the complete repair manifest and semantic diff for every original check and outcome-determining source/config/generated input/gitlink, including source-only repairs. Classify added-line token hits in executable context: detector-test strings/comments are not executable skips. Also inspect computed selection, removed test cases, runner exclusions, mock neutralization, assertion removal/loosening and baseline/allowlist growth; grep absence is not proof of absence. Retain each suspect hunk's classification and supporting plan Decision for a correct expectation change. Keep the unconditional skip/focus/todo/deletion ban and D-004 prohibition on resolver ALLOW additions; an implementer comment cannot authorize an exception. Census downgrade provenance separately from R-5 cleanup, including immutable row/case identity, reason, owner, bug_id and the plan Decision; missing provenance is unknown/unmet. Bound tests are mechanism regression guards only. Their passing does not establish the historical/live outcome; the independent grader must retain the pinned outcome receipts described here. Missing, unreadable, truncated or unresolved evidence is unknown, never a presumed pass.",
      "driftMarkers": "Any executable skip/focus/todo/skipIf, deleted population check, resolver ALLOW growth, unreviewed runner/mock/baseline weakening, removed/loosened assertion without a named correct-expectation Decision, or downgrade missing reason/owner/bug/Decision. A grep-only census or unclassified hit is unknown.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/release/promotion-ratchet.test.ts",
          "packages/operator-core/lib/release/frozen-repair-coverage-mutation.test.ts"
        ]
      },
      "requiredTestLayers": [
        "unit"
      ]
    },
    {
      "key": "r-3",
      "title": "Admissions and verdict runs followed the protocol: holder-only",
      "intent": {
        "request": "Every frozen-queue admission, convergence and retirement, and every checkpoint (verdict) run during this plan, on any frozen lineage, was executed by the gate-condition holder of that moment, while members prepared fixes and asked.",
        "rationale": "D-006/D-011: the door accepts only the gate-condition holder, and a single fixer avoids racing admissions.",
        "sourceRefs": [
          "plan:frozen-lineage-red-burndown-2026-10-27#D-006",
          "plan:frozen-lineage-red-burndown-2026-10-27#D-011"
        ]
      },
      "model": "Every confirmed repair-queue or checkpoint action with an accepted durable effect in the plan window has affirmative proof that its actual caller held WI-10006055 at invocation and through the effect, without credit for unowned, unequal delegated or unresolved ownership.",
      "barKey": "R-3",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "met"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-28T11:49:47.955Z",
        "declaredBy": "su-14d44480-1901-45bd-9a1a-9d538bc87e8c"
      },
      "method": "Pin the plan window 2026-10-27T17:00Z through the accepted release's actual ship time S and the serving build for each action. Enumerate candidate release:repair-queue calls with confirm:true/op admit,converge,retire and all release:checkpoint-run calls on every frozen lineage, regardless tool_invocations transport status. Correlate invocation ids/output_ref with durable audit/action receipts and actual effects; classify every call as proven-no-effect/refused, accepted effect or unresolved. Do not infer no effect from a failed transport or acceptance from status:ok. For every accepted effect retain invocation time, effect time, caller identity and affirmative contemporaneous WI-10006055 holder identity/proof at invocation and through effect. Prefer a claim-row lock held through the effect; for older serving builds identify the exact available claim/audit evidence and its limitation. A current ownership cell, door acceptance, no-linked-condition-observed receipt or signed delegate is not affirmative historical holder equality. Unowned, unequal, unavailable, unresolved or unmeasured history is unknown/unmet, with an accountable record for each residue. The bound gate-action-receipt tests verify mechanism behavior, including that door acceptance alone can admit unowned/delegated calls; they do not certify this historical census. Bound tests are mechanism regression guards only. Their passing does not establish the historical/live outcome; the independent grader must retain the pinned outcome receipts described here. Missing, unreadable, truncated or unresolved evidence is unknown, never a presumed pass.",
      "driftMarkers": "An accepted effect has caller!=actual holder at invocation or effect, an unowned/delegated action is credited, any invocation/effect remains unclassified, a failed transport is excluded without no-effect proof, or historical ownership is inferred from current state/door acceptance.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/release/gate-action-receipt.test.ts",
          "packages/operator-core/lib/release/gate-action-receipt.integration.test.ts"
        ]
      },
      "requiredTestLayers": [
        "unit",
        "integration"
      ]
    },
    {
      "key": "r-4",
      "title": "main and the deployed operator carry every fix",
      "intent": {
        "request": "The promoted candidate carrying every fix is deployed to the :3070 operator.",
        "rationale": "A green repair head that never promotes or deploys leaves the fleet frozen.",
        "sourceRefs": [
          "plan:frozen-lineage-red-burndown-2026-10-27#Goal"
        ]
      },
      "model": "The deployed release D demonstrably retains the complete actual repair closure from accepted candidate C, including outcome-determining source-only repairs.",
      "barKey": "R-4",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "deployed"
      ],
      "evidencePlane": "deployed",
      "passRatings": [
        "met"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-28T11:49:47.955Z",
        "declaredBy": "su-14d44480-1901-45bd-9a1a-9d538bc87e8c"
      },
      "method": "Derive a complete immutable repair manifest from the six original bucket completion records, subsequent repair records and plan Decisions, not only changed population test files. For each repair retain affected original outcome, repo-relative path, source commit, blob or exact hunk, source/config/generated-input/gitlink role and provenance. Reconcile actual bucket inventories against the manifest so source-only fixes and inputs whose tests did not change cannot disappear. Pin C/G from R-1, full deployed D, main SHA, deploy receipt and observedAt. Require :3070 health SHA and durable deployment receipt to agree on D, with C<=D<=observed main by verified ancestry. For every manifest entry compare retained repair content in C and D, resolving submodules through each superproject gitlink. Differing blobs/hunks require explicit independently reviewed replacement/continued-behavior evidence or the relevant regression check executed at D; a later commit or ancestor relationship alone is insufficient, including reverts. Partition the manifest completely into retained, reviewed replacement, missing or unknown; retain an owner for every residue. Bound tests are mechanism regression guards only. Their passing does not establish the historical/live outcome; the independent grader must retain the pinned outcome receipts described here. Missing, unreadable, truncated or unresolved evidence is unknown, never a presumed pass.",
      "driftMarkers": "Any actual source/config/input/gitlink/test repair is missing from the manifest, not retained in C/D, reverted without replacement proof, unresolved inside a gitlink, or credited from ancestry alone; deployed health/receipt SHA disagreement; unproved C<=D<=main.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/release/judged-sha-containment.test.ts"
        ]
      },
      "requiredTestLayers": [
        "unit"
      ]
    },
    {
      "key": "r-5",
      "title": "Temporary downgrades are revoked once main carries the fixes",
      "intent": {
        "request": "Every test downgrade recorded during this burn-down is revoked once its trigger holds, and the revoked case then passes without it.",
        "rationale": "A downgrade is a temporary, owned exemption; leaving it active hides future regressions.",
        "sourceRefs": [
          "plan:frozen-lineage-red-burndown-2026-10-27#D-007",
          "plan:frozen-lineage-red-burndown-2026-10-27#D-008"
        ]
      },
      "model": "Every measured-due downgrade in the pinned plan window has exact-case executed-pass proof from the first applicable completed gate run following its durable revocation.",
      "barKey": "R-5",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "requiredTestLayers": [
        "unit",
        "integration"
      ],
      "passRatings": [
        "met"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-28T11:49:47.955Z",
        "declaredBy": "su-14d44480-1901-45bd-9a1a-9d538bc87e8c"
      },
      "method": "Pin the accepted release ship time S, grading observedAt T and full candidate/run identities. Census every papercusp-workspace/papercusp test_downgrades row whose active interval overlaps 2026-10-27T17:00Z..S, including rows later revoked and newly added rows; do not hard-code only ids1-5. Retain row id, exact test_file/test_case, reason, owner, bug_id, creating Decision, createdAt/revokedAt, immutable fix/trigger commit or reviewed content reference and measured trigger time. Preserve existing Decisions and known triggers: row1 promoted candidate containing the schema-dedup fix at/after df4b418; row2 main containing a771bcbf59; rows3-5 use immutable commit/blob references recovered from their repair receipts rather than mutable 'tip fix'. Any further row must have its own Decision and immutable trigger rule. For each trigger measured held by T retain the revoke tool/audit receipt and time, then the first applicable completed gate run after revocation selecting that exact case. Read testing:runs cases:true/test_case_runs with exact CI run/full SHA/path/case equality and prove executed pass with no active covering downgrade at the run. A file pass does not prove the case ran; missing next run/case or incomplete row/case census is unknown. For not-yet-due rows record measured trigger state, responsible owner and typed follow-up without premature revocation or cleanup credit. The four subject tests guard the tree repairs; test-downgrade-store.integration.test.ts guards revoke/listActive/isTestBlocking; actual row/case receipts establish live cleanup. Bound tests are mechanism regression guards only. Their passing does not establish the historical/live outcome; the independent grader must retain the pinned outcome receipts described here. Missing, unreadable, truncated or unresolved evidence is unknown, never a presumed pass.",
      "driftMarkers": "A due row remains active, lacks an immutable trigger or revocation receipt, or its exact case is absent/skipped/failing/covered by another downgrade after revocation; an overlapping row is omitted; not-yet-due rows receive cleanup credit or lack an accountable measured follow-up.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/agent-tools/omp-seed-wire-budget.test.ts",
          "packages/operator-core/lib/sync-resolver/no-heavy-io-on-read-path.test.ts",
          "packages/operator-core/lib/task-manager/no-unenrolled-spawn-guard.test.ts",
          "packages/operator-core/lib/templates-mirror-sync-cli.test.ts",
          "packages/operator-core/lib/release/test-downgrade-store.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-6",
      "title": "Admissions followed the protocol: ledgered skipPrecheck",
      "intent": {
        "request": "Every skipPrecheck admission on any frozen lineage during the plan window recorded its reason, and the repair head it produced was later judged by CI.",
        "rationale": "An admission that skipped the precheck must record why, and the repair head it produced must still be judged by CI.",
        "sourceRefs": [
          "plan:frozen-lineage-red-burndown-2026-10-27#D-006",
          "plan:frozen-lineage-red-burndown-2026-10-27#D-011"
        ]
      },
      "model": "Every accepted skipPrecheck admission has a verification receipt containing its non-empty precheckReason plus completed affected-check coverage at the qualifying next-round measurement head.",
      "barKey": "R-6",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "met"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-28T13:37:51.019Z",
        "declaredBy": "su-14d44480-1901-45bd-9a1a-9d538bc87e8c"
      },
      "method": "Interpret 'the next verify round is the measurement' cumulatively as in D-002/D-003; this proposed contract change requires explicit outside-lineage approval before application, not silent relaxation of rev5's exact-head wording. Pin window 2026-10-27T17:00Z..accepted ship time S. Enumerate confirmed skipPrecheck admissions on all frozen lineages regardless transport status; correlate durable admission/effect receipts, args_json precheckReason and output_ref. Exclude only proven-no-effect refusals; unresolved effects are unknown. For every accepted admission retain invocation/effect time, full head H, candidate identity and exact admitted path/blob/hunk/gitlink closure. Retain the next applicable completed gate run G on H or a cumulative successor J. A successor is admissible only with per-path closure-retention/reviewed replacement proof and actual G coverage of the admission's affected checks; ancestry or a started/aborted run alone is insufficient. Record exact source:ci full SHA/group/case identities and terminal measurements. A completed red G can satisfy judged but never final acceptance under R-1. Partition every admission into reason+completed coverage, deficient reason, uncovered or unknown, with accountable residue. Tool status ok does not establish admitted or measured. Bound tests are mechanism regression guards only. Their passing does not establish the historical/live outcome; the independent grader must retain the pinned outcome receipts described here. Missing, unreadable, truncated or unresolved evidence is unknown, never a presumed pass.",
      "driftMarkers": "Any accepted skipPrecheck admission lacks a reason or completed covered verification; successor content/affected-check coverage is unproved; a running/aborted/unrelated/ancestry-only run is credited; transport failures hide effects or admission census is incomplete.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/release/frozen-repair-verification-history.test.ts",
          "packages/operator-core/lib/release/frozen-repair-coverage.test.ts"
        ]
      },
      "requiredTestLayers": [
        "unit"
      ]
    }
  ],
  "reason": "Respond to independent critique thread-post:1210055 of rev5/hash 655264e416df9025aaba2c7e105a425d69ceca5fd7b64b9eb2e2d3db0462d8cc. Require positive single-run coverage, actual all-repair containment, affirmative holder equality at invocation and effect, case-level downgrade cleanup with a live plane, and completed retained-closure cumulative measurement consistent with D-002/D-003. Preserve all six outcomes and prohibitions. This preview explicitly requests independent contract approval, including the R-6 exact-head-to-proven-cumulative-successor change; no historical success is asserted. Complete exact draft: artifacts:load {slug:'papercusp',rel_path:'reviews/frozen-acceptance-critique-1210055-edition6.json'}; inspect this record if inline review patch is truncated.",
  "expectedRubricRevision": 5,
  "expectedSubjectPlanRevision": 51,
  "idempotencyKey": "frozen-acceptance-critique-1210055-edition6",
  "dryRun": true
}
