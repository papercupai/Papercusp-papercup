### Push-leg table (pinned copy of code-intel-delivery-and-outcomes-2026-10-26 ## Design; R-7)

This is a byte copy of the plan's push-leg table. `native-adoption.test.ts` pins it to the code map
(`LEG_OUTCOME_TABLE`, `CANNOT_OBSERVE_LEGS`) and to `PUSH_LEG_DESIGN_TABLE_SHA256`; the scheduled
`code-intel:leg-outcomes` instrument fails when the live plan table hashes differently. Edit the plan,
this copy, the hash and the code map together.

| leg | flag | independent eligible-trigger source (R-1) | result key (R-7) | control population (R-7; D-014, D-027) |
|---|---|---|---|---|
| grep | CODE_INTEL_PUSH_GREP | Grep/Bash search rows in tool_invocations or agent_activity whose pattern is a declaration or identifier-call lookup: after stripping regex escapes and anchors it holds a declaration keyword (function, class, interface, type, const, let or enum) followed by one identifier, or one identifier followed by an opening parenthesis; the identifier is at least 3 characters of letters, digits, _ or $ (D-013) | time to first correct edit | none: not an avoided key |
| first-touch | CODE_INTEL_PUSH_FIRST_TOUCH | first Read or Edit of a symbol's file under a claimed work item (tool_invocations joined to the claim) | time to first correct edit | none: not an avoided key |
| interface | CODE_INTEL_PUSH_INTERFACE | Edit/Write rows that touch an exported signature, joined to another agent's live lock or coord_presence.current_files | interface follow-through rate | none: no holdout share and no unexposed window, so the avoided key is renamed to the follow-through rate it measures (D-027) |
| incident | CODE_INTEL_PUSH_INCIDENT | Edit of a file attributed to an open condition in coord_conditions | gate reds avoided | pre-exposure baseline: the 7 days before the leg's first push, or before the scored window when it has none (D-027) |
| completion | CODE_INTEL_PUSH_COMPLETION | work_items:complete calls in tool_invocations | gate reds avoided | pre-exposure baseline: the 7 days before the leg's first push, or before the scored window when it has none (D-027) |
| clone | CODE_INTEL_PUSH_FIRST_TOUCH (shared) | edit_attribution_ledger rows that add a new exported function | clones avoided | pre-exposure baseline: the 7 days before the leg's first push, or before the scored window when it has none (D-027) |
| antipattern | CODE_INTEL_AST_GREP | Edit/Write rows on files inside the ast-grep rule scope | gate reds avoided | pre-exposure baseline: the 7 days before the leg's first push, or before the scored window when it has none (D-027) |
| intent | CODE_INTEL_PUSH_INTENT | coord:declare-intent calls with current_files in tool_invocations (no hook leg; read via recordIntentTaskBrief) | time to first correct edit | none: not an avoided key |
| resume | CODE_INTEL_PUSH_RESUME | session resumes and carry-respawns that hold a work item (agent_activity) | time to first correct edit | none: not an avoided key |
| notes | CODE_INTEL_PUSH_NOTES | first Read of a file that carries notes, under a claimed work item | cannot-observe: a notes push restates a peer's prose; no ledger records whether the recipient acted on it, and its effect cannot be separated from the first-touch push in the same turn | none: cannot-observe |
