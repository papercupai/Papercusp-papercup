# Retrieval deadline-chain audit

Date: 2026-09-13. Plan: `retrieval-soft-budget-hard-deadline-2026-09-13`.
Preparation item: WI-10001232 / P-001. Author: su-8ee55568-a37b-4b6b-84f3-e02e11c10d86.
Current-source reconciliation: 2026-11-02 by su-6af62442-baf5-46b3-8ceb-00c02cf7cf65.

This is pre-implementation evidence, not a claim that the new policy has shipped.

## Approved outcome

Avi approved AUTO, self execution through shipped status in
`session_turn:codex:01a09697-7bd2-78f1-9e1b-f8592b50a23c:51`.
The same session's turns 44, 46, and 47 specify:

- Keep 1,200 ms as a performance target; a reasonable slow success should reach the agent with a warning.
- Use one 10,000 ms end-to-end hard deadline, not a renewed allowance for each stage.
- Preserve completed safe results when unfinished work times out.
- Investigate and correct the cause of target breaches separately from tolerating them.
- Return to the GitNexus recommendation only after the retrieval work is verified.

Activation audit 7 records plan revision 33, including eight requirement mappings
and four source ranges carried from the complete source audit. Audit 6 resolved
18 archive references, including the original comparison and the explicit
Serena rejection. The current spec set
`dadbd517fc5fccedebefd90f7cb6324f885c1a271324151a49355ea72145e1be`
passed the canonical evaluator. Its scorecard `EI-27720456071179458` passed
independent grading-integrity review in `EI-27721431528544656` on
2026-11-02 at 23:40:17 UTC. These are preparation proofs; they do not establish
implementation, functional acceptance, or shipment.

## Current deadline chain

These are source observations from the canonical staging checkout, not proof of
the deployed code on every endpoint.

| Boundary | Current behavior | Source |
| --- | --- | --- |
| Shared client injection port | Turn-start 2,500 ms; mid-turn 1,500 ms hard HTTP/body timeout | `apps/operator/scripts/hooks/inject/ports.mjs`, `core.mjs:postInjection` |
| OMP subprocess wrapper | Duplicates those port budgets and adds 1,200 ms before terminating the dispatcher | `apps/operator/scripts/hooks/omp/inject-hook.ts` |
| Turn-start rendered-block cache | Cold wait 2,000 ms; stale block can return while a new query revalidates in the background | `packages/operator-core/lib/memory/injection-block-cache.ts` |
| Automatic memory backend operations | Separate 5,000 ms operation deadlines and a process-wide degraded cooldown | `packages/operator-core/lib/memory/injection.ts`, `op-deadline.ts` |
| Corpus retrieval | Whole-operation 2,000 ms race, whose timeout discards the whole result | `packages/operator-core/lib/memory/corpus-recall-io.ts:recallCorpusContext` |
| Query embedding | 1,200 ms hard budget, then semantic work is omitted | `corpus-recall-io.ts:corpusEmbedBudgetMs`, `libs/generic/search/src/hybrid.ts:embedWithBudget` |
| Optional corpus reranking | Separate 1,500 ms bound | `corpus-recall-io.ts:corpusRerankTimeoutMs` |

Changing only the embedding number cannot deliver the approved outcome: both
client ports and enclosing server waits can discard a valid later response.
Unrelated interactive search callers must retain their existing contract unless
explicitly migrated.

## Cancellation and partial-result findings

1. Generic hybrid search starts lexical retrieval and query embedding together.
   It then awaits lexical batches, semantic retrieval and final fusion.
   Its result is not exposed incrementally today.
2. Caller cancellation currently rejects the search and is intentionally distinct
   from graceful degradation. Preserve that distinction when introducing a
   partial hard-deadline result.
3. `embedWithBudget` supplies an abort signal to transport-aware embedders.
   The current corpus memo wrapper forwards that signal to its warm embedder
   and preserves mode/profile metadata with `stampEmbedderMode`. Reuse this
   implementation and preserve its provenance assertion; the earlier finding
   that the wrapper dropped cancellation and metadata is superseded.
