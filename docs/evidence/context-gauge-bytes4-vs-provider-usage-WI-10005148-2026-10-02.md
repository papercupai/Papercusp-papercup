# Context gauge bytes/4 numerator vs provider-reported usage (WI-10005148)

Measured 2026-10-02. Follow-up/residue of EI-23761864550626068 (exactness contract:
`context-gauge-evidence.ts`, `_meta._contextGaugeEvidence`). Question: should the compaction
watchdog's FORCE rung refuse/hold on a gauge-exactness reading?

**Decision: NO. Do not gate or hold the force rung on gauge exactness.** The gauge's dominant
error is an UNDER-read, so the risk it carries is a LATE force, and a hold makes that strictly
worse. Evidence below; one residue (small-window, gateway-unbound path) is filed separately.

## What was measured

Writer of the numerator: `packages/operator-core/lib/compaction-usage.ts` `tokensFromFileSize` /
`anchorTokens` = (transcript bytes since the last compact boundary, minus image bytes, minus
`toolUseResult` duplicates, minus `prompt_snapshot` excess) / 4. System prompt and tool definitions
are NOT in a transcript, so they are structurally absent from this numerator.

Writer of the force-rung estimate: `estimateContextTokensForOwner` (same file) =
`max(gateway-served usage.inputTotal, bytes/4)` ONLY when `servedRouteBoundToRef` binds the served
route to the ref's native claude session; otherwise bytes/4 alone, else a
`newestTranscriptUnderOwner` fallback (10-min freshness). Force fires in
`packages/operator-core/lib/system-health/compaction-compliance-watchdog.ts` when
`est >= forceAt`, `forceAt = min(compaction_limit * FORCE_COMPACT_FRACTION (1.3), capAt)` where
`capAt = window - COMPACTION_WINDOW_MARGIN_TOKENS (10k)` when the window is known, else
`compaction_limit * COMPACTION_OVERSHOOT_FACTOR (1.2)` (lines ~2781-2790).

Method: sample the 30 most recent claude sessions with usable transcripts (resolved through
`findSessionTranscript(sid, { owner })`, not a directory guess). For up to 12 assistant turns per
session, take the byte-prefix of the transcript BEFORE that turn, run the REAL `tokensFromFileSize`
on it (`est`), and compare with that turn's provider usage
`real = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. 395 samples,
34 transcripts resolved, 1 unresolved, 3 skipped as small. The probe was a gitignored scratch
script (not durable); the method above is sufficient to re-run it.

## Results (est / real)

| slice | n | min | p10 | p50 | p90 | max |
|---|---|---|---|---|---|---|
| ALL | 395 | 0.19 | 0.60 | 0.81 | 1.07 | 1.40 |
| real 50-100k | 16 | 0.95 | 0.96 | 0.97 | 0.99 | 0.99 |
| real 100-200k | 250 | 0.48 | 0.59 | 0.75 | 0.98 | 1.36 |
| real 200-400k | 116 | 0.24 | 0.75 | 0.93 | 1.15 | 1.32 |
| real >=400k | 13 | 0.19 | 0.79 | 1.04 | 1.30 | 1.40 |

- Direction: under-reads 330/395 (84%); over-reads 65/395. Under by >25%: 135. Over by >25%: 15
  (14 of those 15 in two sessions).
- Gap (real - est) p50 in the 100-200k band: 35.5k tokens; p10/p90 1.8k / 65.6k.
- Within-session ratio spread (max/min, sessions with >=4 samples, n=30): min 1.04, p50 1.52,
  p90 2.27, max 4.80.
- Delta ratio (gaugeDelta / providerDelta between consecutive samples, providerDelta > 4k,
  n=204): p10 0.97, p50 1.53, p90 2.05, max 5.30.
- Pass-bar reading: the item's bar was a >5x spread between similar-sized calls. Raw max/min is
  7.24x overall (5.5x in 200-400k, 7.4x in >=400k) but that comes from 4 samples below 0.4 in 4
  different sessions. The bulk is p10-p90 = 0.60-1.07 (1.8x). So the bar is hit by tail outliers,
  not by typical behaviour, and every one of those tail points is an UNDER-read.

## Interpretation

Two opposing biases show in the data; the first is the larger at the sizes below 200k:

1. A fixed-ish under-read offset: system prompt + tool definitions are in `real`, not in the
   transcript. [inferred - consistent with the 35k p50 gap in 100-200k, NOT separately measured; the
   50-100k band gap is only 2.5k so the offset is not a single constant.]
2. A growth over-count: the gauge delta runs ~1.5x the provider delta, so the ratio climbs with
   size and crosses ~1.0 near 400k. [inferred - plausibly transcript bytes the provider no longer
   re-sends (older thinking blocks / cleared tool results); the delta ratio is observed, the
   mechanism is not.]

At the sizes where a force actually fires on a 1M window (forceAt about 1.3 * L, L about 250k so
about 325k est) the observed ratio is roughly unbiased with about +/-25% error (200-400k band
p10 0.75, p50 0.93, p90 1.15). That error moves the real size at which force fires between roughly
280k and 430k on a 1M window - nowhere near the window, so it never converts a force into an
overflow death.

## Why a force-rung hold on exactness is rejected

- Holding a force on a low-confidence reading trades a respawn cost for a hard 'Prompt is too
  long' death. The gauge is low-confidence mainly in the under-read direction, i.e. exactly where
  a hold would push force later.
- Early-force risk (est > real by >25%) is 15/395 = 3.8% and concentrated in two sessions; the
  cost of those is one early, clean carry-respawn, which is the cheap failure.
- The force rung is already provider-first (`max(served, bytes/4)`) when the gateway route is bound,
  and a separate `observedPromptFloor` path (`compaction-compliance-watchdog.ts` about L2638-2660)
  handles unsatisfiable limits.

## Not measured / residue

- How often the gateway-served route is NOT bound to the ref's native session (so the force rung
  runs on bytes/4 alone). Transcripts cannot answer this; it needs gateway/`tool_invocations`
  data.
- Small-window models. Sampled sessions are large-window (real up to 479k). If bytes/4 alone
  under-reads at the 100-200k band (p50 0.75), then on a ~200k window forceAt = window - 10k = 190k
  est would correspond to real above the window, i.e. force could fire after the overflow.
  [inferred from the band ratios; not reproduced on a small-window session.] Filed as a
  follow-up work-item (see the completion of WI-10005148 for its id).
