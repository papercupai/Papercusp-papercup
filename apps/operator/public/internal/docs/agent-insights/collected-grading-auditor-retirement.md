# Collected grading auditor retirement runbook
URL: /internal/docs/agent-insights/collected-grading-auditor-retirement

Diagnose a recovered judge blocked by dead task-ledger owners and persist collected task retirement through the canonical store without weakening the responder fence.

A recovered judge can finish its independent audit but have emission refused because another active source responder is recorded. Diagnose the exact authority branch before dispatching another judge.

1. Read the source scorecard and exact dispatch reservation. In scorecards.ts, an active consult matching the issue, reservation key and reservedAt takes precedence. Without one, every matching raw pending/running direct-launch task must name the emitting owner. The refusal text alone does not distinguish these branches.
2. Compare the matching task-ledger rows with `processes:list { taskId, live:true, includeEnded:true }`. A raw running row can be reported as ended\_unobserved by the kernel-backed inventory. Do not interpret a missing log as proof of death.
3. Use processes:kill with the exact old task id when retirement is justified. already\_gone means the specific managed scope was independently confirmed collected, not that an observed successful exit was recorded. Never use a recycled PID or weaken the responder fence.
4. The grading dispatcher routes retirement through retireGradingAuditTask. On already\_gone it calls canonical markEndedUnobserved, then reads the row again. A still-nonterminal row blocks replacement. The store uses ended\_at compare-and-set, so an observed terminal result that wins the race is preserved. No second logical retirement ledger exists.
5. Preserve a viable existing judge and its exact lease. After stale authority is repaired, request that judge re-read currentness and re-emit its preserved verdict. A queued wake alone does not prove pickup. Verify the source audit settles before closing dependent work.

Incident EI-26785604510038298: an earlier repair counted a collected task as retired but left its raw state running. That old owner fenced the replacement judge. Canonical closure changed one old row; the existing judge then emitted audit EI-26786608428319272, passing source EI-26782518034230943 and permitting P003 completion. This case involved no consult cursor.

Regression coverage is in grading-integrity.test.ts: collected-row closure before replacement, a racing observed exit, and refusal when terminal persistence fails. Run `npm run test:file -- packages/operator-core/lib/grading-integrity.test.ts`. If HEAD moves, preserve executed-source-map evidence; do not stamp the new HEAD onto an old test result.
