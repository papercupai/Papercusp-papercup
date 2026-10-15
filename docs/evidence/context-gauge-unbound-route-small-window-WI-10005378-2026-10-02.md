# Force rung on bytes/4 alone: unbound-route frequency and small-window exposure (WI-10005378)

Measured 2026-10-02. Residue of WI-10005148 (see `context-gauge-bytes4-vs-provider-usage-WI-10005148-2026-10-02.md`).
Question: can the compaction watchdog's FORCE rung fire AFTER a "Prompt is too long" overflow because the
estimate is bytes/4 alone (route not bound) and bytes/4 under-reads real usage in the 100-200k band?

**Decision: NO calibration change, NO hold. The pass bar (a measured case with est < forceAt while
real >= window-10k on an unbound route) was NOT met; no such case exists in the available data.** Re-open
triggers are listed at the end.

## Method (probes were gitignored scratch scripts; the method below is sufficient to re-run)

1. Bound-route coverage: for every live claude owner (adv_sessions rows with a v4 native session id, 90 owners),
   resolve the ref with the PRODUCTION `resolveSessionRefReconciled` and read the gateway
   `GET :8788/admin/route?owner=`. Classify: `bound` (route.nativeSessionId == ref.sessionId),
   `native-mismatch`, `no-route`. Also record `context1m` (served window) and `usage.inputTotal`, and the
   production `tokensFromFileSize` numerator for the same session.
2. Real overflow deaths: scan every claude transcript under the session-claude root (4,384 files >100 KB,
   oldest 2026-08-23) for the exact death record shape (`"error":"invalid_request"`, text
   `Prompt is too long`, what `isContextDeathRecord` accepts).

## Results

| measure | value |
|---|---|
| live claude owners probed | 90 |
| bound | 70 (78%) |
| native-mismatch | 7 (8%) |
| no-route | 13 (14%) |
| **unbound total (bytes/4 alone)** | **20 (22%)** |
| routed sessions with `context1m=true` | 77 of 77 (opus-5-5 68, sonnet-5-5 6, fable-5-1 3) |
| routed sessions with a 200k window | **0** |
| est/real on bound sessions (n=70) | p10 0.77, p50 0.98, p90 1.33 |
| real window-overflow death records, all transcripts | **0** |

Positive controls: API-error records DO serialize in these transcripts (218 files carry
`isApiErrorMessage`; errors seen are `unknown`, `rate_limit`, `server_error`, `authentication_failed`).
The 192 `apiErrorStatus:400` records are stale-tool-reference deaths (a different class), and none of the 30
files that contain the phrase "Prompt is too long" also carries a 400 record, so those hits are data a session
read or quoted, not deaths. The only claude-tool-reference-class 400s are unrelated to prompt size.

## Reading

- The unbound path is NOT rare (about 1 in 5 live sessions), so the premise "the force rung often runs on bytes/4
  alone" is confirmed.
- But the exposure needs a SMALL window as well. Every routed session in the live fleet is served the 1M window,
  and on 1M-window sessions the numerator is roughly unbiased (p50 0.98). forceAt there is 325k (L=250k) against a
  990k cap, so a 25-30% under-read cannot reach the window.
- For the small-window half the band ratio (100-200k, p50 0.75) is an inference from large-window sessions and is
  still NOT reproduced: no live session has a 200k window, and no real overflow death exists in 40 days of
  transcripts to anchor one. The bound path already handles the one known historical small-window case
  (a CLI silently re-requesting a bare model; 2026-09-02) because the served window comes from the gateway and
  `est = max(served inputTotal, bytes/4)`.

## Re-open triggers (any one is sufficient)

- A real `Prompt is too long` death record (the P-019 `detectContextDeathForOwner` detector already fires on it)
  on a session whose route was unbound.
- A routed session with `context1m=false` appears in the fleet (re-run the live probe above).
- The gateway stops upgrading non-`[1m]` specs to the 1M window.
