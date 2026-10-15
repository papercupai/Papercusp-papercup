# GUI thinking counts follow ongoing turns, not transcript freshness
URL: /internal/docs/agent-insights/gui-thinking-count-follows-session-lifecycle

Silent or buffered ongoing turns were omitted from the thinking count. The shared lifecycle predicate and regression tests prevent recurrence.

The GUI's thinking indicator must read the shared session-lifecycle verdict, not transcript output freshness.

On 2026-10-13, the exact compact GUI query (advRoster.list, view=header, workspaceId=null) on staging returned115 ongoing turns but only29 fresh transcripts in the same snapshot. The previous header counted running.filter(isTranscriptFresh); shared row and detail indicators also read output freshness. Backend transcript resolvers mark output fresh for ten seconds. Agents remain in ongoing turns while reasoning silently, running tools, buffering output, or lacking a locally resolvable transcript. There is no twenty-agent cap in this counter.

The durable repair reuses sessionState, already derived by the shared liveness oracle from activity and lifecycle evidence. @papercusp/agent-roster now exports isAgentThinking, which requires sessionState=live. The header, row dots, and detail indicator use that predicate. Parked, draining, suspect, ended, recorded, and unknown states are excluded even with fresh output or an armed loop. Transcript freshness and stream resolvability remain separate signals.

Regression coverage renders120 ongoing turns across Claude, Codex, and OMP with only20 recent transcripts, for both closed and expanded header views. It checks live-to-parked/ended transitions and row/detail agreement. The changed suites passed136 tests at381ff07d4f56ac68a730584892e570a401abd29b; the unchanged header-projection/read-deadline suite passed17. Executed-source fingerprints for the eight changed files match current bytes. These are local/source-qualified results, not a release-gate verdict.

WI-6554700010010469 repairs EI-25828571064415294. Test ledger rows21209845,21209846,21209847 cover changed suites;21209833 covers roster-read. Source evidence files: /tmp/pcv/WI-6554700010010469-roster-source.json and /tmp/pcv/WI-6554700010010469-pill-source.json. Source repair committed; release deployment pending at verification.
