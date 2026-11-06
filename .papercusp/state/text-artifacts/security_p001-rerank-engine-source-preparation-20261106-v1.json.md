---
rel_path: "security/p001-rerank-engine-source-preparation-20261106-v1.json"
updated_at: 1793939565794
_body: "content"
---

{
  "schema": "p001-rerank-engine-source-preparation-v1",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "workItem": "WI-6554700010044289",
  "currentWorkItem": "WI-6554700010045753",
  "producer": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "status": "source-preparation-only",
  "recordedAt": "2026-11-06T04:32:45.759Z",
  "evidenceScope": "Two exact pinned rerank runtime dependency sources and offline syntax. This supplies no current loaded-process, package/distribution, platform enforcement, security acceptance or shipment qualification.",
  "sources": {
    "priorCanonical": "security/p001-native-distribution-source-classification-20261106-sidecar-client-v14.json",
    "extraction": "security/p001-rerank-engine-source-extraction-20261106-v1.json",
    "verification": "security/p001-rerank-engine-source-verification-20261106-v1.json"
  },
  "rootIdentityReused": {
    "revision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
    "memoryRevision": "fe9878936d3da86d872fc1a5fdd29877e903d1f0",
    "rerankRevision": "40e78e06b07a94203e151a44979394acc2dbc871",
    "note": "Reused retained v13 root/gitlink/package/entry identity. This unit does not replay those measurements."
  },
  "extraction": {
    "schema": "p001-rerank-engine-source-extraction-v1",
    "rootRevision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
    "analyzer": {
      "name": "typescript compiler API",
      "version": "6.0.3",
      "purpose": "offline parsing; no candidate import"
    },
    "scope": {
      "files": 2,
      "calls": "syntactic call expressions only; no dynamic execution/effect closure",
      "candidateExecution": false
    },
    "rows": [
      {
        "repository": "libs/generic/rerank",
        "repositoryRevision": "40e78e06b07a94203e151a44979394acc2dbc871",
        "path": "src/local-engine.ts",
        "gitBlob": "fc3dad4ae91c448b87c0222800a98788f9afb7a2",
        "sha256": "0d175f7d3e8206454626fa2ce614e69d040e3ac5ebbdf094fd3694b9bc61877d",
        "bytes": 25500,
        "text": "/**\n * Local ONNX cross-encoder engine for @papercusp/rerank.\n *\n * The lib's original engine calls a hosted API (ZeroEntropy zerank). This one\n * runs the cross-encoder IN-PROCESS via Transformers.js/ONNX Runtime, so\n * reranking costs no API key, no network hop, and no per-call spend — which is\n * what makes it usable on every search, not just the ones someone paid for.\n *\n * Contract: identical to every other engine here — index-aligned scores, and\n * `null` for \"I could not score this\" so the caller degrades to retrieval order\n * rather than breaking search. Nothing in this file may throw to its caller.\n *\n * Model shape it expects: a sequence-classification cross-encoder that emits\n * ONE logit per (query, doc) pair — `ModernBertForSequenceClassification` with\n * num_labels=1, e.g. `Alibaba-NLP/gte-reranker-modernbert-base`. Two-label\n * cross-encoders are also handled (softmax, take the \"relevant\" class), so the\n * engine is not welded to one architecture.\n *\n * Deliberately NOT here (they belong to later plan items, not to the engine):\n * an HTTP sidecar with one warm model per host, and host-aware dtype selection.\n * This file only has to be correct and fail-safe in-process.\n */\n\nimport {\n  CPU_EXECUTION_TARGET,\n  type RerankDevice,\n  type RerankExecutionTarget,\n  demotedTarget,\n  resolveExecutionTarget,\n} from './execution-target';\nimport { getRerankWorkerState, scoreViaWorker, warnRerankFallback } from './local-reranker-worker';\nimport { isDeadlineFailure, runInScorerGate } from './scorer-gate';\n\n/** Cross-encoder that emits one logit per pair. num_labels=1, ModernBERT. */\nexport const LOCAL_RERANKER_MODEL = 'Alibaba-NLP/gte-reranker-modernbert-base';\n\n/**\n * Fast tier: ~7.5x cheaper per pair (23M params / 6 layers vs 149M), at a real\n * quality cost. Measured, not assumed — see the plan's D-001. Use it where the\n * candidate pool is large or the latency budget is tight.\n */\nexport const FAST_RERANKER_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';\n\n/**\n * ONNX Runtime defaults intraOp threads to EVERY core and spin-waits them — on\n * a many-core host that grows a huge spin pool per loading process and stutters\n * the whole box (the same trap the local embedder hit, WI-3792). Cap it.\n *\n * Capping costs us nothing here: D-001 MEASURED that cross-encoder latency on\n * this workload does not improve with more cores (4 pinned cores matched a\n * 128-core box), so per-pair cost is bounded by the candidate cap, not by\n * threads. Kept identical to the embedder's cap so the two can share a host.\n */\nexport const ORT_SESSION_OPTIONS = { intraOpNumThreads: 4, interOpNumThreads: 1 } as const;\n\n/**\n * q8 is the CPU-correct default, MEASURED rather than assumed (plan D-006): on\n * 4 pinned cores it is 1.60x faster per pair than fp32 and never changed the\n * top result (top-1 agreement 1.000 across 6 queries, NDCG@5 0.9855).\n *\n * fp16/q4f16 are GPU formats. On the CPU provider fp16 is not merely slower —\n * the graph FAILS TO INITIALISE outright (ORT's precision-free-cast insertion\n * breaks on ModernBERT's SimplifiedLayerNormFusion), so the engine's fail-safe\n * would silently drop reranking entirely. That is why dtype is chosen as a PAIR\n * with the execution provider; see `execution-target.ts`.\n *\n * Prefer `resolveExecutionTarget()` over this constant — it is retained for the\n * callers that legitimately pin a dtype (tests, benchmarks).\n */\nexport const DEFAULT_RERANK_DTYPE = 'q8';\n\n/** Pairs are truncated to this many tokens. The model supports 8192, but a\n *  cross-encoder's cost is superlinear in sequence length and a reranker scores\n *  a match-centred passage, not a whole document — 512 is the useful window. */\nexport const DEFAULT_MAX_LENGTH = 512;\n\n/** Pairs per forward pass. Padding is to the longest member of the batch, so a\n *  huge batch wastes compute on padding; 16 keeps memory flat and padding cheap. */\nexport const DEFAULT_BATCH_SIZE = 16;\n\nexport interface LocalRerankOptions {\n  /** Optional domain-free host sink for actual device and worker decisions. */\n  observeFallback?: (mechanism: string, decision: { eligible: number; applied: number; reason: string }) => unknown;\n  /** HF model id. Default `LOCAL_RERANKER_MODEL`. */\n  model?: string;\n  /**\n   * ONNX weight format. Defaults WITH `device` as a coherent pair (see\n   * `execution-target.ts`) — do not set this alone unless you mean to: `fp16`\n   * without a GPU `device` is not a slow configuration, it is an unloadable one.\n   */\n  dtype?: string;\n  /**\n   * ONNX Runtime execution provider. Defaults WITH `dtype` as a pair. Passing a\n   * GPU device does not force it: the engine verifies the session actually\n   * constructs and falls back to the whole CPU pair if it does not.\n   */\n  device?: RerankDevice;\n  /** Truncate each (query, doc) pair to this many tokens. Default 512. */\n  maxLength?: number;\n  /** Pairs per forward pass. Default 16. */\n  batchSize?: number;\n  /**\n   * Absolute epoch-ms instant after which scoring STOPS, checked between\n   * batches. Throws on expiry, which `localEngineScores` converts to the same\n   * fail-safe `null` as any other scoring failure — so an over-budget rerank\n   * degrades to retrieval order rather than running to completion unwatched.\n   *\n   * Distinct from the caller's `timeoutMs` and NOT a replacement for it. That\n   * one bounds how long the CALLER waits; this one stops the WORK. Both are\n   * needed because the losing side of a `Promise.race` is not cancellable: with\n   * only the race, an abandoned rerank keeps burning a core for the rest of its\n   * natural life, on the very host (no sidecar ⇒ in-process) least able to\n   * spare one. `rerank()` derives this from `timeoutMs` automatically.\n   */\n  deadline?: number;\n}\n\n// --- Minimal structural types for the optional dependency ------------------\n// Typed structurally rather than imported, so this lib does not take a hard\n// build-time dependency on @huggingface/transformers.\n\ninterface LogitsTensor {\n  dims: number[];\n  data: ArrayLike<number>;\n}\ntype Tokenizer = (\n  text: string[],\n  opts: { text_pair: string[]; padding: boolean; truncation: boolean; max_length: number },\n) => Record<string, unknown>;\ntype SequenceClassifier = (inputs: Record<string, unknown>) => Promise<{ logits: LogitsTensor }>;\n\ninterface TransformersModule {\n  AutoTokenizer: { from_pretrained(model: string, opts?: Record<string, unknown>): Promise<Tokenizer> };\n  AutoModelForSequenceClassification: {\n    from_pretrained(model: string, opts?: Record<string, unknown>): Promise<SequenceClassifier>;\n  };\n}\n\nconst TRANSFORMERS_PACKAGE = '@huggingface/transformers';\n\n// Keep the optional dependency lazy and opaque to bundlers through a runtime\n// specifier. Native import retains the host callback in VM module runners;\n// new Function loses it and falsely reports an installed engine unavailable.\n// This is the native-import leg of memory's existing optional-import seam,\n// kept local so this standalone library does not depend on the memory stack.\nasync function dynamicImport<T>(specifier: string): Promise<T> {\n  return (await import(/* @vite-ignore */ specifier)) as T;\n}\n\ninterface LoadedModel {\n  tokenizer: Tokenizer;\n  model: SequenceClassifier;\n}\n\n/** One warm model per (id, dtype). Loading is seconds; scoring is milliseconds,\n *  so the cache is the difference between usable and unusable. */\nconst _models = new Map<string, Promise<LoadedModel>>();\n\n/** Injected in tests so the engine's own logic is testable without ONNX. */\nlet _loaderOverride: ((model: string, dtype: string, device: RerankDevice) => Promise<LoadedModel>) | null =\n  null;\n\n/**\n * Test-only: permit the WORKER path even while a loader override is installed.\n *\n * Normally an injected loader forces the inline path (it is an in-process object\n * and cannot cross a thread boundary). That rule makes the worker→inline\n * FALLBACK unreachable from tests, because the override short-circuits before\n * the worker is ever tried — so this seam exists purely to exercise \"the worker\n * failed, did we degrade correctly?\" against a fake model. Production never\n * installs a loader override, so this combination cannot occur outside tests.\n */\nlet _workerWithLoaderForTest = false;\nexport function _setWorkerWithLoaderForTest(enabled: boolean): void {\n  _workerWithLoaderForTest = enabled;\n}\n\nasync function defaultLoader(model: string, dtype: string, device: RerankDevice): Promise<LoadedModel> {\n  const transformers = await dynamicImport<TransformersModule>(TRANSFORMERS_PACKAGE);\n  const [tokenizer, classifier] = await Promise.all([\n    transformers.AutoTokenizer.from_pretrained(model),\n    transformers.AutoModelForSequenceClassification.from_pretrained(model, {\n      dtype,\n      device,\n      session_options: ORT_SESSION_OPTIONS,\n    }),\n  ]);\n  return { tokenizer, model: classifier };\n}\n\n/**\n * Load (and cache) the cross-encoder. Exported so a warm-model host can preload\n * it at startup instead of paying the load on a user's first search.\n *\n * Rejects on failure — and de-caches, so a transient failure (a half-downloaded\n * model, a cold network) does not poison the process for its whole lifetime.\n */\nexport function loadCrossEncoder(opts: LocalRerankOptions = {}): Promise<LoadedModel> {\n  return loadOnTarget(opts.model ?? LOCAL_RERANKER_MODEL, effectiveTarget(opts), opts.observeFallback);\n}\n\n/**\n * Resolve the (device, dtype) PAIR for a call.\n *\n * The pair is the unit: when the caller says nothing we take the host's whole\n * target, never one field from the host and one from a constant. An explicit\n * `dtype`/`device` is still honoured (tests and experiments need to pin one),\n * but it can only ever narrow a coherent starting point — it cannot silently\n * produce `fp16` on the CPU provider by defaulting the other half.\n */\nfunction effectiveTarget(opts: LocalRerankOptions): RerankExecutionTarget {\n  const host = resolveExecutionTarget();\n  if (opts.device === undefined && opts.dtype === undefined) return host;\n  const device = opts.device ?? host.device;\n  const dtype = opts.dtype ?? host.dtype;\n  return { device, dtype, why: 'explicit caller override' };\n}\n\n/**\n * Has the GPU target been proven to work on this host? A GPU that is present is\n * not a GPU that is usable — the CUDA provider fails to load without cuDNN, and\n * the fp16 graph fails to initialise on the CPU provider. We therefore find out\n * by CONSTRUCTING a session, and remember the answer so a broken GPU host pays\n * the failed load once rather than on every search.\n */\nlet _gpuUnusable = false;\n\n/**\n * The demotion itself, REMEMBERED rather than only logged.\n *\n * A `console.warn` fires once per process and is then gone: it cannot be read\n * by a health check, a test, or an operator asking \"why is search slow?\" three\n * weeks later. Keeping the verdict here is what lets `activeExecutionTarget()`\n * and `rerankExecutionHealth()` distinguish a demoted host from a deliberate\n * CPU one — see `demotedTarget` for why that distinction is load-bearing.\n */\nlet _demotion: { from: RerankExecutionTarget; cause: string; target: RerankExecutionTarget } | null =\n  null;\n\n/** Reported once per process when a GPU target is demoted, so the fallback is\n *  visible in a log instead of silently costing quality. */\nfunction reportDemotion(target: RerankExecutionTarget, err: unknown, observeFallback?: LocalRerankOptions['observeFallback']): void {\n  try { observeFallback?.('rerank-device', { eligible: 1, applied: 0, reason: 'gpu-construction-failed' }); } catch { /* no-throw sink */ }\n  const cause = String((err as Error)?.message ?? err).slice(0, 200);\n  _demotion = { from: target, cause, target: demotedTarget(target, cause) };\n  console.warn(\n    `[rerank] ${target.device}/${target.dtype} session failed to construct — falling back to ` +\n      `${CPU_EXECUTION_TARGET.device}/${CPU_EXECUTION_TARGET.dtype}. ` +\n      `Reranking continues on CPU. Cause: ${cause}`,\n  );\n}\n\n/**\n * Load on `target`, falling back to the CPU PAIR — both fields together — if a\n * non-CPU target cannot construct a session.\n *\n * Falling back on `device` alone would leave `dtype: 'fp16'` pointed at the CPU\n * provider, which is the single worst configuration available and is exactly\n * what a naive \"GPU didn't work, use the CPU\" retry produces.\n */\nfunction loadOnTarget(model: string, target: RerankExecutionTarget, observeFallback?: LocalRerankOptions['observeFallback']): Promise<LoadedModel> {\n  const effective = target.device !== 'cpu' && _gpuUnusable ? CPU_EXECUTION_TARGET : target;\n  if (target.device !== 'cpu' && _gpuUnusable) {\n    try { observeFallback?.('rerank-device', { eligible: 1, applied: 0, reason: 'sticky-gpu-demotion' }); } catch { /* no-throw sink */ }\n  }\n  const key = `${model}::${effective.dtype}::${effective.device}`;\n\n  const cached = _models.get(key);\n  if (cached) return cached;\n\n  const loading = (_loaderOverride ?? defaultLoader)(model, effective.dtype, effective.device).then((loaded) => {\n    if (effective.device !== 'cpu') {\n      try { observeFallback?.('rerank-device', { eligible: 1, applied: 1, reason: 'applied' }); } catch { /* no-throw sink */ }\n    }\n    return loaded;\n  }).catch(\n    (err) => {\n      _models.delete(key);\n      if (effective.device === 'cpu') throw err;\n      // Demote the WHOLE pair, once, then retry on CPU.\n      _gpuUnusable = true;\n      reportDemotion(effective, err, observeFallback);\n      return loadOnTarget(model, CPU_EXECUTION_TARGET);\n    },\n  );\n  _models.set(key, loading);\n  return loading;\n}\n\n/** The pair this host will actually run on, after any verified demotion. Exposed\n *  so a warm-model host / health check can REPORT the real configuration rather\n *  than the requested one. */\nexport function activeExecutionTarget(): RerankExecutionTarget {\n  const host = resolveExecutionTarget();\n  if (host.device === 'cpu' || !_gpuUnusable) return host;\n  // Report the DEMOTED pair, not the bare CPU constant: same device/dtype, but a\n  // `why` that says a GPU was asked for and refused. Falling back to the plain\n  // constant here is what made a degraded host unreadable from a healthy one.\n  return _demotion?.target ?? CPU_EXECUTION_TARGET;\n}\n\n/**\n * Requested vs actual execution target, and whether the gap is a demotion.\n *\n * `activeExecutionTarget()` alone answers \"what is running\"; it cannot answer\n * \"is that what we asked for?\" without the caller separately resolving the host\n * target and comparing — which nothing in this repo did, so a GPU host that\n * quietly reverted to CPU looked exactly like a CPU host. This returns both\n * sides plus the verdict, so the comparison cannot be forgotten.\n *\n * `demoted: false` before the first load is HONEST, not a clean bill: the GPU\n * session is only verified by constructing one. Read it after a load.\n */\nexport interface RerankExecutionHealth {\n  /** What this host asked for (`PAPERCUSP_RERANK_DEVICE`). */\n  requested: RerankExecutionTarget;\n  /** What it will actually run on, after any verified demotion. */\n  active: RerankExecutionTarget;\n  /** True once a requested GPU target has failed to construct a session. */\n  demoted: boolean;\n  /** The construction error that forced the demotion; null when not demoted. */\n  demotionCause: string | null;\n}\n\nexport function rerankExecutionHealth(): RerankExecutionHealth {\n  return {\n    requested: resolveExecutionTarget(),\n    active: activeExecutionTarget(),\n    demoted: _demotion !== null,\n    demotionCause: _demotion?.cause ?? null,\n  };\n}\n\nconst sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));\n\n/**\n * Collapse a row of logits to one relevance score.\n *\n * - 1 logit  → sigmoid. The single-logit cross-encoder convention.\n * - N logits → softmax, take class 1 (\"relevant\" by the binary cross-encoder\n *   convention). Only the 0/1 pair matters, so softmax over those two is both\n *   correct for N=2 and a sane reading for N>2.\n *\n * Both are MONOTONIC in the underlying logit, so ordering is unaffected by the\n * squashing — which matters because ordering is the only thing quantization\n * preserves exactly (D-001: q8 keeps the ranking but compresses the score\n * range, so any absolute threshold must be fitted on the deployed dtype).\n */\nfunction scoreFromLogits(row: number[]): number {\n  if (row.length === 1) return sigmoid(row[0]);\n  const [negative, positive] = row;\n  return sigmoid(positive - negative);\n}\n\n/**\n * Hand the event loop a turn.\n *\n * `setImmediate` fires in the CHECK phase, which the loop reaches only after\n * passing through the TIMERS phase — so this is what lets an armed `setTimeout`\n * (every wall-clock bound in this lib is one) actually run. `await`-ing an\n * already-resolved promise would NOT do it: that only queues a microtask, and\n * the microtask queue is drained to empty before the loop advances a phase, so\n * a loop of `await` over synchronous work starves timers exactly as a bare\n * `while` loop would. That distinction IS the bug this yield fixes.\n *\n * Falls back to `setTimeout(0)` where `setImmediate` is absent (browser/worker\n * builds); this lib is deliberately environment-agnostic.\n */\nfunction yieldToEventLoop(): Promise<void> {\n  return new Promise<void>((resolve) => {\n    if (typeof setImmediate === 'function') setImmediate(resolve);\n    else setTimeout(resolve, 0);\n  });\n}\n\n/**\n * Score every (query, text) pair. Returns scores index-aligned with `texts`.\n *\n * Throws on load/inference failure — the fail-safe conversion to \"return the\n * input order untouched\" happens in the engine wrapper below, so a caller that\n * wants to SEE the failure (a warm-up probe, a health check, the sidecar) can.\n *\n * ⚠ COOPERATIVE WHEN INLINE (EI-20005411672741677). A cross-encoder forward pass\n * is CPU-bound and holds the thread, so while it runs on the MAIN thread nothing\n * else in this process makes progress — including the `setTimeout` behind every\n * one of this lib's wall-clock bounds. A timer cannot preempt it; there is no\n * third option between \"the work yields\" and \"the work runs elsewhere\". So the\n * inline loop yields between batches and re-checks its deadline there, bounding\n * the caller's wait to at most ONE batch of overrun instead of the whole stage.\n *\n * The preferred path takes the third option: `scoreCrossEncoder` dispatches to a\n * WORKER THREAD (`local-reranker-worker.ts`, WI-37555), which makes the caller's\n * bound EXACT rather than bounded-to-one-batch. This inline function remains the\n * fallback for hosts where a worker cannot spawn — degraded, never broken.\n */\nexport async function scoreCrossEncoderInline(\n  query: string,\n  texts: string[],\n  opts: LocalRerankOptions = {},\n): Promise<number[]> {\n  if (texts.length === 0) return [];\n\n  const { tokenizer, model } = await loadCrossEncoder(opts);\n  const maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;\n  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);\n  const { deadline } = opts;\n\n  const scores: number[] = [];\n  for (let start = 0; start < texts.length; start += batchSize) {\n    // Before each pass, not after: the yield has to precede the thread-holding\n    // work for a bound armed by the caller to have any chance of firing, and\n    // the deadline is only meaningful once the loop has actually been given a\n    // turn to notice time passing.\n    await yieldToEventLoop();\n    if (deadline !== undefined && Date.now() >= deadline) {\n      throw new Error(\n        `rerank: scoring deadline exceeded after ${start} of ${texts.length} pairs — degrading to retrieval order`,\n      );\n    }\n\n    const batch = texts.slice(start, start + batchSize);\n    const inputs = tokenizer(\n      // The cross-encoder scores a PAIR: the query is repeated against each doc.\n      new Array(batch.length).fill(query),\n      { text_pair: batch, padding: true, truncation: true, max_length: maxLength },\n    );\n    const { logits } = await model(inputs);\n\n    // dims is [batch, numLabels]; a 1-D [batch] export means one logit per pair.\n    const numLabels = logits.dims.length > 1 ? logits.dims[logits.dims.length - 1] : 1;\n    if (logits.data.length !== batch.length * numLabels) {\n      throw new Error(\n        `rerank: logits length ${logits.data.length} != ${batch.length} pairs x ${numLabels} labels`,\n      );\n    }\n    for (let i = 0; i < batch.length; i++) {\n      const row: number[] = [];\n      for (let l = 0; l < numLabels; l++) row.push(Number(logits.data[i * numLabels + l]));\n      scores.push(scoreFromLogits(row));\n    }\n  }\n  return scores;\n}\n\n/**\n * Score every (query, text) pair, PREFERRING a worker thread.\n *\n * This is the exported entry point every caller already used; the dispatch is\n * deliberately invisible to them, so the sidecar, the warm-model host and\n * `localEngineScores` all get the exact bound with no wiring change.\n *\n * Two cases take the inline path, both on purpose:\n *  - a `_setLoaderForTest` override is installed. An injected loader is an\n *    in-process JavaScript object; it cannot cross a thread boundary, so\n *    routing it to the worker would not merely fail, it would silently start\n *    exercising the REAL ONNX model in tests that believe they injected a fake.\n *  - the worker is unavailable or failed. Degraded (bound accurate only to one\n *    batch), never broken.\n */\nexport async function scoreCrossEncoder(\n  query: string,\n  texts: string[],\n  opts: LocalRerankOptions = {},\n): Promise<number[]> {\n  if (texts.length === 0) return [];\n\n  // ONE shared scorer, so admission is decided here rather than per engine path:\n  // both the worker and the inline fallback contend for the same CPU, and this\n  // is the single funnel they both pass through. See `scorer-gate.ts` for the\n  // measurement — concurrency buys no throughput, so serializing costs nothing\n  // and lets a call that provably cannot meet its budget shed at ~0ms instead of\n  // spending the whole budget discovering it (WI-37676).\n  return await runInScorerGate(texts.length, opts.deadline, () =>\n    scoreCrossEncoderUngated(query, texts, opts),\n  );\n}\n\nasync function scoreCrossEncoderUngated(\n  query: string,\n  texts: string[],\n  opts: LocalRerankOptions,\n): Promise<number[]> {\n  if ((_loaderOverride === null || _workerWithLoaderForTest) && !getRerankWorkerState().disabled) {\n    // Resolve the (device, dtype) pair HERE — including any verified GPU\n    // demotion — so that logic lives in one place rather than being duplicated\n    // across the thread seam.\n    const target = effectiveTarget(opts);\n    const effective = target.device !== 'cpu' && _gpuUnusable ? CPU_EXECUTION_TARGET : target;\n    try {\n      const scores = await scoreViaWorker({\n        query,\n        texts,\n        model: opts.model ?? LOCAL_RERANKER_MODEL,\n        dtype: effective.dtype,\n        device: effective.device,\n        maxLength: opts.maxLength ?? DEFAULT_MAX_LENGTH,\n        batchSize: Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE),\n        deadline: opts.deadline,\n        ...(opts.observeFallback ? { observeFallback: opts.observeFallback } : {}),\n      });\n      try { opts.observeFallback?.('rerank-worker', { eligible: 1, applied: 1, reason: 'applied' }); } catch { /* no-throw sink */ }\n      return scores;\n    } catch (err) {\n      // A deadline expiry is a real verdict from the worker, not a worker\n      // fault: re-running it inline would burn the very budget that just\n      // expired, on the main thread, which is the opposite of the fix.\n      if (isDeadlineFailure(err)) throw err;\n      warnRerankFallback(err, opts.observeFallback);\n    }\n  } else if (_loaderOverride === null || _workerWithLoaderForTest) {\n    try { opts.observeFallback?.('rerank-worker', { eligible: 1, applied: 0, reason: 'worker-disabled' }); } catch { /* no-throw sink */ }\n  }\n\n  return await scoreCrossEncoderInline(query, texts, opts);\n}\n\n/**\n * The engine seam: score `texts`, or return `null` if anything at all goes\n * wrong. `null` is the lib's fail-safe signal — the caller keeps retrieval\n * order. A reranker outage must never be able to break search, and this\n * function is the boundary where that guarantee is enforced.\n */\nexport async function localEngineScores(\n  query: string,\n  texts: string[],\n  opts: LocalRerankOptions = {},\n): Promise<number[] | null> {\n  try {\n    return await scoreCrossEncoder(query, texts, opts);\n  } catch {\n    return null;\n  }\n}\n\n/** True when a local rerank is possible at all — i.e. the optional ONNX\n *  dependency is installed. Unlike the hosted engine, no key is involved. */\nexport async function localRerankAvailable(): Promise<boolean> {\n  try {\n    await dynamicImport<TransformersModule>(TRANSFORMERS_PACKAGE);\n    return true;\n  } catch {\n    return false;\n  }\n}\n\n/** Test seam — inject a fake loader and drop every warm model.\n *\n *  Also clears the remembered GPU verdict: it is process-lifetime state by\n *  design (a broken GPU host must not re-pay a failed load per search), which\n *  would otherwise leak between tests and make a demotion test pass only when\n *  it happened to run first. */\nexport function _setLoaderForTest(\n  loader: ((model: string, dtype: string, device: RerankDevice) => Promise<LoadedModel>) | null,\n): void {\n  _loaderOverride = loader;\n  _models.clear();\n  _gpuUnusable = false;\n  _demotion = null;\n  // Reset the worker-dispatch escape too, so a test that enabled it cannot leak\n  // the worker path into an unrelated later test via the shared afterEach.\n  _workerWithLoaderForTest = false;\n}\n",
        "parseDiagnostics": [],
        "moduleEdges": [
          {
            "kind": "import",
            "specifier": "./execution-target",
            "typeOnly": false,
            "defaultImport": null,
            "named": [
              {
                "name": "CPU_EXECUTION_TARGET",
                "imported": "CPU_EXECUTION_TARGET",
                "typeOnly": false
              },
              {
                "name": "RerankDevice",
                "imported": "RerankDevice",
                "typeOnly": true
              },
              {
                "name": "RerankExecutionTarget",
                "imported": "RerankExecutionTarget",
                "typeOnly": true
              },
              {
                "name": "demotedTarget",
                "imported": "demotedTarget",
                "typeOnly": false
              },
              {
                "name": "resolveExecutionTarget",
                "imported": "resolveExecutionTarget",
                "typeOnly": false
              }
            ],
            "line": 24,
            "column": 1,
            "endLine": 30,
            "resolved": [
              {
                "path": "src/execution-target.ts",
                "gitBlob": "6f7a3f806bad9f733df26afbecbd10a3f19427fe",
                "bytes": 6870,
                "sha256": "183936cbef9e11d98cf3b7ef0672bf4cd297551ed0ce7fc5811b194a979b6a37"
              }
            ]
          },
          {
            "kind": "import",
            "specifier": "./local-reranker-worker",
            "typeOnly": false,
            "defaultImport": null,
            "named": [
              {
                "name": "getRerankWorkerState",
                "imported": "getRerankWorkerState",
                "typeOnly": false
              },
              {
                "name": "scoreViaWorker",
                "imported": "scoreViaWorker",
                "typeOnly": false
              },
              {
                "name": "warnRerankFallback",
                "imported": "warnRerankFallback",
                "typeOnly": false
              }
            ],
            "line": 31,
            "column": 1,
            "endLine": 31,
            "resolved": [
              {
                "path": "src/local-reranker-worker.ts",
                "gitBlob": "5b64cf164f510a6f72ce19f663e8a438c4b7e03a",
                "bytes": 20559,
                "sha256": "d58a9be8a3bf58d5f78debd24285af1253dcf7ace7118144c40a6948fe1c709f"
              }
            ]
          },
          {
            "kind": "import",
            "specifier": "./scorer-gate",
            "typeOnly": false,
            "defaultImport": null,
            "named": [
              {
                "name": "isDeadlineFailure",
                "imported": "isDeadlineFailure",
                "typeOnly": false
              },
              {
                "name": "runInScorerGate",
                "imported": "runInScorerGate",
                "typeOnly": false
              }
            ],
            "line": 32,
            "column": 1,
            "endLine": 32,
            "resolved": [
              {
                "path": "src/scorer-gate.ts",
                "gitBlob": "57cc70ea08efdd476c8afa9af3da0e647fc6d29b",
                "bytes": 9054,
                "sha256": "10a883a24c62748d3f83f11f7cd5d0417afc124dc860f90fed723a32c7b6f602"
              }
            ]
          }
        ],
        "dynamicImports": [
          {
            "expression": "specifier",
            "literal": false,
            "line": 147,
            "column": 17,
            "endLine": 147
          }
        ],
        "constants": [
          {
            "name": "LOCAL_RERANKER_MODEL",
            "value": "Alibaba-NLP/gte-reranker-modernbert-base",
            "line": 35,
            "column": 14,
            "endLine": 35
          },
          {
            "name": "FAST_RERANKER_MODEL",
            "value": "Xenova/ms-marco-MiniLM-L-6-v2",
            "line": 42,
            "column": 14,
            "endLine": 42
          },
          {
            "name": "DEFAULT_RERANK_DTYPE",
            "value": "q8",
            "line": 70,
            "column": 14,
            "endLine": 70
          },
          {
            "name": "TRANSFORMERS_PACKAGE",
            "value": "@huggingface/transformers",
            "line": 139,
            "column": 7,
            "endLine": 139
          }
        ],
        "calls": [
          {
            "callee": "import",
            "line": 147,
            "column": 17,
            "endLine": 147,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "specifier",
                "truncated": false
              }
            ]
          },
          {
            "callee": "dynamicImport",
            "line": 179,
            "column": 30,
            "endLine": 179,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "TRANSFORMERS_PACKAGE",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Promise.all",
            "line": 180,
            "column": 41,
            "endLine": 187,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "[\n    transformers.AutoTokenizer.from_pretrained(model),\n    transformers.AutoModelForSequenceClassification.from_pretrained(model, {\n      dtype,\n      device,\n      session_optio",
                "truncated": true
              }
            ]
          },
          {
            "callee": "transformers.AutoTokenizer.from_pretrained",
            "line": 181,
            "column": 5,
            "endLine": 181,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "model",
                "truncated": false
              }
            ]
          },
          {
            "callee": "transformers.AutoModelForSequenceClassification.from_pretrained",
            "line": 182,
            "column": 5,
            "endLine": 186,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "model",
                "truncated": false
              },
              {
                "text": "{\n      dtype,\n      device,\n      session_options: ORT_SESSION_OPTIONS,\n    }",
                "truncated": false
              }
            ]
          },
          {
            "callee": "loadOnTarget",
            "line": 199,
            "column": 10,
            "endLine": 199,
            "argumentCount": 3,
            "arguments": [
              {
                "text": "opts.model ?? LOCAL_RERANKER_MODEL",
                "truncated": false
              },
              {
                "text": "effectiveTarget(opts)",
                "truncated": false
              },
              {
                "text": "opts.observeFallback",
                "truncated": false
              }
            ]
          },
          {
            "callee": "effectiveTarget",
            "line": 199,
            "column": 59,
            "endLine": 199,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "opts",
                "truncated": false
              }
            ]
          },
          {
            "callee": "resolveExecutionTarget",
            "line": 212,
            "column": 16,
            "endLine": 212,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "observeFallback",
            "line": 243,
            "column": 9,
            "endLine": 243,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "'rerank-device'",
                "truncated": false
              },
              {
                "text": "{ eligible: 1, applied: 0, reason: 'gpu-construction-failed' }",
                "truncated": false
              }
            ]
          },
          {
            "callee": "String((err as Error)?.message ?? err).slice",
            "line": 244,
            "column": 17,
            "endLine": 244,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "0",
                "truncated": false
              },
              {
                "text": "200",
                "truncated": false
              }
            ]
          },
          {
            "callee": "String",
            "line": 244,
            "column": 17,
            "endLine": 244,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "(err as Error)?.message ?? err",
                "truncated": false
              }
            ]
          },
          {
            "callee": "demotedTarget",
            "line": 245,
            "column": 46,
            "endLine": 245,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "target",
                "truncated": false
              },
              {
                "text": "cause",
                "truncated": false
              }
            ]
          },
          {
            "callee": "console.warn",
            "line": 246,
            "column": 3,
            "endLine": 250,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "`[rerank] ${target.device}/${target.dtype} session failed to construct — falling back to ` +\n      `${CPU_EXECUTION_TARGET.device}/${CPU_EXECUTION_TARGET.dtype}. ` +\n      `Reranki",
                "truncated": true
              }
            ]
          },
          {
            "callee": "observeFallback",
            "line": 264,
            "column": 11,
            "endLine": 264,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "'rerank-device'",
                "truncated": false
              },
              {
                "text": "{ eligible: 1, applied: 0, reason: 'sticky-gpu-demotion' }",
                "truncated": false
              }
            ]
          },
          {
            "callee": "_models.get",
            "line": 268,
            "column": 18,
            "endLine": 268,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "key",
                "truncated": false
              }
            ]
          },
          {
            "callee": "(_loaderOverride ?? defaultLoader)(model, effective.dtype, effective.device).then((loaded) => {\n    if (effective.device !== 'cpu') {\n      try { observeFallback?.('rerank-device', { eligible: 1, applied: 1, reason: 'applied' }); } catch { /* no-throw sink */ }\n    }\n    return loaded;\n  }).catch",
            "line": 271,
            "column": 19,
            "endLine": 285,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "(err) => {\n      _models.delete(key);\n      if (effective.device === 'cpu') throw err;\n      // Demote the WHOLE pair, once, then retry on CPU.\n      _gpuUnusable = true;\n      rep",
                "truncated": true
              }
            ]
          },
          {
            "callee": "(_loaderOverride ?? defaultLoader)(model, effective.dtype, effective.device).then",
            "line": 271,
            "column": 19,
            "endLine": 276,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "(loaded) => {\n    if (effective.device !== 'cpu') {\n      try { observeFallback?.('rerank-device', { eligible: 1, applied: 1, reason: 'applied' }); } catch { /* no-throw sink */ }\n",
                "truncated": true
              }
            ]
          },
          {
            "callee": "(_loaderOverride ?? defaultLoader)",
            "line": 271,
            "column": 19,
            "endLine": 271,
            "argumentCount": 3,
            "arguments": [
              {
                "text": "model",
                "truncated": false
              },
              {
                "text": "effective.dtype",
                "truncated": false
              },
              {
                "text": "effective.device",
                "truncated": false
              }
            ]
          },
          {
            "callee": "observeFallback",
            "line": 273,
            "column": 13,
            "endLine": 273,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "'rerank-device'",
                "truncated": false
              },
              {
                "text": "{ eligible: 1, applied: 1, reason: 'applied' }",
                "truncated": false
              }
            ]
          },
          {
            "callee": "_models.delete",
            "line": 278,
            "column": 7,
            "endLine": 278,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "key",
                "truncated": false
              }
            ]
          },
          {
            "callee": "reportDemotion",
            "line": 282,
            "column": 7,
            "endLine": 282,
            "argumentCount": 3,
            "arguments": [
              {
                "text": "effective",
                "truncated": false
              },
              {
                "text": "err",
                "truncated": false
              },
              {
                "text": "observeFallback",
                "truncated": false
              }
            ]
          },
          {
            "callee": "loadOnTarget",
            "line": 283,
            "column": 14,
            "endLine": 283,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "model",
                "truncated": false
              },
              {
                "text": "CPU_EXECUTION_TARGET",
                "truncated": false
              }
            ]
          },
          {
            "callee": "_models.set",
            "line": 286,
            "column": 3,
            "endLine": 286,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "key",
                "truncated": false
              },
              {
                "text": "loading",
                "truncated": false
              }
            ]
          },
          {
            "callee": "resolveExecutionTarget",
            "line": 294,
            "column": 16,
            "endLine": 294,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "resolveExecutionTarget",
            "line": 327,
            "column": 16,
            "endLine": 327,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "activeExecutionTarget",
            "line": 328,
            "column": 13,
            "endLine": 328,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "Math.exp",
            "line": 334,
            "column": 49,
            "endLine": 334,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "-x",
                "truncated": false
              }
            ]
          },
          {
            "callee": "sigmoid",
            "line": 350,
            "column": 32,
            "endLine": 350,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "row[0]",
                "truncated": false
              }
            ]
          },
          {
            "callee": "sigmoid",
            "line": 352,
            "column": 10,
            "endLine": 352,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "positive - negative",
                "truncated": false
              }
            ]
          },
          {
            "callee": "setImmediate",
            "line": 371,
            "column": 45,
            "endLine": 371,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "resolve",
                "truncated": false
              }
            ]
          },
          {
            "callee": "setTimeout",
            "line": 372,
            "column": 10,
            "endLine": 372,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "resolve",
                "truncated": false
              },
              {
                "text": "0",
                "truncated": false
              }
            ]
          },
          {
            "callee": "loadCrossEncoder",
            "line": 403,
            "column": 38,
            "endLine": 403,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "opts",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Math.max",
            "line": 405,
            "column": 21,
            "endLine": 405,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "1",
                "truncated": false
              },
              {
                "text": "opts.batchSize ?? DEFAULT_BATCH_SIZE",
                "truncated": false
              }
            ]
          },
          {
            "callee": "yieldToEventLoop",
            "line": 414,
            "column": 11,
            "endLine": 414,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "Date.now",
            "line": 415,
            "column": 35,
            "endLine": 415,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "texts.slice",
            "line": 421,
            "column": 19,
            "endLine": 421,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "start",
                "truncated": false
              },
              {
                "text": "start + batchSize",
                "truncated": false
              }
            ]
          },
          {
            "callee": "tokenizer",
            "line": 422,
            "column": 20,
            "endLine": 426,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "new Array(batch.length).fill(query)",
                "truncated": false
              },
              {
                "text": "{ text_pair: batch, padding: true, truncation: true, max_length: maxLength }",
                "truncated": false
              }
            ]
          },
          {
            "callee": "new Array(batch.length).fill",
            "line": 424,
            "column": 7,
            "endLine": 424,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "query",
                "truncated": false
              }
            ]
          },
          {
            "callee": "model",
            "line": 427,
            "column": 30,
            "endLine": 427,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "inputs",
                "truncated": false
              }
            ]
          },
          {
            "callee": "row.push",
            "line": 438,
            "column": 43,
            "endLine": 438,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "Number(logits.data[i * numLabels + l])",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Number",
            "line": 438,
            "column": 52,
            "endLine": 438,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "logits.data[i * numLabels + l]",
                "truncated": false
              }
            ]
          },
          {
            "callee": "scores.push",
            "line": 439,
            "column": 7,
            "endLine": 439,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "scoreFromLogits(row)",
                "truncated": false
              }
            ]
          },
          {
            "callee": "scoreFromLogits",
            "line": 439,
            "column": 19,
            "endLine": 439,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "row",
                "truncated": false
              }
            ]
          },
          {
            "callee": "runInScorerGate",
            "line": 473,
            "column": 16,
            "endLine": 475,
            "argumentCount": 3,
            "arguments": [
              {
                "text": "texts.length",
                "truncated": false
              },
              {
                "text": "opts.deadline",
                "truncated": false
              },
              {
                "text": "() =>\n    scoreCrossEncoderUngated(query, texts, opts)",
                "truncated": false
              }
            ]
          },
          {
            "callee": "scoreCrossEncoderUngated",
            "line": 474,
            "column": 5,
            "endLine": 474,
            "argumentCount": 3,
            "arguments": [
              {
                "text": "query",
                "truncated": false
              },
              {
                "text": "texts",
                "truncated": false
              },
              {
                "text": "opts",
                "truncated": false
              }
            ]
          },
          {
            "callee": "getRerankWorkerState",
            "line": 483,
            "column": 66,
            "endLine": 483,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "effectiveTarget",
            "line": 487,
            "column": 20,
            "endLine": 487,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "opts",
                "truncated": false
              }
            ]
          },
          {
            "callee": "scoreViaWorker",
            "line": 490,
            "column": 28,
            "endLine": 500,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "{\n        query,\n        texts,\n        model: opts.model ?? LOCAL_RERANKER_MODEL,\n        dtype: effective.dtype,\n        device: effective.device,\n        maxLength: opts.maxLeng",
                "truncated": true
              }
            ]
          },
          {
            "callee": "Math.max",
            "line": 497,
            "column": 20,
            "endLine": 497,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "1",
                "truncated": false
              },
              {
                "text": "opts.batchSize ?? DEFAULT_BATCH_SIZE",
                "truncated": false
              }
            ]
          },
          {
            "callee": "opts.observeFallback",
            "line": 501,
            "column": 13,
            "endLine": 501,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "'rerank-worker'",
                "truncated": false
              },
              {
                "text": "{ eligible: 1, applied: 1, reason: 'applied' }",
                "truncated": false
              }
            ]
          },
          {
            "callee": "isDeadlineFailure",
            "line": 507,
            "column": 11,
            "endLine": 507,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "err",
                "truncated": false
              }
            ]
          },
          {
            "callee": "warnRerankFallback",
            "line": 508,
            "column": 7,
            "endLine": 508,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "err",
                "truncated": false
              },
              {
                "text": "opts.observeFallback",
                "truncated": false
              }
            ]
          },
          {
            "callee": "opts.observeFallback",
            "line": 511,
            "column": 11,
            "endLine": 511,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "'rerank-worker'",
                "truncated": false
              },
              {
                "text": "{ eligible: 1, applied: 0, reason: 'worker-disabled' }",
                "truncated": false
              }
            ]
          },
          {
            "callee": "scoreCrossEncoderInline",
            "line": 514,
            "column": 16,
            "endLine": 514,
            "argumentCount": 3,
            "arguments": [
              {
                "text": "query",
                "truncated": false
              },
              {
                "text": "texts",
                "truncated": false
              },
              {
                "text": "opts",
                "truncated": false
              }
            ]
          },
          {
            "callee": "scoreCrossEncoder",
            "line": 529,
            "column": 18,
            "endLine": 529,
            "argumentCount": 3,
            "arguments": [
              {
                "text": "query",
                "truncated": false
              },
              {
                "text": "texts",
                "truncated": false
              },
              {
                "text": "opts",
                "truncated": false
              }
            ]
          },
          {
            "callee": "dynamicImport",
            "line": 539,
            "column": 11,
            "endLine": 539,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "TRANSFORMERS_PACKAGE",
                "truncated": false
              }
            ]
          },
          {
            "callee": "_models.clear",
            "line": 556,
            "column": 3,
            "endLine": 556,
            "argumentCount": 0,
            "arguments": []
          }
        ],
        "globals": []
      },
      {
        "repository": "libs/generic/rerank",
        "repositoryRevision": "40e78e06b07a94203e151a44979394acc2dbc871",
        "path": "src/scorer-gate.ts",
        "gitBlob": "57cc70ea08efdd476c8afa9af3da0e647fc6d29b",
        "sha256": "10a883a24c62748d3f83f11f7cd5d0417afc124dc860f90fed723a32c7b6f602",
        "bytes": 9054,
        "text": "/**\n * Deadline-aware admission control for the shared in-process cross-encoder.\n *\n * WHY (WI-37676). Every wall-clock bound in this library is PER-CALL, but the\n * in-process scorer is ONE shared resource. Measured on this box 2026-08-10,\n * over the real worker path, at 24 and at 100 pairs:\n *\n *     concurrency   1      2      4      8\n *     per-call     1.00x  2.04x  3.98x  7.68x   (of the solo wall clock)\n *     throughput   30.9   30.3   31.1   32.2    pairs/s\n *\n * Per-call latency is EXACTLY linear in the number of callers, and aggregate\n * throughput is flat. Two consequences, and the second is the whole point:\n *\n *  1. Concurrency buys NOTHING here. Admitting N callers at once does not\n *     finish the work sooner; it only spreads the same completion time over\n *     everyone. So serializing costs no throughput.\n *  2. Un-admitted concurrency makes failure CORRELATED. Once N exceeds\n *     budget/solo (~5 at the shipped 4s bound), every in-flight call blows its\n *     budget at roughly the same moment and the whole stage degrades at once —\n *     after each caller has spent its entire budget waiting. Nobody gets a\n *     reranked page and the CPU was burned producing none.\n *\n * This gate turns that into the strictly better outcome: callers that CAN make\n * their budget run one after another and succeed; a caller that provably cannot\n * is shed IMMEDIATELY, at ~0ms, with the same fail-safe passthrough it would\n * have reached the slow way. It gets the identical page, several seconds sooner.\n *\n * ⚠ SAFETY ARGUMENT FOR THE ESTIMATOR. The shed decision rests on a measured\n * cost estimate, which can be wrong in both directions — and neither direction\n * is worse than the status quo, which is what makes this safe to default ON:\n *  - over-shed  ⇒ a call that would have just squeaked in returns retrieval\n *                 order EARLY. Same rows, same order as the timeout it replaces.\n *  - under-shed ⇒ the call proceeds and may time out. Exactly today's behaviour.\n * The gate can therefore only move latency down and the success count up; it\n * cannot invent a failure that did not already exist.\n *\n * NOT for the sidecar's HTTP leg. This gates in-process scoring only — the\n * shared CPU. A sidecar call is someone else's capacity with its own retry\n * budget, and throttling it here would be throttling the wrong resource.\n */\n\n/**\n * A scoring attempt abandoned because it could not meet its caller's deadline.\n *\n * Shaped to match the message the engine and the worker already throw, so the\n * existing `/deadline exceeded/` handling in `scoreCrossEncoder` — \"this is a\n * real verdict, do NOT retry it inline\" — applies to a shed unchanged. Retrying\n * a shed inline would burn the very budget that just proved insufficient, on the\n * main thread.\n */\nexport class RerankDeadlineError extends Error {\n  constructor(message: string) {\n    super(message);\n    this.name = 'RerankDeadlineError';\n  }\n}\n\n/**\n * Did this failure mean \"too slow for your budget\" rather than \"could not score\"?\n *\n * Message matching is not laziness: the worker's throw crosses a thread\n * boundary, where a structured-clone of an Error keeps `message` and loses the\n * prototype, so `instanceof` is unavailable on exactly the path that matters\n * most. The class check is kept for the in-process throws it does work for.\n */\nexport function isDeadlineFailure(err: unknown): boolean {\n  if (err instanceof RerankDeadlineError) return true;\n  return err instanceof Error && /deadline exceeded/.test(err.message);\n}\n\n/** Env override for hosts where scoring genuinely parallelizes (a GPU target). */\nexport const RERANK_MAX_CONCURRENT_ENV = 'RERANK_MAX_CONCURRENT_SCORERS';\n\ninterface Waiter {\n  pairs: number;\n  deadline: number | undefined;\n  admit: () => void;\n  refuse: (err: Error) => void;\n}\n\nlet _maxConcurrent: number | null = null;\nlet _active = 0;\nlet _activePairs = 0;\nconst _queue: Waiter[] = [];\n\n/**\n * Exponentially-weighted mean ms per (query, doc) pair, measured from this\n * process's own completed jobs. `null` until calibrated — and while it is null\n * the gate NEVER sheds, because a shed decision taken from a guess is a made-up\n * failure. Serialization still applies; only the shedding waits for evidence.\n */\nlet _msPerPair: number | null = null;\nlet _observations = 0;\n\nfunction maxConcurrent(): number {\n  if (_maxConcurrent !== null) return _maxConcurrent;\n  const raw = Number(process.env[RERANK_MAX_CONCURRENT_ENV]);\n  _maxConcurrent = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;\n  return _maxConcurrent;\n}\n\n/**\n * Cost of everything that must finish before a newly-arriving job of `pairs`\n * pairs could complete, in ms. Uses TOTAL pairs of in-flight work as an upper\n * bound on what remains: a job halfway done is charged as if it had not started.\n * That errs toward shedding, which is the harmless direction (see the header).\n */\nfunction estimatedWaitMs(pairs: number): number | null {\n  if (_msPerPair === null) return null;\n  const backlog = _activePairs + _queue.reduce((n, w) => n + w.pairs, 0);\n  return (backlog + pairs) * _msPerPair;\n}\n\nfunction wouldMissDeadline(pairs: number, deadline: number | undefined): boolean {\n  if (deadline === undefined) return false;\n  const wait = estimatedWaitMs(pairs);\n  if (wait === null) return false;\n  return Date.now() + wait > deadline;\n}\n\nfunction shedError(pairs: number, deadline: number): RerankDeadlineError {\n  const wait = Math.round(estimatedWaitMs(pairs) ?? 0);\n  const budget = Math.max(0, deadline - Date.now());\n  return new RerankDeadlineError(\n    `rerank: scoring deadline exceeded after 0 of ${pairs} pairs — the shared scorer is ` +\n      `${_active} deep with ${_queue.length} queued, so this call needs ~${wait}ms against ` +\n      `${budget}ms of budget. Shedding now rather than spending the budget waiting.`,\n  );\n}\n\n/** Drain as many queued callers as the concurrency limit allows. */\nfunction pump(): void {\n  while (_queue.length > 0 && _active < maxConcurrent()) {\n    const w = _queue.shift()!;\n    // Re-check AT THE HEAD, not only on arrival: a caller admitted to the queue\n    // when the backlog was short can become undeliverable while it waits, and\n    // starting it then would spend a budget already known to be insufficient.\n    if (w.deadline !== undefined && wouldMissDeadline(w.pairs, w.deadline)) {\n      w.refuse(shedError(w.pairs, w.deadline));\n      continue;\n    }\n    _active++;\n    _activePairs += w.pairs;\n    w.admit();\n  }\n}\n\n/**\n * Run `fn` under the gate. Rejects with a {@link RerankDeadlineError} — without\n * ever calling `fn` — when the shared scorer provably cannot deliver in time.\n */\nexport async function runInScorerGate<T>(\n  pairs: number,\n  deadline: number | undefined,\n  fn: () => Promise<T>,\n): Promise<T> {\n  if (pairs <= 0) return await fn();\n\n  if (deadline !== undefined && wouldMissDeadline(pairs, deadline)) {\n    throw shedError(pairs, deadline);\n  }\n\n  await new Promise<void>((admit, refuse) => {\n    _queue.push({ pairs, deadline, admit, refuse });\n    pump();\n  });\n\n  const startedAt = Date.now();\n  const soloRun = _active === 1;\n  try {\n    return await fn();\n  } finally {\n    const elapsed = Date.now() - startedAt;\n    _active--;\n    _activePairs -= pairs;\n    // Calibrate only from a job that had the scorer to ITSELF — otherwise the\n    // sample measures contention, not cost, and the estimator would inflate\n    // under exactly the load it is meant to reason about.\n    //\n    // The FIRST observation is dropped: it pays this process's one-time model\n    // load (~1.2s here), which is not a per-pair cost and would otherwise seed\n    // the estimator an order of magnitude high and shed everything after it.\n    if (soloRun && elapsed > 0) {\n      _observations++;\n      if (_observations > 1) {\n        const sample = elapsed / pairs;\n        _msPerPair = _msPerPair === null ? sample : _msPerPair * 0.7 + sample * 0.3;\n      }\n    }\n    pump();\n  }\n}\n\n/** Diagnostics; also the seam the tests assert the invariants through. */\nexport function getScorerGateState(): {\n  active: number;\n  queued: number;\n  maxConcurrent: number;\n  msPerPair: number | null;\n  observations: number;\n} {\n  return {\n    active: _active,\n    queued: _queue.length,\n    maxConcurrent: maxConcurrent(),\n    msPerPair: _msPerPair,\n    observations: _observations,\n  };\n}\n\n/** Test seam: set the calibration directly instead of measuring it. */\nexport function _setScorerGateCalibrationForTest(msPerPair: number | null, observations = 2): void {\n  _msPerPair = msPerPair;\n  _observations = observations;\n}\n\n/** Test seam: override the concurrency limit (`null` ⇒ re-read the env). */\nexport function _setScorerGateConcurrencyForTest(n: number | null): void {\n  _maxConcurrent = n;\n}\n\n/** Test seam — same function under the codebase's `_reset*` convention. */\nexport function _resetScorerGateForTest(): void {\n  _maxConcurrent = null;\n  _active = 0;\n  _activePairs = 0;\n  _queue.length = 0;\n  _msPerPair = null;\n  _observations = 0;\n}\n",
        "parseDiagnostics": [],
        "moduleEdges": [],
        "dynamicImports": [],
        "constants": [
          {
            "name": "RERANK_MAX_CONCURRENT_ENV",
            "value": "RERANK_MAX_CONCURRENT_SCORERS",
            "line": 73,
            "column": 14,
            "endLine": 73
          }
        ],
        "calls": [
          {
            "callee": "super",
            "line": 54,
            "column": 5,
            "endLine": 54,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "message",
                "truncated": false
              }
            ]
          },
          {
            "callee": "/deadline exceeded/.test",
            "line": 69,
            "column": 34,
            "endLine": 69,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "err.message",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Number",
            "line": 98,
            "column": 15,
            "endLine": 98,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "process.env[RERANK_MAX_CONCURRENT_ENV]",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Number.isFinite",
            "line": 99,
            "column": 20,
            "endLine": 99,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "raw",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Math.floor",
            "line": 99,
            "column": 55,
            "endLine": 99,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "raw",
                "truncated": false
              }
            ]
          },
          {
            "callee": "_queue.reduce",
            "line": 111,
            "column": 34,
            "endLine": 111,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "(n, w) => n + w.pairs",
                "truncated": false
              },
              {
                "text": "0",
                "truncated": false
              }
            ]
          },
          {
            "callee": "estimatedWaitMs",
            "line": 117,
            "column": 16,
            "endLine": 117,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "pairs",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Date.now",
            "line": 119,
            "column": 10,
            "endLine": 119,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "Math.round",
            "line": 123,
            "column": 16,
            "endLine": 123,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "estimatedWaitMs(pairs) ?? 0",
                "truncated": false
              }
            ]
          },
          {
            "callee": "estimatedWaitMs",
            "line": 123,
            "column": 27,
            "endLine": 123,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "pairs",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Math.max",
            "line": 124,
            "column": 18,
            "endLine": 124,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "0",
                "truncated": false
              },
              {
                "text": "deadline - Date.now()",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Date.now",
            "line": 124,
            "column": 41,
            "endLine": 124,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "maxConcurrent",
            "line": 134,
            "column": 41,
            "endLine": 134,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "_queue.shift",
            "line": 135,
            "column": 15,
            "endLine": 135,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "wouldMissDeadline",
            "line": 139,
            "column": 37,
            "endLine": 139,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "w.pairs",
                "truncated": false
              },
              {
                "text": "w.deadline",
                "truncated": false
              }
            ]
          },
          {
            "callee": "w.refuse",
            "line": 140,
            "column": 7,
            "endLine": 140,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "shedError(w.pairs, w.deadline)",
                "truncated": false
              }
            ]
          },
          {
            "callee": "shedError",
            "line": 140,
            "column": 16,
            "endLine": 140,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "w.pairs",
                "truncated": false
              },
              {
                "text": "w.deadline",
                "truncated": false
              }
            ]
          },
          {
            "callee": "w.admit",
            "line": 145,
            "column": 5,
            "endLine": 145,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "fn",
            "line": 158,
            "column": 32,
            "endLine": 158,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "wouldMissDeadline",
            "line": 160,
            "column": 33,
            "endLine": 160,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "pairs",
                "truncated": false
              },
              {
                "text": "deadline",
                "truncated": false
              }
            ]
          },
          {
            "callee": "shedError",
            "line": 161,
            "column": 11,
            "endLine": 161,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "pairs",
                "truncated": false
              },
              {
                "text": "deadline",
                "truncated": false
              }
            ]
          },
          {
            "callee": "_queue.push",
            "line": 165,
            "column": 5,
            "endLine": 165,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "{ pairs, deadline, admit, refuse }",
                "truncated": false
              }
            ]
          },
          {
            "callee": "pump",
            "line": 166,
            "column": 5,
            "endLine": 166,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "Date.now",
            "line": 169,
            "column": 21,
            "endLine": 169,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "fn",
            "line": 172,
            "column": 18,
            "endLine": 172,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "Date.now",
            "line": 174,
            "column": 21,
            "endLine": 174,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "pump",
            "line": 191,
            "column": 5,
            "endLine": 191,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "maxConcurrent",
            "line": 206,
            "column": 20,
            "endLine": 206,
            "argumentCount": 0,
            "arguments": []
          }
        ],
        "globals": [
          {
            "name": "process.env",
            "line": 98,
            "column": 22,
            "endLine": 98
          }
        ]
      }
    ]
  },
  "verification": {
    "schema": "p001-rerank-engine-source-verification-v1",
    "method": "Independent Python hashlib SHA256 and git-blob SHA1 of git-show bytes versus Node crypto/git-cat-file capture; full text and explicit static/dynamic source assertions; relative target identities. AST is offline navigation only.",
    "extraction": {
      "path": "/tmp/p001-rerank-engine-source-extraction-20261106-v1.json",
      "bytes": 69470,
      "sha256": "0f1ce260e32692c2e5b55062861841b440eb8dbdedbe67b31700dcb1a9676384"
    },
    "checks": [
      {
        "repository": "libs/generic/rerank",
        "revision": "40e78e06b07a94203e151a44979394acc2dbc871",
        "path": "src/local-engine.ts",
        "sha256": "0d175f7d3e8206454626fa2ce614e69d040e3ac5ebbdf094fd3694b9bc61877d",
        "gitBlob": "fc3dad4ae91c448b87c0222800a98788f9afb7a2",
        "bytes": 25500,
        "textMatches": true,
        "metadataMatches": true,
        "staticImportAssertionsMatch": true,
        "dynamicImportAssertionsMatch": true,
        "resolvedModuleIdentitiesMatch": true,
        "diagnosticsEmpty": true
      },
      {
        "repository": "libs/generic/rerank",
        "revision": "40e78e06b07a94203e151a44979394acc2dbc871",
        "path": "src/scorer-gate.ts",
        "sha256": "10a883a24c62748d3f83f11f7cd5d0417afc124dc860f90fed723a32c7b6f602",
        "gitBlob": "57cc70ea08efdd476c8afa9af3da0e647fc6d29b",
        "bytes": 9054,
        "textMatches": true,
        "metadataMatches": true,
        "staticImportAssertionsMatch": true,
        "dynamicImportAssertionsMatch": true,
        "resolvedModuleIdentitiesMatch": true,
        "diagnosticsEmpty": true
      }
    ]
  },
  "scannerScope": {
    "parser": "TypeScript compiler API; offline only; candidate modules never imported",
    "moduleEdges": "Static declaration type-only binding markers and variable import syntax. Recorded literal bindings and call sites are source data, not evaluated loader resolution.",
    "calls": "All syntactic calls, locations, bounded argument snippets and full source text retained. Not complete effect inference.",
    "relativeResolution": "Pinned git tree relative candidates with independently checked identities. No inference of bundled tree-shaking or loaded runtime."
  },
  "sourceFindings": [
    {
      "path": "libs/generic/rerank/src/local-engine.ts",
      "findings": [
        {
          "lines": [
            24,
            30,
            31,
            32
          ],
          "finding": "Static runtime imports bind execution-target, local-reranker-worker and scorer-gate. Mixed type-only device/target bindings do not eliminate the runtime values."
        },
        {
          "lines": [
            139,
            147,
            179,
            181,
            182,
            539
          ],
          "finding": "The default model loader calls a dynamic-import wrapper using the TRANSFORMERS_PACKAGE literal @huggingface/transformers; from_pretrained is requested for tokenizer and classifier. localRerankAvailable also imports this package. Actual loader/package/native/cache/download closure is unmeasured."
        },
        {
          "symbols": [
            "effectiveTarget",
            "loadOnTarget",
            "reportDemotion"
          ],
          "finding": "Host/caller execution target choices, model/dtype/device memoization and sticky GPU-to-CPU demotion exist. Model/provider callback effects and cache artifacts are outside this source-only identity check."
        },
        {
          "lines": [
            473,
            483,
            490,
            508,
            514
          ],
          "finding": "scoreCrossEncoder is admitted by a concurrency gate, then scoreCrossEncoderUngated tries scoreViaWorker when enabled. A non-deadline worker failure warns and reaches inline scoring; this is an additional effect path requiring confinement proof in both contexts."
        },
        {
          "symbols": [
            "scoreCrossEncoderInline",
            "yieldToEventLoop",
            "localEngineScores",
            "_setLoaderForTest"
          ],
          "finding": "Inline scoring loads tokenizer/model, yields between batches and checks caller deadlines. Callback invocation, event-loop timers and observation/logging effects exist; localEngineScores returns null on error. Test loader setters mutate module state but are not runtime enforcement evidence."
        }
      ]
    },
    {
      "path": "libs/generic/rerank/src/scorer-gate.ts",
      "findings": [
        {
          "lines": [
            73,
            98
          ],
          "finding": "RERANK_MAX_CONCURRENT_SCORERS is read from process.env and cached as the maximum local concurrency. The source contains no import declarations or dynamic import syntax."
        },
        {
          "symbols": [
            "runInScorerGate",
            "pump",
            "wouldMissDeadline",
            "getScorerGateState"
          ],
          "finding": "Module-scoped counters, Promise queues, clock readings and measured per-pair costs admit/refuse caller callbacks. The supplied callback still runs with its surrounding runtime authority; this is workload scheduling rather than an OS boundary."
        },
        {
          "symbols": [
            "RerankDeadlineError",
            "isDeadlineFailure"
          ],
          "finding": "Deadline failures have typed/string matching used by the engine to avoid deadline-triggered inline fallbacks. Source identity does not prove an installed runtime executes that behavior."
        }
      ]
    }
  ],
  "populationStates": [
    {
      "population": "handler",
      "status": "unknown",
      "closureAccepted": false
    },
    {
      "population": "effect",
      "status": "unknown",
      "closureAccepted": false
    },
    {
      "population": "entry-point",
      "status": "unknown",
      "closureAccepted": false
    },
    {
      "population": "loader",
      "status": "unknown",
      "closureAccepted": false
    },
    {
      "population": "native-helper",
      "status": "unknown",
      "closureAccepted": false
    },
    {
      "population": "distribution",
      "status": "unknown",
      "closureAccepted": false
    },
    {
      "population": "observed-route",
      "status": "unknown",
      "closureAccepted": false
    }
  ],
  "missing": [
    "Complete configured occurrence and package-entry re-export populations.",
    "Execution-target and worker code closure; worker and inline branches plus @huggingface/transformers/native dependency effects.",
    "Independently committed row applicability and row-bound actual positive/negative enforcement evidence.",
    "Loaded current-build/distribution/platform identities, outside-lineage review and final exact signed installed-artifact proof."
  ],
  "applicabilityCommitted": false,
  "populationComplete": false,
  "closureAccepted": false,
  "executionAdmitted": false,
  "qualificationExecuted": false,
  "nextNamedSourceUnit": {
    "files": [
      {
        "repository": "libs/generic/rerank",
        "repositoryRevision": "40e78e06b07a94203e151a44979394acc2dbc871",
        "path": "src/execution-target.ts",
        "gitBlob": "6f7a3f806bad9f733df26afbecbd10a3f19427fe",
        "bytes": 6870,
        "sha256": "183936cbef9e11d98cf3b7ef0672bf4cd297551ed0ce7fc5811b194a979b6a37",
        "via": "./execution-target"
      },
      {
        "repository": "libs/generic/rerank",
        "repositoryRevision": "40e78e06b07a94203e151a44979394acc2dbc871",
        "path": "src/local-reranker-worker.ts",
        "gitBlob": "5b64cf164f510a6f72ce19f663e8a438c4b7e03a",
        "bytes": 20559,
        "sha256": "d58a9be8a3bf58d5f78debd24285af1253dcf7ace7118144c40a6948fe1c709f",
        "via": "./local-reranker-worker"
      }
    ],
    "externalDependency": {
      "specifier": "@huggingface/transformers",
      "via": "TRANSFORMERS_PACKAGE -> dynamicImport(specifier)",
      "identityStatus": "not-resolved-by-this-unit",
      "instruction": "Reuse retained root/package/lock evidence when resolving identity; dynamic import syntax is not an executed load."
    },
    "instruction": "Read the two exact named pinned relative sources next. Prior retained worker-preparation paths were checked for these names without a match; do not replay previously retained unrelated worker sources. Reuse v15 and prior proof; no unchanged-test/census replay."
  }
}
