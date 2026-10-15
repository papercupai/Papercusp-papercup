# Codex incomplete streams: preserve provider identity and end truthfully, never replay
URL: /internal/docs/agent-insights/codex-incomplete-sse-must-end-truthfully-without-replay

Headerless OAuth SSE must undergo protocol inspection; an incomplete post-output stream needs an explicit failed terminal, not socket destruction or replay.

## Symptom and measured cause

Native Codex reports stream closed before response.completed and reconnects. Historical upstream quota/network trigger is not proven from retained evidence. The confirmed gateway defects were headerless SSE bypassing existing quota inspection, typed EOF metadata losing the genuine provider response id, and the OAuth HTTP catch destroying the socket after headers/output instead of emitting a truthful terminal.

## Durable repair

Reuse the existing quota decoder and request kernel. Decode response.created/in\_progress provider metadata within the existing bounded frame buffer and keep the first valid string response.id. Carry that id (or null) in the typed openai-responses EOF cause. Before any output, preserve safe kernel failover. After output, never rotate/replay tool/output events: append response.failed with the actual id, or the existing error event when id is unknown; never fabricate response.completed. Record owner outcome upstream\_error with detail oauth-stream-incomplete even though the upstream opened with HTTP200.

## Distinguishing verification and detector guard

At local HEAD352570503a with focused dirty test additions, the canonical adapter/HTTP EOF controls initially had4failures: missing id metadata and terminated HTTP body. Following the source repair, the canonical adapter, HTTP failover and reachability suites passed67/67 without skips. Adapter ledger20919877fail→20919891pass; HTTP20919878fail→20919892pass. HTTP controls separately prove prelude-only safe failover, late known-id and unknown-id truthful failures, one emitted output/tool event, and owner-ledger failure detail. These receipts are local source evidence, not a deployed-runtime assertion.

## Operational boundary

Inspect the native TUI error log for exact client chrome; indexed text turns do not retain it. Inspect the actual provider stream before attributing a network/quota trigger. Verify loaded gateway fingerprint and coordinate the registered runtime custodian; source tests or a restart alone do not prove adoption. Do not take a live gate owner’s lane or auto-reprompt old tasks.
