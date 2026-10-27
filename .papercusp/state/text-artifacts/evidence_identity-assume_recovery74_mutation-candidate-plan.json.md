---
rel_path: "evidence/identity-assume/recovery74/mutation-candidate-plan.json"
updated_at: 1792980564619
_body: "content"
---

{
  "plan": "agent-assume-identity-2026-10-23",
  "planRevision": 22,
  "rubric": "acceptance-agent-assume-identity-2026-10-23",
  "rubricRevision": 7,
  "scope": "Recovery74 preparation only; no source edits, new tests, mutation overlays, native launches or BAR amendments",
  "basis": [
    "Recovery73 canonical current-adequacy.json and native14-currentness.json",
    "Current rubric7 BAR text read during Recovery74",
    "Maintained assume.test.ts titles and R2/R5/R6 assertions inspected",
    "Historical mutation descriptors inspected from canonical21986975,21986983,21987712,21987715,22006737"
  ],
  "preconditions": [
    "Confirm latest source and actual guard invocation before writing each overlay.",
    "Use maintained mutation-probe.sh committed-source copy-out workflow and its real ledger; preserve ordinary/copy baselines and distinguish parser/harness failures from assertion catches.",
    "Bind only genuinely clause-relevant caught mutants to current named successful tests; do not bulk relabel authored-clause mutants.",
    "Native22090027 is historical baf13de7 after psu-pty-host seven-line change; new current native evidence is still required. Original22067750 cause remains unconfirmed."
  ],
  "rows": [
    {
      "bar": "R-1",
      "guardFile": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
      "guardCase": "R-1 reject unrelated-window and env-only fake takeover",
      "subjectFile": "packages/operator-core/lib/session-assume.ts",
      "candidateBoundary": "qualifiesAssumeExecution",
      "candidate": "Remove one exact managed attachment equality check, then verify the named refusal guard catches wrong attachment evidence. Preserve the D-002 invoking-response/fresh-native-completion acceptance case separately.",
      "status": "candidate only; no new mutation executed or certified"
    },
    {
      "bar": "R-2",
      "guardFile": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
      "guardCase": "R-2 target inbox and task routing spans before during and after cutover",
      "subjectFile": "packages/operator-core/lib/session-assume.ts",
      "candidateBoundary": "qualifiesAssumeExecution",
      "candidate": "Allow directed-message recipient/consumer attribution to the caller instead of the target; the named wrong-recipient/wrong-consumer controls must reject it.",
      "status": "candidate only; no new mutation executed or certified"
    },
    {
      "bar": "R-3",
      "guardFile": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
      "guardCase": "R-3 unavailable corrupt stale and incompatible context refuses without fallback",
      "subjectFile": "packages/operator-core/lib/session-assume.ts",
      "candidateBoundary": "prepareAssume / validateAssume",
      "candidate": "Inspect the exact context-mode and digest branches before authoring an overlay that admits fallback or stale context. Require an assertion failure in the named context refusal guard.",
      "status": "candidate only; no new mutation executed or certified"
    },
    {
      "bar": "R-4",
      "guardFile": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
      "guardCase": "R-4 two callers race one target with one unchanged loser",
      "subjectFile": "packages/operator-core/lib/session-assume.ts",
      "candidateBoundary": "commitAssume / reserveAssumeTarget",
      "candidate": "Existing historical mutant22006737 removes reservation-acquired refusal but used the native guard. Inspect/reuse its descriptor against the current named core race guard; do not claim that historical native mutant current.",
      "status": "candidate only; no new mutation executed or certified"
    },
    {
      "bar": "R-5",
      "guardFile": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
      "guardCase": "R-5 nonempty caller work and return reference survive handoff failure",
      "subjectFile": "packages/operator-core/lib/session-assume.ts",
      "candidateBoundary": "commitAssume",
      "candidate": "Inspect recovery receipt assignment and failure restoration; a candidate overlay drops the retained return reference/recovery receipt. Verify the named nonempty caller restoration assertions catch it.",
      "status": "candidate only; no new mutation executed or certified"
    },
    {
      "bar": "R-6",
      "guardFile": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
      "guardCase": "R-6 accepted requires later process and routed probe verification",
      "subjectFile": "packages/operator-core/lib/session-assume.ts",
      "candidateBoundary": "commitAssume / verifyAssumeExecution",
      "candidate": "Candidate: promote handoff-accepted to target-verified without the later observations. Named test explicitly rejects this premature state.",
      "status": "candidate only; no new mutation executed or certified"
    },
    {
      "bar": "R-8",
      "guardFile": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
      "guardCase": "R-8 crash after target custody before exec or verification converges on retry",
      "subjectFile": "packages/operator-core/lib/session-assume.ts",
      "candidateBoundary": "reconcileAssumeTransition",
      "candidate": "Inspect current reconciliation branches, then choose an overlay that loses custody or claims verification during the interrupted window; guard must catch the unsafe convergence.",
      "status": "candidate only; no new mutation executed or certified"
    },
    {
      "bar": "R-9",
      "guardFile": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
      "guardCase": "R-9 commit rechecks administrative authority and reviewer restrictions",
      "subjectFile": "packages/operator-core/lib/session-assume.ts",
      "candidateBoundary": "prepareAssume / validateAssume",
      "candidate": "Candidate: bypass the current administrative authorization recheck in a private copy only. Require the named unauthorized/reviewer controls to fail; D-008 remains unchanged.",
      "status": "candidate only; no new mutation executed or certified"
    },
    {
      "bar": "R-10",
      "guardFile": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
      "guardCase": "R-10 tampered mismatched or non-target checkpoint refuses before custody",
      "subjectFile": "packages/operator-core/lib/session-assume.ts",
      "candidateBoundary": "validateAssume",
      "candidate": "Inspect target-bound context equality/hash checks before choosing one to bypass. Require the named tampered/non-target negative control to catch it.",
      "status": "candidate only; no new mutation executed or certified"
    },
    {
      "bar": "R-11",
      "guardFile": "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
      "guardCase": "R-11 takeover audit retains caller target authorization and terminal provenance",
      "subjectFile": "packages/operator-core/lib/session-assume-store.ts",
      "candidateBoundary": "production audit append path; inspect before patching",
      "candidate": "Use the real-PG audit guard for an actor/custody attribution mutation. Read the actual audit writer and confirm this exact maintained selector before authoring an overlay.",
      "status": "candidate only; no new mutation executed or certified"
    },
    {
      "bar": "R-12",
      "guardFile": "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
      "guardCase": "R-12 preview preserves caller and target runtime and durable snapshots",
      "subjectFile": "packages/operator-core/lib/agent-tools/session/assume.ts",
      "candidateBoundary": "preview handler; inspect before patching",
      "candidate": "Read the actual public preview path and confirm integration fixture invokes it. Choose a mutation introducing a durable effect on preview only if that maintained guard exercises the writer; otherwise record the guard gap instead of fabricating proof.",
      "status": "candidate only; no new mutation executed or certified"
    }
  ]
}
