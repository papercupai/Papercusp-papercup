# Grading-integrity audit EI-25957680877145643 — BLOCKED (no verdict emitted)

- Auditor session: su-e7854f7d-6123-41be-a327-ee083ea186ae (judge role, headless launch)
- Observed: 2026-10-14T13:06Z (UTC)
- Lease in kickoff: key `grading-audit:EI-25957680877145643`, reservedAt `2026-10-14T12:26:14.499Z`
- Target: spec-test-adequacy card EI-25957680877145643, subject
  `native-code-intelligence-ecosystem-and-dream-2026-10-09#AUTO-BAR-R-20-P-025@2`,
  fingerprint `3562f1aa97cfa61bd4728e1edaaaa38c2c6c28632be863b78d7278f5bcb928c2`

## What blocked it (observations, not an inferred cause)

1. This session's `papercusp` MCP server was reported disconnected. After the server
   re-sent its instructions, tool search still returned no `papercusp` tools
   (`scorecards`, `coord`, `events`, `code:run` all absent).
2. The sanctioned fallback `node scripts/mcp-call.mjs scorecards:get` exited 4 with
   ECONNREFUSED on ports 9171, 3070 and 9071. It failed both inside and outside the
   Bash sandbox.
3. `curl /api/health` on 9071, 9171, 3070 and 3170 returned 000. `ss -ltn` lists **zero**
   listening sockets, and the process is in netns `net:[4026542684]` with NoNewPrivs=1.
   So this session's shells run in an isolated network namespace and cannot reach loopback
   operator ports. This tells us nothing about whether the operator itself is up.

4. Re-probed at 2026-10-14T13:25Z, after the "directed mail unread ~21m" inbox wake
   (delivery #799341). Same results: no `papercusp` tools after the server re-sent its
   instructions, health 000 on all four ports, zero listeners, now in netns
   `net:[4026542757]`. The directed mail is still unread because this session cannot read
   `coord:inbox`.

5. At 13:40Z the network route came back and `mcp-call.mjs` worked. The audit is still blocked,
   now for a different reason. `scorecards:get` reads pending and current, but
   `dispatchReservation.reservedAt` is `2026-10-14T12:43:31.020Z`. That is not the kickoff lease and
   not the 12:43:21Z "Resume retained" notice, which both say 12:26:14.499Z. The inbox from
   06:40 to 13:43Z has no "Renewed grading-audit lease" notice, so the start rule says stop.
   The evidence is a comment on EI-25962558306827679, which already tracks this bug; the
   tool-loss bug is EI-25962516755434135. The reply to su-2245b010 is msg
   coord-send-f6aa6854…deee3.

## Consequence

- The currentness guard (`scorecard.gradingAuditCurrentness.state`) could not be read. Per the
  brief, nothing was graded and no `scorecards:emit` was issued. The target stays `pending`
  for this auditor's side, so a re-dispatch is safe.
- The bug could not be filed with `improvements:capture` because no MCP route was reachable.
  Whoever reads this: please file it as a judge-launch defect. A headless judge was
  launched with an MCP client that has no tools, and its shell has no route to :9071, so the
  documented mcp-call recovery path cannot work from inside the session.
