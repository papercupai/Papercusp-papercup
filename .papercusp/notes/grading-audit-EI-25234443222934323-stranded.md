# Grading-integrity audit of EI-25234443222934323 — STRANDED (not emitted)

Run 1791291043-judge (client su-b7e0f63b-dde6-4bc7-88a3-ce2abc187aec), 2026-10-06 ~12:51–12:53Z.
Lease: grading-audit:EI-25234443222934323 reservedAt 2026-10-06T12:50:41.777Z.

## State at last successful read (12:51Z)
gradingAudit.state=pending, dispatchReservation matched the lease, auditTarget.current=true,
not superseded or retracted. NO audit was emitted, so the target is still pending and needs a fresh dispatch.

## Why it stranded (bugs to file; this session had no working channel to file them)
1. All native mcp__papercusp__* calls began returning `request_rejected: spawn_sig_invalid_signature`
   ("spawn-signing key was rotated (coarse revocation)") about 1 minute into the audit, while this judge
   held an active grading-audit lease. Retrying did not help. A key rotation that revokes in-flight lease
   holders strands their audits until the lease expires.
2. The sanctioned fallback `scripts/mcp-call.mjs` cannot reach the operator from the judge's native Bash:
   it got ECONNREFUSED on 3070 and 9071. curl /api/health returned 000 on 9071, 3070 and 3170, and
   `ss -ltn` showed no listeners. `ip link` showed only `lo`, so this Bash runs in its own network
   namespace even with dangerouslyDisableSandbox. Memory c3a9923e / 99a4d94a describe the same namespace
   issue. Result: the EI-1758 recovery ladder ends at nothing for a judge.

## Partial reading for the successor auditor (UNVERIFIED; not a grade)
- The card has all-pass applicable ratings: 7 pass, plus fixture-calibration and disclosed-gap rated not-applicable.
  So the re-runnable-evidence all-pass override applies: re-run EVERY applicable probe.
- I read the full traceability evidence (9985 chars). It lists 7 bindings: 26551 mutation (test-run 20839225 @728748a08564+dirty),
  26515 operational (live-local-run.json, run 20839130), 26503/26531/26504/26505 test (ledger commit 41d57f68, dirty=true), and "+1 more"
  (26532 apps/operator/e2e/desktop-grid.spec.ts, present in current[]). The verbatim probe is plans:evaluate-spec-test-adequacy
  with replaySnapshot:true, a 7-row current[], specRevision 3 and specFingerprint 0a1c88cd…f613; then inspect rows[0].ratings[key].
- For fixture-calibration, falsifiability and correct-layer I read only the opening text and the differences from traceability.
  I did NOT read oracle-independence, execution-integrity, freshness, plan-class-risk-floor or disclosed-gap.
- Check before grading: plans:get-specs for AUTO-BAR-R-4-P-006@3 requiredEvidence. If it includes `fixture`,
  then fixture-calibration=not-applicable with zero fixture bindings should fail instrument-split (memory 20349597 / 8091fa5c).
