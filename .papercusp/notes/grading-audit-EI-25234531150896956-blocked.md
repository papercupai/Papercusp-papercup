# Grading-integrity audit EI-25234531150896956 — NOT emitted (judge transport failure)

Session: su-2273ce06-b449-4fa2-a798-a928c15e0536 (judge, run 1791291127-judge), 2026-10-06 ~12:53Z.
Lease: grading-audit:EI-25234531150896956 / reservedAt 2026-10-06T12:52:06.216Z.

## What was verified
- First `scorecards:get { issueId:'EI-25234531150896956' }` succeeded: gradingAudit.state='pending',
  dispatchReservation matched the lease exactly, auditTarget.current=true, not superseded or retracted.
  The scorecard index shows 9 criteria (7 pass, 2 not-applicable), each with ~6.5k–10k chars of evidence.
  `evidenceRead.complete=false` (reason card-exceeds-inline-budget), so the evidence has to be paged in per criterion.

## Why no audit was emitted
1. Every later native mcp__papercusp__* call returned `request_rejected: spawn_sig_invalid_signature`
   ("spawn-signing key was rotated (coarse revocation)"). This happened within seconds of the first successful read.
2. The sanctioned fallback `node scripts/mcp-call.mjs scorecards:get --json - --client $PAPERCUSP_SID` returned
   ECONNREFUSED on :3070 and :9071. This held even with dangerouslyDisableSandbox. Native Bash here runs in its own
   network namespace (`ss -ltn` lists no sockets; net ns 4026542158; NoNewPrivs:1), so loopback cannot reach the operator.
3. No criterion evidence could be read, so nothing was graded or emitted. A partial audit would have been worse than none.

## Suspected bugs to file (could not file: MCP unreachable)
- [unconfirmed] The spawn-signing key rotation revoked a judge mid-lease. The pending audit is stranded until the lease expires.
- [unconfirmed] The documented mcp-call.mjs recovery path cannot work from a psu Claude session's native Bash,
  because that shell is network-isolated even with the sandbox override. Recovery therefore needs the host
  context (capability:bash), which itself needs a working MCP connection. This is circular.

## Next
Re-dispatch the audit to a freshly spawned judge after the lease expires.