4. The corpus now wraps its operation in `createMemoryWorkDeadline`, combining
   parent cancellation and remaining time with its own 2,000 ms bound. It passes
   that signal and bounded source-stage windows to the search engine. Its outer
   timeout still returns an empty result; it does not expose already-completed
   candidates when the whole operation expires.
5. The corpus has an additive second query: retained first-stage results must not
   disappear if widening or reranking times out.
6. Partial output still requires the normal workspace/harness, self-session,
   exclusion, relevance, deduplication and output-budget checks. A timeout is not
   authorization to expose an unfiltered candidate list.
7. The rendered-block cache is conversation-scoped but query-dependent.
   Verify that current-query late context is delivered under the new policy;
   merely receiving a cached previous query's context does not satisfy it.
8. Shared work must retain consumer ownership: aborting one coalesced consumer
   must not kill another consumer's useful request.

## Performance evidence and its limits

On September 13, one production worker reported 250 mid-turn embeddings with
57 timeouts, a 1,200 ms budget and 3 ms median. This is one process-local ring
from a 16-worker operator, not a fleet census. It demonstrates a surviving tail,
not a universally slow or cold service.

Three uncached query probes returned 1,948, 235 and 810 ms; per-response
accounting confirmed one inference and zero cache hits for each.
The first observed a saturated queue before dispatch. Different input strings
mean this is not a causal queue-versus-inference comparison.

Both inspected production units routed to the shared sidecar on port 3384.
The sidecar reported warm models, live worker threads and CPU execution.
CPU-only metadata does not isolate the slow stage or prove that enabling a GPU
would fix these specific requests.

Coverage samples from 20:52:45 to 22:22:26 UTC showed 3,592 additional eligible
session turns but only 512 additional current embeddings. Recent sweeps
embedded 64 turns and 64 chunks before exhausting the 200-second sweep budget.
The indexing process is running but is not keeping up in this window.
Coverage alarms did report this backlog growth. This is a separate freshness
problem, not proof that the particular historical decision was unindexed.

The inspected original GitNexus and Serena-choice turns have Gemma parent
vectors. The automatic excerpt search explicitly includes `session_turn` and
`work_item`, not plan decisions. A pointer to the prior GitNexus recommendation
was nevertheless injected and the agent did not follow it before recommending
alternatives. Keep retrieval policy and agent utilization failures distinct.

## Implementation and acceptance obligations

Extend the existing search and injection seams, rather than introducing a
parallel retrieval engine. Propagate one absolute deadline and caller
cancellation through the scoped request. Keep the soft performance target in
the existing latency/watchdog accounting. Preserve safe completed snapshots
when remaining work reaches the hard deadline.

The implementation test population includes:

- Valid semantic results at 1,500, 3,000 and 9,000 ms.
- Hung semantic work at 10,000 ms with completed lexical results retained.
- One hung source while another source completed.
- Deadline during second-stage widening or optional reranking.
- Sequential and parallel stages sharing remaining time rather than renewing it.
- Explicit caller cancellation and no subsequent late delivery.
- Shared/coalesced work with one cancelled and one continuing consumer.
- Slow-success warnings distinct from genuine errors and hard timeouts.
- Scope/exclusion/relevance checks on partial output.
- Turn-start and mid-turn endpoint/client delivery, including OMP parity.
- Preservation of existing behavior for non-migrated search callers.

Use deterministic clocks for boundary tests. Live measurements must separately
report acquisition, admission/queue, inference, SQL/highlight and rerank time,
cache behavior, request size, concurrency, process identity and build.

The November 2 reconciliation also found existing regression cases in
`corpus-recall-io.test.ts` for preserving the prose query profile through
memoization, retaining first-stage hits when another source search cannot fit,
and keeping a healthy source above the old half-budget cap. These are reusable
baseline protections; they do not prove the requested 1,200/10,000 ms policy.
Compared with baseline commit `af52a46a8a`, the inspected deadline/search source
files were unchanged. The inspected `core.mjs` changes concerned shell-command
classification and its parser import; its injection timeout policy was unchanged.

