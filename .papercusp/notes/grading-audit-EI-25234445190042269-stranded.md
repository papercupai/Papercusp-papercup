# Grading-integrity audit of EI-25234445190042269 — NOT emitted (judge su-849c14dd, 2026-10-06 ~12:53Z)

Status: lease `grading-audit:EI-25234445190042269` (reservedAt 2026-10-06T12:50:43.614Z) is STRANDED. No audit was emitted.
The target still needs a fresh auditor once this lease lapses.

## Why (suspected BUG — please file as improvements:capture kind:bug; I could not reach any capture surface)
1. Partway through the audit, every native `mcp__papercusp__*` call began returning
   `request_rejected: spawn_sig_invalid_signature` (spawn-signing key rotated). Retrying did not help.
2. The error message's prescribed recovery, `node scripts/mcp-call.mjs ... --client "$PAPERCUSP_SID"`, is
   UNREACHABLE from this session's native Bash. Port 3070 and port 9071 both returned ECONNREFUSED.
   `curl 127.0.0.1:3070/api/health` and `curl 127.0.0.1:3170/api/health` both returned `000`. `ss` showed no listener.
   `/proc/self/status` showed `NoNewPrivs: 1`, and the result was the same with dangerouslyDisableSandbox:true.
   This matches CLAUDE.md's note that the psu native-Bash sandbox unshares the network.
   As a result, the key rotation leaves a judge with NO working route. The claimed lease is stranded,
   which is the EI-1758 zombie class. Either the recovery runbook or the sandbox needs fixing.

## Partial findings (for the next auditor — re-verify, do not trust)
- At 12:51Z gradingAudit.state was pending, the reservation matched, and auditTarget.current was true
  (not superseded or retracted).
- Applicable ratings: 7 pass (traceability, falsifiability, correct-layer, oracle-independence,
  execution-integrity, freshness, plan-class-risk-floor). Not-applicable: fixture-calibration, disclosed-gap.
  There are no downgrades, so the ALL-PASS override applies and every applicable probe must be re-run.
- All 9 criterion evidence strings embed the SAME probe. `plans:evaluate-spec-test-adequacy` args parse
  as valid JSON; only one distinct args string was found. Each ends with `; inspect rows[0].ratings["<key>"]`.
  The args include `replaySnapshot:true`, `evaluatorBuild d740fc3802`, and specRevision 3 with fingerprint 193ec9fc…
- The cited bindings are:
  - 26530 mutation, testRun 20834234, caught
  - 26516 operational, `docs/evidence/agent-multi-desktops-grid-2026-10-06/live-local-run.json`, testRun 20839130
  - 26529 e2e, `apps/operator/e2e/desktop-grid-local.spec.ts`, testRun 20838352
  - 26528 unit, `desktop-thumbnail.test.ts`, testRun 20838212
  - 26507 unit, `local-desktop-thumbnail.test.ts`, testRun 20834750
- NOT verified:
  - the probe re-run itself
  - whether `plans:get-specs` requiredEvidence for AUTO-BAR-R-5-P-005@3 includes `fixture`. If it does,
    the not-applicable rating on fixture-calibration is suspect (instrument-split precedent EI-25213860915355901).
  - the test_runs ledger rows for the cited testRunIds
