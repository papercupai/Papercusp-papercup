---
rel_path: "audits/held-agent-resumption-2026-10-12/auto-resumed-status-2026-10-20-corrected.md"
updated_at: 1792495870859
_body: "content"
---

# AUTO recovery resumed — 2026-10-20

Avi, AUTO is enabled for the existing held-agent recovery scope. This session is implementing and coordinating the recovery directly. A bounded warm work loop is armed every five minutes, for up to 24 wakes or four hours; its first check reported rewakeGuaranteed=true. A later check returned false (last-fire-parked) while this native session remained active. All held-item state has been saved, and a managed carry-respawn is the selected continuation route.

The original saved roster remains 207 agents with confirmed activity or replies, 57 unconfirmed targets, and 54 exclusions. These are retained recovery-receipt classifications, not a live activity gauge. A fresh census read every one of the 57 primary work items and current targeted presence: 33 open, 13 blocked, four wip, two needs-human, four done and one dropped. Fifteen nonterminal primary tasks are now unassigned or held by a different agent. Their current custody is preserved. Terminal state alone was not counted as a new original-agent reply.

Eighteen targets still hold their original nonterminal item and have parked/wakeable presence. Their saved next actions were refreshed. Two with concrete source fixes received bounded resume requests: EI-25553824038716206 (operational-brief blocked-state precedence) and EI-25561320530819600 (queued wake reconciliation). Exact wake deliveries 912241 and 912242 report delivered through psu-socket-inject. Original-agent productive pickup is still unconfirmed; no replacement session, active-writer override or duplicated claim was attempted.

The thinking-counter follow-up EI-25828571064415294 is now closed with committed completion authority. Existing implementation WI-6554700010010469 fixed the transcript-freshness undercount. Current source uses authoritative ongoing-turn state and distinguishes thinking from living/running sessions. Current maintained tests passed: **144 passed, zero failed, zero skipped** across shared roster logic and the header UI; ledger runs 21437685 and 21437687, execution 01e8cacf-d365-43eb-a024-b354df89dcb5. Tests include 120 ongoing turns with only 20 fresh transcripts, 200 living sessions, silent reasoning and parked/ended transitions. Separate release/runtime acceptance remains owned under WI-6554700010012361; final deployment is not claimed.

Four existing claims remain with this session: the recovery parent, the agent-review rubric routing item, the historical fork investigation and the historical transport investigation. The hydration regression remains completed. No credentials were touched, no live gate lane was taken, and no protected 1e14 writer was restarted.

Sources in the papercusp PG artifact store, under audits/held-agent-resumption-2026-10-12/: auto-current-census-2026-10-20.json; auto-ready-continuations-2026-10-20.json; auto-directed-recovery-2026-10-20.json; auto-wake-diagnostics-2026-10-20.json. Exact readbacks were verified. The full original 19-proof/14-owner/26-message guard remains required before any aggregate replacement. The next work unit is to qualify remaining current recovery routes and original-identity pickup, while keeping terminal and reassigned work out of duplicate resumption.

[Previous verified recovery report](/reports?sel=rpt_0f082224-05f9-42e9-bb19-31bafdaafc9a). Earlier report URLs remain preserved.