## Caller migration and partial-result design boundaries

The following is preparation for P-002, based on the November 2 source reads.
It describes the required migration boundary, not an implemented policy.

| Existing seam | Current behavior to reuse | Required migration boundary |
| --- | --- | --- |
| `postInjection` in `hooks/inject/core.mjs` | One abort controller covers local mid-turn collection, operator-base fallback, HTTP and JSON body reading. The request's `wallMs` subtracts collection time. | Keep one caller lifetime. Fallback attempts and server stages must consume its remaining time; none receives a renewed 10-second allowance. |
| `turnStartRespondBy` in `turn-start-memory.ts` | Converts the declared remaining wall to a response deadline, reserving up to 300 ms for staging and delivery. The mid-turn endpoint reuses it and binds a memory deadline to `req.signal`. | Preserve the response reserve and caller cancellation. Increasing an inner budget alone cannot deliver a late result after the client has stopped listening. |
| `getMemoryBlockBoundedResult` | A single-flight builder owns its deadline; stale responses and coalesced waiters retain separate caller-wait semantics. | A cancelled waiter must not abort another consumer's useful shared work. A stale cached answer must not stand in for current-query late success. |
| `runHybridSearch` | Embedding starts alongside lexical work; source calls have bounded cancellation, and completed ranker lists pass through score floors before fusion. Caller abort explicitly rejects. | Add deadline-driven completion at the existing engine seam while preserving explicit cancellation as rejection. Capture completed ranker work without changing unrelated callers' existing opt-in budgets. |
| `recallCorpusContextInner` | Stage-specific `selectCorpusLines` applies exclusions, scope, overlap, known references and output limits. Stage 2 spends the remaining item/character budget after stage 1. | Retain only snapshots that have passed these normal selection checks. Deadline during widening or reranking must retain the last safe completed snapshot; raw engine candidates are not deliverable partial context. |
| Existing embed latency and leg accounting | Query embedding already records caller and budget, and search records per-source/ranker outcomes. | Keep 1,200 ms observable as a performance target while separating slow success, genuine failure, explicit cancellation and hard deadline. |

`PORTS['pre-tool']` is a separate authorization guard with a 1,500 ms wall.
It does not retrieve context and is outside this policy migration. Its observed
read/decline availability fault is tracked separately as EI-27697470834897410;
extending retrieval waits must not weaken its refusal semantics. Stop and
compaction ports likewise retain their existing contracts unless separately
approved. The OMP turn-start/mid-turn subprocess wrapper must follow the shared
context-port policy so its termination deadline cannot cut off an otherwise
valid response.

At the hard deadline, unfinished request-owned stages must be cancelled and
late completions must not replace a completed response or mutate its snapshot.
If scope/exclusion checks have not completed, their raw input is not a safe
partial result. Keep shared-cache build ownership separate from each consumer's
delivery/cancellation state, and test both independently.

The focused acceptance population must exercise the existing `wallMs` hook
tests, response-reserve endpoint tests, cache/coalescing tests, hybrid-search
tests and corpus selection/cascade tests together. Existing short-budget tests
for non-migrated callers remain required. A passing core deadline helper alone
does not establish end-to-end delivery.

## Historical recommendation authority

The original comparison is
`codex:01a01fbc-6171-7d02-b205-8a3faeb65a8f`, turns 4–6.
The historical Serena discussion is
`claude:5ba8194a-9964-42d5-ade2-7699a0120deb`, turns 32–36.
Turn 34 asks about dropping Serena; turn 36 explicitly requests the removal.
Activation audit 6 added turns 35–36 while preserving the earlier source span.
The latter occurred August 20 evening in New York; its plan decision is dated
August 21 UTC.

`code-intelligence-routing-lsp-gitnexus-2026-08-20` decisions D-001 and D-002
remain the baseline: GitNexus for topology, official shared language servers
behind a thin Papercusp adapter for compiler truth, and exact text search for
working-tree evidence. The eventual reassessment must compare changed premises,
not repeat a generic vendor feature table.
