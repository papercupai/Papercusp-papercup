---
rel_path: "security/p001-rerank-worker-source-extraction-20261106-v1.json"
updated_at: 1793939684215
_body: "content"
---

{
  "schema": "p001-rerank-worker-source-extraction-v1",
  "rootRevision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
  "analyzer": {
    "name": "typescript compiler API",
    "version": "6.0.3",
    "purpose": "offline parsing; no candidate imports or native binding loads"
  },
  "scope": {
    "files": 2,
    "calls": "all syntactic calls and constructors; not observed runtime effects",
    "candidateExecution": false
  },
  "rows": [
    {
      "repository": "libs/generic/rerank",
      "repositoryRevision": "40e78e06b07a94203e151a44979394acc2dbc871",
      "path": "src/execution-target.ts",
      "gitBlob": "6f7a3f806bad9f733df26afbecbd10a3f19427fe",
      "bytes": 6870,
      "sha256": "183936cbef9e11d98cf3b7ef0672bf4cd297551ed0ce7fc5811b194a979b6a37",
      "text": "/**\n * Host-aware execution target for the local cross-encoder (plan P-009).\n *\n * ## The one rule this file exists to enforce\n *\n * **dtype is not independently selectable — it is a property of the DEVICE.**\n * A weight format and an execution provider are chosen TOGETHER or not at all,\n * because the wrong half of the pair is worse than either whole:\n *\n * - `fp16` is a GPU format. x86 has no native fp16 compute, so ONNX Runtime's\n *   CPU provider casts every fp16 weight up to fp32 at inference time and pays\n *   the conversion on top of full-precision math. MEASURED on this stack, not\n *   assumed — see the plan's D-006.\n * - `q8` is the CPU-correct format: int8 kernels are native, the weights are ~4x\n *   smaller, and it preserves the ranking (D-006 measured top-1 agreement 1.000\n *   against fp32).\n *\n * So the selectable unit here is a `RerankExecutionTarget` — a (device, dtype)\n * PAIR — and every transition moves both fields at once. An API that let a\n * caller set `dtype: 'fp16'` while the device stayed `cpu` would make the single\n * worst configuration the easiest one to reach by accident.\n *\n * ## Why \"is there a GPU?\" is the wrong question\n *\n * Detecting a GPU is not the same as being able to USE one. The box this was\n * developed on has an RTX 3090, the CUDA 12 runtime, and ships ORT's CUDA\n * provider — and still cannot execute on it, because cuDNN 9 is absent, so\n * `libonnxruntime_providers_cuda.so` fails to load. Anything that keyed off\n * `nvidia-smi` finding a card would have selected the GPU target on that host,\n * failed to construct a session, and — because the engine is fail-safe — turned\n * every search into silent retrieval order with no reranking at all.\n *\n * Hence: the GPU target is opt-IN (`PAPERCUSP_RERANK_DEVICE`), and even when it\n * is opted into it is VERIFIED — see `local-engine.ts`, which falls back to the\n * CPU pair when a GPU session does not actually construct.\n */\n\n/** Execution providers this engine knows how to target. */\nexport type RerankDevice = 'cpu' | 'cuda' | 'webgpu';\n\nexport interface RerankExecutionTarget {\n  /** ONNX Runtime execution provider. */\n  device: RerankDevice;\n  /** ONNX weight format, valid ONLY in combination with `device`. */\n  dtype: string;\n  /** Why this pair — carried so a log line can explain itself. */\n  why: string;\n}\n\n/**\n * The safe default, and the fallback for every failed GPU attempt.\n *\n * D-006 measured on 4 pinned cores: q8 is 1.58x faster per pair than fp32 while\n * keeping top-1 agreement at 1.000 and NDCG@5 at 0.986, so it is the right CPU\n * default on quality grounds as well as cost.\n */\nexport const CPU_EXECUTION_TARGET: RerankExecutionTarget = Object.freeze({\n  device: 'cpu',\n  dtype: 'q8',\n  why: 'CPU provider: int8 kernels are native on x86, weights are ~4x smaller, and q8 preserves the ranking head (D-006)',\n});\n\n/** The GPU pair. fp16 is only ever correct WITH a GPU execution provider. */\nexport const CUDA_EXECUTION_TARGET: RerankExecutionTarget = Object.freeze({\n  device: 'cuda',\n  dtype: 'fp16',\n  why: 'CUDA provider: fp16 is native on the GPU, halves bandwidth, and avoids the int8 quantisation error entirely',\n});\n\n/** WebGPU (desktop shell / browser). fp16 is native there too. */\nexport const WEBGPU_EXECUTION_TARGET: RerankExecutionTarget = Object.freeze({\n  device: 'webgpu',\n  dtype: 'fp16',\n  why: 'WebGPU provider: fp16 is the native shader format',\n});\n\n/**\n * The CPU pair, tagged as the outcome of a FAILED GPU attempt.\n *\n * ## Why this exists at all\n *\n * A demotion changes WHY we are on CPU, never WHICH kernels run — so `device`\n * and `dtype` are exactly `CPU_EXECUTION_TARGET`'s and every consumer that\n * branches on them is unaffected. Only `why` differs, and that difference is\n * the entire point.\n *\n * Without it, a demoted host and a deliberate CPU host render BYTE-IDENTICALLY:\n * both report `cpu`/`q8` with the \"int8 kernels are native on x86\" rationale,\n * which reads as a healthy, considered choice. That collapse is not theoretical\n * — it is why a GPU capability that was measured working (17x on this box) could\n * silently revert and go unnoticed: the engine is fail-safe, so the only symptom\n * is slowness, and the one health surface built to reveal the demotion\n * (`rerankExecution` in the embed sidecar) had no value with which to say it.\n *\n * A degraded state that is indistinguishable from the healthy state is not\n * observable, however many places report it.\n */\nexport function demotedTarget(from: RerankExecutionTarget, cause: string): RerankExecutionTarget {\n  return Object.freeze({\n    device: CPU_EXECUTION_TARGET.device,\n    dtype: CPU_EXECUTION_TARGET.dtype,\n    why:\n      `DEMOTED from ${from.device}/${from.dtype} — that session would not construct on this host, ` +\n      `so reranking is running on ${CPU_EXECUTION_TARGET.device}/${CPU_EXECUTION_TARGET.dtype} ` +\n      `(correct, but materially slower than the requested target). Cause: ${cause}`,\n  });\n}\n\n/**\n * Opt a GPU host in. Unset/`cpu` ⇒ the CPU pair; `cuda`/`webgpu` ⇒ the matching\n * GPU pair, still subject to the verified-load fallback in the engine.\n *\n * Opt-IN rather than auto-detect, deliberately: an auto-probe would pay a failed\n * multi-second model load on every CPU host, and (see the file header) presence\n * of a GPU does not imply a usable one.\n */\nexport const RERANK_DEVICE_ENV = 'PAPERCUSP_RERANK_DEVICE';\n\nconst TARGETS_BY_DEVICE: Record<RerankDevice, RerankExecutionTarget> = {\n  cpu: CPU_EXECUTION_TARGET,\n  cuda: CUDA_EXECUTION_TARGET,\n  webgpu: WEBGPU_EXECUTION_TARGET,\n};\n\n/** The pair for a device. Total over `RerankDevice`, so a new device cannot be\n *  added without also stating its dtype. */\nexport function executionTargetFor(device: RerankDevice): RerankExecutionTarget {\n  return TARGETS_BY_DEVICE[device];\n}\n\n/**\n * Resolve this host's execution target from the environment.\n *\n * Unknown/misspelled values resolve to the CPU pair rather than throwing: a typo\n * in a deployment env var must not be able to take search down, and the CPU pair\n * is always a correct answer.\n */\nexport function resolveExecutionTarget(\n  env: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env,\n): RerankExecutionTarget {\n  const raw = (env[RERANK_DEVICE_ENV] ?? '').trim().toLowerCase();\n  if (raw === 'cuda' || raw === 'gpu') return CUDA_EXECUTION_TARGET;\n  if (raw === 'webgpu') return WEBGPU_EXECUTION_TARGET;\n  return CPU_EXECUTION_TARGET;\n}\n\n/** True when the pair is one this module vouches for. Guards the trap the whole\n *  file exists to prevent: a GPU weight format on the CPU provider. */\nexport function isCoherentTarget(target: { device: string; dtype: string }): boolean {\n  const known = TARGETS_BY_DEVICE[target.device as RerankDevice];\n  return known !== undefined && known.dtype === target.dtype;\n}\n",
      "parseDiagnostics": [],
      "moduleEdges": [],
      "calls": [
        {
          "callee": "Object.freeze",
          "line": 57,
          "column": 60,
          "endLine": 61,
          "arguments": [
            {
              "text": "{\n  device: 'cpu',\n  dtype: 'q8',\n  why: 'CPU provider: int8 kernels are native on x86, weights are ~4x smaller, and q8 preserves the ranking head (D-",
              "truncated": true
            }
          ]
        },
        {
          "callee": "Object.freeze",
          "line": 64,
          "column": 61,
          "endLine": 68,
          "arguments": [
            {
              "text": "{\n  device: 'cuda',\n  dtype: 'fp16',\n  why: 'CUDA provider: fp16 is native on the GPU, halves bandwidth, and avoids the int8 quantisation error entire",
              "truncated": true
            }
          ]
        },
        {
          "callee": "Object.freeze",
          "line": 71,
          "column": 63,
          "endLine": 75,
          "arguments": [
            {
              "text": "{\n  device: 'webgpu',\n  dtype: 'fp16',\n  why: 'WebGPU provider: fp16 is the native shader format',\n}",
              "truncated": false
            }
          ]
        },
        {
          "callee": "Object.freeze",
          "line": 99,
          "column": 10,
          "endLine": 106,
          "arguments": [
            {
              "text": "{\n    device: CPU_EXECUTION_TARGET.device,\n    dtype: CPU_EXECUTION_TARGET.dtype,\n    why:\n      `DEMOTED from ${from.device}/${from.dtype} — that ses",
              "truncated": true
            }
          ]
        },
        {
          "callee": "(env[RERANK_DEVICE_ENV] ?? '').trim().toLowerCase",
          "line": 141,
          "column": 15,
          "endLine": 141,
          "arguments": []
        },
        {
          "callee": "(env[RERANK_DEVICE_ENV] ?? '').trim",
          "line": 141,
          "column": 15,
          "endLine": 141,
          "arguments": []
        }
      ],
      "newExpressions": [],
      "constants": [
        {
          "name": "RERANK_DEVICE_ENV",
          "value": "PAPERCUSP_RERANK_DEVICE",
          "line": 117,
          "column": 14,
          "endLine": 117
        }
      ],
      "globals": [
        {
          "name": "process.env",
          "line": 139,
          "column": 83,
          "endLine": 139
        }
      ],
      "workerEntrypoints": []
    },
    {
      "repository": "libs/generic/rerank",
      "repositoryRevision": "40e78e06b07a94203e151a44979394acc2dbc871",
      "path": "src/local-reranker-worker.ts",
      "gitBlob": "5b64cf164f510a6f72ce19f663e8a438c4b7e03a",
      "bytes": 20559,
      "sha256": "d58a9be8a3bf58d5f78debd24285af1253dcf7ace7118144c40a6948fe1c709f",
      "text": "/**\n * Worker-thread isolated local cross-encoder.\n *\n * WHY (EI-20005411672741677, finished by WI-37555). A cross-encoder forward pass\n * is CPU-bound and holds its thread. On the MAIN thread that means nothing else\n * in the process progresses while it runs — including the `setTimeout` behind\n * every wall-clock bound in this lib, so no timer can preempt it. `local-engine`\n * yields between batches to make those bounds REAL, but that only bounds the\n * overrun to one batch (~720ms at the default 16 pairs). With the model here,\n * the caller's `Promise.race` bound becomes EXACT — the main thread is free to\n * service its own timers — and head-of-line blocking of unrelated work goes away.\n *\n * Architecture mirrors `@papercusp/memory`'s `local-embedder-worker.ts`: one\n * persistent worker per process, lazily spawned, holding the warm model(s);\n * main-thread requests marshal a batch over `postMessage` and await a pending\n * Promise keyed by id. Falls back to inline (main-thread) scoring whenever the\n * worker is unavailable — degraded, never broken.\n */\n\nimport { pinModuleState } from '@papercusp/module-singleton';\nimport { Worker } from 'node:worker_threads';\nimport { createRequire } from 'node:module';\nimport { fileURLToPath } from 'node:url';\nimport { resolve, dirname } from 'node:path';\nimport type { RerankDevice } from './execution-target';\n\ninterface PendingRequest {\n  resolve: (v: number[]) => void;\n  reject: (err: Error) => void;\n  observeFallback?: ScoreViaWorkerRequest['observeFallback'];\n}\n\ninterface WorkerState {\n  worker: Worker | null;\n  workerReady: Promise<void> | null;\n  nextId: number;\n  pending: Map<number, PendingRequest>;\n  /**\n   * Set ONLY for genuine, permanent unavailability — the worker could not be\n   * CONSTRUCTED at all (no `worker_threads`, missing script, spawn threw). A\n   * runtime crash deliberately does NOT set this: it clears the worker handle so\n   * the next call respawns one.\n   *\n   * That asymmetry is the point (the lesson EI-16184 taught the embedder path):\n   * treating a transient crash as permanent condemns every later call in the\n   * process to the inline, main-thread-blocking path — i.e. one hiccup silently\n   * undoes this whole module for the rest of the process's life.\n   */\n  workerDisabled: boolean;\n  /** Guards the process-level `beforeExit` hook so it is installed at most once,\n   *  however many times a worker (re)spawns. */\n  beforeExitHookInstalled: boolean;\n  beforeExitListener: (() => Promise<void>) | null;\n\n  /**\n   * Whether the worker is currently holding the event loop open. Mirrors the last\n   * `ref()`/`unref()` we issued, because `Worker` exposes no way to read it back.\n   */\n  refd: boolean;\n  lastFallbackWarnAt: number;\n  /** Outcome of `pinOnnxRuntimeBinding` (WI-10005090); null until the first spawn. */\n  onnxBindingPin?: OnnxBindingPin | null;\n  /** Workers detached while they owed answers, draining before terminate\n   *  (WI-10006567; mirrors the embedder's `retiring`). */\n  retiring?: Map<Worker, RetiringWorker>;\n}\n\ntype RetireOutcome = 'retired' | 'exited' | 'errored' | 'timed-out';\ninterface RetiringWorker {\n  done: Promise<void>;\n  settle: (outcome: RetireOutcome) => void;\n}\n\n/** Bound on waiting for a retiring rerank worker's in-flight scoring (WI-10006567). */\nexport const RERANK_WORKER_RETIRE_DRAIN_MS = 30_000;\n\n/** What `pinOnnxRuntimeBinding` achieved. Never thrown — reported. */\nexport type OnnxBindingPin =\n  | { status: 'pinned'; path: string }\n  | { status: 'unavailable'; reason: string }\n  | { status: 'failed'; reason: string };\n\n// tsx can evaluate this module through both CJS and ESM in one process.\n// Shutdown and health reads must see the worker started through either loader.\nconst state = pinModuleState<WorkerState>('@papercusp/rerank.local-reranker-worker', () => ({\n  worker: null, workerReady: null, nextId: 0, pending: new Map(),\n  workerDisabled: false, beforeExitHookInstalled: false, beforeExitListener: null,\n  refd: false, lastFallbackWarnAt: 0, onnxBindingPin: null,\n}));\n\nconst TRANSFORMERS_PACKAGE = '@huggingface/transformers';\n\n/**\n * Load the onnxruntime-node binding once in the spawning thread, before any\n * reranker worker loads it, and keep it for the life of the process.\n *\n * WI-10005090 (measured 2026-10-01, onnxruntime-node 1.24.3 / node 25.9): once\n * the last thread holding the binding exits, Node drops its registration while\n * the library stays mapped, so every later load in the process — a respawned\n * worker and the inline main-thread fallback — fails with \"Module did not\n * self-register\". Holding one reference keeps the registration. The embedder\n * worker (libs/generic/memory/src/local-embedder-worker.ts, same function name)\n * pins the same binding; the full measurement is documented there. Resolved\n * from the transformers package the worker script imports, so the pinned file\n * is the file the worker loads. Never throws; the first outcome stands.\n */\nexport function pinOnnxRuntimeBinding(fromPath: string): OnnxBindingPin {\n  if (!state.onnxBindingPin) state.onnxBindingPin = loadOnnxBindingFrom(fromPath);\n  return state.onnxBindingPin;\n}\n\nfunction loadOnnxBindingFrom(fromPath: string): OnnxBindingPin {\n  let transformersEntry: string;\n  try {\n    transformersEntry = createRequire(fromPath).resolve(TRANSFORMERS_PACKAGE);\n  } catch {\n    return { status: 'unavailable', reason: `${TRANSFORMERS_PACKAGE} is not resolvable from ${fromPath}` };\n  }\n  try {\n    const fromTransformers = createRequire(transformersEntry);\n    const path = fromTransformers.resolve('onnxruntime-node');\n    fromTransformers('onnxruntime-node');\n    return { status: 'pinned', path };\n  } catch (err) {\n    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };\n  }\n}\n\n/** The pin outcome, or null when no reranker worker has been spawned yet. */\nexport function getOnnxBindingPin(): OnnxBindingPin | null {\n  return state.onnxBindingPin ?? null;\n}\n\n/** Forget the recorded outcome (the binding stays loaded); for tests of a first-time pin. */\nexport function _resetOnnxBindingPinForTest(): void {\n  state.onnxBindingPin = null;\n}\n\n/**\n * Hold the loop open for EXACTLY as long as a request is in flight, and not one\n * moment longer.\n *\n * WHY BOTH HALVES ARE LOAD-BEARING (WI-37680). An always-ref'd worker keeps a\n * one-shot script alive forever — the bug the original `unref()` fixed. But an\n * always-UNREF'd worker is worse in a way that is silent: while the caller\n * awaits a reply, the unref'd worker (and its port) no longer count as loop\n * work, so a host with nothing else ref'd is considered IDLE **mid-request**.\n * `beforeExit` then fires, the hook below terminates the worker, and the exit\n * handler rejects the in-flight request with `rerank worker exited with code 1`\n * — which `scoreCrossEncoder` reads as \"the worker is unavailable\" and answers\n * by falling back to inline main-thread scoring.\n *\n * So the whole worker-thread mechanism silently did not apply on any host whose\n * loop is otherwise empty: every CLI, bench and one-off script. Those are\n * exactly the hosts where it was measured, which is how the inline path's\n * serialization got recorded as a property of the worker path (WI-37676).\n * Measured 2026-08-10: a `scoreViaWorker` with ZERO pairs — no model load at\n * all — failed this way 100% of the time from a standalone script.\n *\n * Ref'ing only while `state.pending` is non-empty satisfies both: a script that\n * awaits a rerank stays alive until its answer arrives, then exits naturally.\n */\nfunction syncWorkerRef(): void {\n  const want = state.pending.size > 0;\n  if (!state.worker || want === state.refd) return;\n  if (want) state.worker.ref();\n  else state.worker.unref();\n  state.refd = want;\n}\n\nfunction workerPath(): string {\n  // Co-located with this module, resolved at RUNTIME so the path survives\n  // build-time bundling — provided the build copies the script beside the\n  // bundle. It must: without that copy every rerank silently falls back to\n  // inline main-thread ONNX (the WI-4196 trap, which has already recurred once\n  // for a sibling worker). `bundle-host.sh` does the copy;\n  // `worker-scripts-bundled.test.ts` fails if a new worker script is missed.\n  const here = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);\n  return resolve(dirname(here), 'local-reranker-worker.script.mjs');\n}\n\nfunction ensureWorker(): Promise<void> {\n  if (state.workerDisabled) return Promise.reject(new Error('rerank worker disabled'));\n  if (state.workerReady) return state.workerReady;\n\n  state.workerReady = new Promise<void>((resolveReady, rejectReady) => {\n    let spawned: Worker;\n    try {\n      const scriptPath = workerPath();\n      // WI-10005090: before the first worker can load (and later release) the binding.\n      pinOnnxRuntimeBinding(scriptPath);\n      spawned = new Worker(scriptPath);\n    } catch (err) {\n      // Construction failed — genuinely unavailable, not a transient fault.\n      state.workerDisabled = true;\n      state.workerReady = null;\n      rejectReady(err as Error);\n      return;\n    }\n    // WI-10006567: handlers are scoped to THIS worker. A shutdown detaches a\n    // worker that owes answers and lets it drain; request ids restart at 0, so\n    // its late `score_ok` must never reach the replacement's pending map, and its\n    // late `exit` must never null the live handle.\n    const w = spawned;\n    state.worker = w;\n\n    let initialized = false;\n    w.on(\n      'message',\n      (msg: { kind: string; id?: number; scores?: number[]; error?: string; decision?: { eligible: number; applied: number; reason: string } }) => {\n        if (state.worker !== w) {\n          if (msg.kind === 'retired') state.retiring?.get(w)?.settle('retired');\n          else if (msg.kind === 'ready') rejectReady(new Error('rerank worker was shut down before it became ready'));\n          return;\n        }\n        if (msg.kind === 'ready') {\n          initialized = true;\n          // A REF'd worker keeps the event loop alive forever, so a one-off\n          // script that reranks once and ends could never exit naturally — and\n          // reaching for `process.exit()` tears the ONNX native addon down\n          // mid-flight (an unlabelled `Napi::Error` at teardown). Unref'ing lets\n          // such a script finish on its own; the beforeExit hook below then\n          // terminates the worker cleanly. Same reasoning as the embedder's\n          // EI-19464316359123796.\n          //\n          // A freshly constructed Worker is ref'd, so record that and let\n          // `syncWorkerRef` decide: idle ⇒ unref (the behaviour above), a\n          // request already in flight ⇒ stay ref'd until it answers (WI-37680).\n          state.refd = true;\n          syncWorkerRef();\n          installBeforeExitHook();\n          resolveReady();\n          return;\n        }\n        if (typeof msg.id !== 'number') return;\n        const p = state.pending.get(msg.id);\n        if (!p) return;\n        if (msg.kind === 'device_decision' && msg.decision) {\n          try { p.observeFallback?.('rerank-device', msg.decision); } catch { /* no-throw host sink */ }\n          return;\n        }\n        state.pending.delete(msg.id);\n        // Release the loop as soon as the LAST request settles, so a one-off\n        // script exits on its own.\n        syncWorkerRef();\n        if (msg.kind === 'score_ok' && Array.isArray(msg.scores)) p.resolve(msg.scores);\n        else p.reject(new Error(msg.error ?? 'rerank worker error'));\n      },\n    );\n\n    w.on('error', (err) => {\n      if (!initialized) rejectReady(err);\n      if (state.worker !== w) { state.retiring?.get(w)?.settle('errored'); return; }\n      // The worker crashed: fail every in-flight request, then clear the handle\n      // so the NEXT call respawns. Deliberately not `state.workerDisabled` — see its\n      // declaration.\n      for (const [, p] of state.pending) p.reject(err);\n      state.pending.clear();\n      state.worker = null;\n      state.workerReady = null;\n      state.refd = false;\n    });\n\n    w.on('exit', (code) => {\n      if (code !== 0 && !initialized) {\n        rejectReady(new Error(`rerank worker exited with code ${code} before ready`));\n      }\n      if (state.worker !== w) { state.retiring?.get(w)?.settle('exited'); return; }\n      // Reject anything still waiting — an exited worker will never answer it,\n      // and a request left pending forever would hang the caller past its bound.\n      for (const [, p] of state.pending) p.reject(new Error(`rerank worker exited with code ${code}`));\n      state.pending.clear();\n      state.worker = null;\n      state.workerReady = null;\n      state.refd = false;\n    });\n  }).catch((err) => {\n    state.workerReady = null;\n    throw err;\n  });\n\n  return state.workerReady;\n}\n\n/** The resolved, worker-side scoring request. Device/dtype are resolved on the\n *  MAIN thread and passed explicitly, so the engine's GPU-demotion logic stays\n *  in exactly one place rather than being duplicated across the thread seam. */\nexport interface ScoreViaWorkerRequest {\n  observeFallback?: (mechanism: string, decision: { eligible: number; applied: number; reason: string }) => unknown;\n  query: string;\n  texts: string[];\n  model: string;\n  dtype: string;\n  device: RerankDevice;\n  maxLength: number;\n  batchSize: number;\n  deadline?: number;\n}\n\n/**\n * Score a batch on the worker thread. Rejects when the worker is unavailable or\n * the scoring itself failed — callers fall back to inline scoring.\n */\nexport async function scoreViaWorker(req: ScoreViaWorkerRequest): Promise<number[]> {\n  await ensureWorker();\n  if (!state.worker) throw new Error('rerank worker not initialized');\n\n  const id = state.nextId++;\n  return new Promise<number[]>((resolveScore, rejectScore) => {\n    const { observeFallback, ...payload } = req;\n    state.pending.set(id, { resolve: resolveScore, reject: rejectScore, observeFallback });\n    // Ref BEFORE posting: between the post and the reply the caller is awaiting\n    // a Promise, which is not loop work — an unref'd worker would leave the loop\n    // looking idle and let `beforeExit` terminate this very request.\n    syncWorkerRef();\n    state.worker!.postMessage({ kind: 'score', id, ...payload });\n  });\n}\n\n/** Terminate the persistent rerank worker, if any. Await this before an\n *  explicit `process.exit()` in a standalone script — `terminate()` runs the\n *  worker isolate's normal cleanup (including the ONNX addon's finalizers),\n *  which `process.exit()` skips. */\nexport async function shutdownLocalReranker(opts: { drainMs?: number } = {}): Promise<void> {\n  const old = state.worker;\n  const owed = state.pending.size;\n  // Detach first (WI-10006567): the old worker's handlers stop touching module\n  // state, and the next score spawns a replacement instead of waiting the drain.\n  state.worker = null;\n  state.workerReady = null;\n  state.workerDisabled = false;\n  state.refd = false;\n  // Reject, never silently drop: a cleared-but-unsettled request hangs its caller.\n  if (state.pending.size > 0) {\n    const err = new Error(`rerank worker was shut down while ${state.pending.size} request(s) were in flight`);\n    for (const [, p] of state.pending) p.reject(err);\n  }\n  state.pending.clear();\n  state.nextId = 0;\n  // An exited worker needs neither retirement nor termination. Bun 1.3.14\n  // leaves terminate() pending after exit; callers were already rejected above.\n  if (old && old.threadId !== -1) {\n    // A worker that owed answers may be mid-run; terminating it then aborts the\n    // process. `opts?.`: a `.then(shutdownLocalReranker)` can pass null.\n    if (owed > 0) void retireWorker(old, opts?.drainMs ?? RERANK_WORKER_RETIRE_DRAIN_MS);\n    else { try { await old.terminate(); } catch { /* already gone */ } }\n  }\n  // Resolves only once no worker of this module is alive, including one an\n  // earlier shutdown is still retiring.\n  await Promise.all([...(state.retiring?.values() ?? [])].map((r) => r.done));\n}\n\n/** Terminate a detached worker only once it reports no scoring in flight, bounded\n *  by `drainMs` (WI-10006567; the embedder's `retireWorker` documents why). */\nfunction retireWorker(w: Worker, drainMs: number): Promise<void> {\n  const retiring = (state.retiring ??= new Map());\n  const existing = retiring.get(w);\n  if (existing) return existing.done;\n  let settle: (outcome: RetireOutcome) => void = () => {};\n  const outcome = new Promise<RetireOutcome>((resolve) => { settle = resolve; });\n  const timer = setTimeout(() => settle('timed-out'), drainMs);\n  timer.unref?.();\n  const done = outcome.then(async (how) => {\n    clearTimeout(timer);\n    if (how === 'timed-out') {\n      console.warn(`[rerank-worker] retiring worker did not report retired within ${drainMs}ms; terminating it anyway `\n        + '(WI-10006567: terminating during a native run can abort the process)');\n    }\n    // The worker may exit before this retired/error continuation runs.\n    if (how !== 'exited' && w.threadId !== -1) {\n      try { await w.terminate(); } catch { /* already gone */ }\n    }\n    retiring.delete(w);\n  });\n  retiring.set(w, { done, settle });\n  try { w.ref(); } catch { /* exiting already; its exit handler settles */ }\n  try { w.postMessage({ kind: 'retire' }); } catch { settle('errored'); }\n  return done;\n}\n\n/** Test seam — same function under the codebase's `_reset*` convention. */\nexport const _resetRerankWorkerForTest = shutdownLocalReranker;\n\nfunction installBeforeExitHook(): void {\n  if (state.beforeExitHookInstalled) return;\n  state.beforeExitHookInstalled = true;\n  // `beforeExit` (unlike `exit`) permits async work, which is required because\n  // `terminate()` returns a Promise. It fires only once the loop would go idle,\n  // which is exactly why the worker unrefs itself above.\n  //\n  // The pending guard is belt-and-braces: `syncWorkerRef` should make an idle\n  // loop impossible while a request is in flight, so this branch is unreachable\n  // by design. It stays because the failure it prevents (terminating a worker\n  // mid-request, which the caller then reads as \"no worker available\") is\n  // silent, and because a future ref bug would otherwise re-open it.\n  state.beforeExitListener = async () => {\n    if (state.pending.size > 0) return;\n    await shutdownLocalReranker();\n  };\n  process.on('beforeExit', state.beforeExitListener);\n}\n\n/** Test-only: remove the installed hook and clear the guard. */\nexport function _resetBeforeExitHookForTest(): void {\n  if (state.beforeExitListener) process.off('beforeExit', state.beforeExitListener);\n  state.beforeExitListener = null;\n  state.beforeExitHookInstalled = false;\n}\n\n/** Telemetry for health checks and diagnostics. */\nexport function getRerankWorkerState(): {\n  alive: boolean;\n  disabled: boolean;\n  pendingCount: number;\n  /**\n   * True while the worker is holding the event loop open — i.e. a request is in\n   * flight. Must track `pendingCount > 0` exactly: a `false` here with pending\n   * work is the WI-37680 defect (`beforeExit` fires mid-request and terminates\n   * the worker), and a `true` with none keeps a one-off script alive forever.\n   */\n  keepAlive: boolean;\n} {\n  return {\n    alive: state.worker !== null,\n    disabled: state.workerDisabled,\n    pendingCount: state.pending.size,\n    keepAlive: state.refd,\n  };\n}\n\n/**\n * Rate-limited warning for a fall back to inline (main-thread-blocking)\n * scoring. Every call retries the worker (a crashed one respawns), so a\n * SUSTAINED failure would otherwise warn on every single rerank.\n */\nconst FALLBACK_WARN_COOLDOWN_MS = 30_000;\nexport function warnRerankFallback(err: unknown, observeFallback?: (mechanism: string, decision: { eligible: number; applied: number; reason: string }) => unknown): void {\n  try { observeFallback?.('rerank-worker', { eligible: 1, applied: 0, reason: 'worker-failed' }); } catch { /* no-throw host sink */ }\n  const now = Date.now();\n  if (now - state.lastFallbackWarnAt < FALLBACK_WARN_COOLDOWN_MS) return;\n  state.lastFallbackWarnAt = now;\n  if (process.env.NODE_ENV !== 'test') {\n    console.warn(\n      '[rerank] worker path failed — falling back to inline (main-thread, blocks the event loop) ' +\n        `for this call, so the timeout bound is only accurate to one batch: ${\n          err instanceof Error ? err.message : String(err)\n        }`,\n    );\n  }\n}\n\n/** Test-only: reset the fallback-warn cooldown. */\nexport function _resetFallbackWarnForTest(): void {\n  state.lastFallbackWarnAt = 0;\n}\n",
      "parseDiagnostics": [],
      "moduleEdges": [
        {
          "specifier": "@papercusp/module-singleton",
          "typeOnly": false,
          "named": [
            {
              "name": "pinModuleState",
              "imported": "pinModuleState",
              "typeOnly": false
            }
          ],
          "line": 20,
          "column": 1,
          "endLine": 20,
          "resolved": []
        },
        {
          "specifier": "node:worker_threads",
          "typeOnly": false,
          "named": [
            {
              "name": "Worker",
              "imported": "Worker",
              "typeOnly": false
            }
          ],
          "line": 21,
          "column": 1,
          "endLine": 21,
          "resolved": []
        },
        {
          "specifier": "node:module",
          "typeOnly": false,
          "named": [
            {
              "name": "createRequire",
              "imported": "createRequire",
              "typeOnly": false
            }
          ],
          "line": 22,
          "column": 1,
          "endLine": 22,
          "resolved": []
        },
        {
          "specifier": "node:url",
          "typeOnly": false,
          "named": [
            {
              "name": "fileURLToPath",
              "imported": "fileURLToPath",
              "typeOnly": false
            }
          ],
          "line": 23,
          "column": 1,
          "endLine": 23,
          "resolved": []
        },
        {
          "specifier": "node:path",
          "typeOnly": false,
          "named": [
            {
              "name": "resolve",
              "imported": "resolve",
              "typeOnly": false
            },
            {
              "name": "dirname",
              "imported": "dirname",
              "typeOnly": false
            }
          ],
          "line": 24,
          "column": 1,
          "endLine": 24,
          "resolved": []
        },
        {
          "specifier": "./execution-target",
          "typeOnly": true,
          "named": [
            {
              "name": "RerankDevice",
              "imported": "RerankDevice",
              "typeOnly": true
            }
          ],
          "line": 25,
          "column": 1,
          "endLine": 25,
          "resolved": [
            {
              "path": "src/execution-target.ts",
              "gitBlob": "6f7a3f806bad9f733df26afbecbd10a3f19427fe",
              "bytes": 6870,
              "sha256": "183936cbef9e11d98cf3b7ef0672bf4cd297551ed0ce7fc5811b194a979b6a37"
            }
          ]
        }
      ],
      "calls": [
        {
          "callee": "pinModuleState",
          "line": 85,
          "column": 15,
          "endLine": 89,
          "arguments": [
            {
              "text": "'@papercusp/rerank.local-reranker-worker'",
              "truncated": false
            },
            {
              "text": "() => ({\n  worker: null, workerReady: null, nextId: 0, pending: new Map(),\n  workerDisabled: false, beforeExitHookInstalled: false, beforeExitListener",
              "truncated": true
            }
          ]
        },
        {
          "callee": "loadOnnxBindingFrom",
          "line": 108,
          "column": 53,
          "endLine": 108,
          "arguments": [
            {
              "text": "fromPath",
              "truncated": false
            }
          ]
        },
        {
          "callee": "createRequire(fromPath).resolve",
          "line": 115,
          "column": 25,
          "endLine": 115,
          "arguments": [
            {
              "text": "TRANSFORMERS_PACKAGE",
              "truncated": false
            }
          ]
        },
        {
          "callee": "createRequire",
          "line": 115,
          "column": 25,
          "endLine": 115,
          "arguments": [
            {
              "text": "fromPath",
              "truncated": false
            }
          ]
        },
        {
          "callee": "createRequire",
          "line": 120,
          "column": 30,
          "endLine": 120,
          "arguments": [
            {
              "text": "transformersEntry",
              "truncated": false
            }
          ]
        },
        {
          "callee": "fromTransformers.resolve",
          "line": 121,
          "column": 18,
          "endLine": 121,
          "arguments": [
            {
              "text": "'onnxruntime-node'",
              "truncated": false
            }
          ]
        },
        {
          "callee": "fromTransformers",
          "line": 122,
          "column": 5,
          "endLine": 122,
          "arguments": [
            {
              "text": "'onnxruntime-node'",
              "truncated": false
            }
          ]
        },
        {
          "callee": "String",
          "line": 125,
          "column": 77,
          "endLine": 125,
          "arguments": [
            {
              "text": "err",
              "truncated": false
            }
          ]
        },
        {
          "callee": "state.worker.ref",
          "line": 166,
          "column": 13,
          "endLine": 166,
          "arguments": []
        },
        {
          "callee": "state.worker.unref",
          "line": 167,
          "column": 8,
          "endLine": 167,
          "arguments": []
        },
        {
          "callee": "fileURLToPath",
          "line": 178,
          "column": 65,
          "endLine": 178,
          "arguments": [
            {
              "text": "import.meta.url",
              "truncated": false
            }
          ]
        },
        {
          "callee": "resolve",
          "line": 179,
          "column": 10,
          "endLine": 179,
          "arguments": [
            {
              "text": "dirname(here)",
              "truncated": false
            },
            {
              "text": "'local-reranker-worker.script.mjs'",
              "truncated": false
            }
          ]
        },
        {
          "callee": "dirname",
          "line": 179,
          "column": 18,
          "endLine": 179,
          "arguments": [
            {
              "text": "here",
              "truncated": false
            }
          ]
        },
        {
          "callee": "Promise.reject",
          "line": 183,
          "column": 36,
          "endLine": 183,
          "arguments": [
            {
              "text": "new Error('rerank worker disabled')",
              "truncated": false
            }
          ]
        },
        {
          "callee": "new Promise<void>((resolveReady, rejectReady) => {\n    let spawned: Worker;\n    try {\n      const scriptPath = workerPath();\n      // WI-10005090: before the first worker can load (and later release) the binding.\n      pinOnnxRuntimeBinding(scriptPath);\n      spawned = new Worker(scriptPath);\n    } catch (err) {\n      // Construction failed — genuinely unavailable, not a transient fault.\n      state.workerDisabled = true;\n      state.workerReady = null;\n      rejectReady(err as Error);\n      return;\n    }\n    // WI-10006567: handlers are scoped to THIS worker. A shutdown detaches a\n    // worker that owes answers and lets it drain; request ids restart at 0, so\n    // its late `score_ok` must never reach the replacement's pending map, and its\n    // late `exit` must never null the live handle.\n    const w = spawned;\n    state.worker = w;\n\n    let initialized = false;\n    w.on(\n      'message',\n      (msg: { kind: string; id?: number; scores?: number[]; error?: string; decision?: { eligible: number; applied: number; reason: string } }) => {\n        if (state.worker !== w) {\n          if (msg.kind === 'retired') state.retiring?.get(w)?.settle('retired');\n          else if (msg.kind === 'ready') rejectReady(new Error('rerank worker was shut down before it became ready'));\n          return;\n        }\n        if (msg.kind === 'ready') {\n          initialized = true;\n          // A REF'd worker keeps the event loop alive forever, so a one-off\n          // script that reranks once and ends could never exit naturally — and\n          // reaching for `process.exit()` tears the ONNX native addon down\n          // mid-flight (an unlabelled `Napi::Error` at teardown). Unref'ing lets\n          // such a script finish on its own; the beforeExit hook below then\n          // terminates the worker cleanly. Same reasoning as the embedder's\n          // EI-19464316359123796.\n          //\n          // A freshly constructed Worker is ref'd, so record that and let\n          // `syncWorkerRef` decide: idle ⇒ unref (the behaviour above), a\n          // request already in flight ⇒ stay ref'd until it answers (WI-37680).\n          state.refd = true;\n          syncWorkerRef();\n          installBeforeExitHook();\n          resolveReady();\n          return;\n        }\n        if (typeof msg.id !== 'number') return;\n        const p = state.pending.get(msg.id);\n        if (!p) return;\n        if (msg.kind === 'device_decision' && msg.decision) {\n          try { p.observeFallback?.('rerank-device', msg.decision); } catch { /* no-throw host sink */ }\n          return;\n        }\n        state.pending.delete(msg.id);\n        // Release the loop as soon as the LAST request settles, so a one-off\n        // script exits on its own.\n        syncWorkerRef();\n        if (msg.kind === 'score_ok' && Array.isArray(msg.scores)) p.resolve(msg.scores);\n        else p.reject(new Error(msg.error ?? 'rerank worker error'));\n      },\n    );\n\n    w.on('error', (err) => {\n      if (!initialized) rejectReady(err);\n      if (state.worker !== w) { state.retiring?.get(w)?.settle('errored'); return; }\n      // The worker crashed: fail every in-flight request, then clear the handle\n      // so the NEXT call respawns. Deliberately not `state.workerDisabled` — see its\n      // declaration.\n      for (const [, p] of state.pending) p.reject(err);\n      state.pending.clear();\n      state.worker = null;\n      state.workerReady = null;\n      state.refd = false;\n    });\n\n    w.on('exit', (code) => {\n      if (code !== 0 && !initialized) {\n        rejectReady(new Error(`rerank worker exited with code ${code} before ready`));\n      }\n      if (state.worker !== w) { state.retiring?.get(w)?.settle('exited'); return; }\n      // Reject anything still waiting — an exited worker will never answer it,\n      // and a request left pending forever would hang the caller past its bound.\n      for (const [, p] of state.pending) p.reject(new Error(`rerank worker exited with code ${code}`));\n      state.pending.clear();\n      state.worker = null;\n      state.workerReady = null;\n      state.refd = false;\n    });\n  }).catch",
          "line": 186,
          "column": 23,
          "endLine": 280,
          "arguments": [
            {
              "text": "(err) => {\n    state.workerReady = null;\n    throw err;\n  }",
              "truncated": false
            }
          ]
        },
        {
          "callee": "workerPath",
          "line": 189,
          "column": 26,
          "endLine": 189,
          "arguments": []
        },
        {
          "callee": "pinOnnxRuntimeBinding",
          "line": 191,
          "column": 7,
          "endLine": 191,
          "arguments": [
            {
              "text": "scriptPath",
              "truncated": false
            }
          ]
        },
        {
          "callee": "rejectReady",
          "line": 197,
          "column": 7,
          "endLine": 197,
          "arguments": [
            {
              "text": "err as Error",
              "truncated": false
            }
          ]
        },
        {
          "callee": "w.on",
          "line": 208,
          "column": 5,
          "endLine": 249,
          "arguments": [
            {
              "text": "'message'",
              "truncated": false
            },
            {
              "text": "(msg: { kind: string; id?: number; scores?: number[]; error?: string; decision?: { eligible: number; applied: number; reason: string } }) => {\n       ",
              "truncated": true
            }
          ]
        },
        {
          "callee": "state.retiring?.get(w)?.settle",
          "line": 212,
          "column": 39,
          "endLine": 212,
          "arguments": [
            {
              "text": "'retired'",
              "truncated": false
            }
          ]
        },
        {
          "callee": "state.retiring?.get",
          "line": 212,
          "column": 39,
          "endLine": 212,
          "arguments": [
            {
              "text": "w",
              "truncated": false
            }
          ]
        },
        {
          "callee": "rejectReady",
          "line": 213,
          "column": 42,
          "endLine": 213,
          "arguments": [
            {
              "text": "new Error('rerank worker was shut down before it became ready')",
              "truncated": false
            }
          ]
        },
        {
          "callee": "syncWorkerRef",
          "line": 230,
          "column": 11,
          "endLine": 230,
          "arguments": []
        },
        {
          "callee": "installBeforeExitHook",
          "line": 231,
          "column": 11,
          "endLine": 231,
          "arguments": []
        },
        {
          "callee": "resolveReady",
          "line": 232,
          "column": 11,
          "endLine": 232,
          "arguments": []
        },
        {
          "callee": "state.pending.get",
          "line": 236,
          "column": 19,
          "endLine": 236,
          "arguments": [
            {
              "text": "msg.id",
              "truncated": false
            }
          ]
        },
        {
          "callee": "p.observeFallback",
          "line": 239,
          "column": 17,
          "endLine": 239,
          "arguments": [
            {
              "text": "'rerank-device'",
              "truncated": false
            },
            {
              "text": "msg.decision",
              "truncated": false
            }
          ]
        },
        {
          "callee": "state.pending.delete",
          "line": 242,
          "column": 9,
          "endLine": 242,
          "arguments": [
            {
              "text": "msg.id",
              "truncated": false
            }
          ]
        },
        {
          "callee": "syncWorkerRef",
          "line": 245,
          "column": 9,
          "endLine": 245,
          "arguments": []
        },
        {
          "callee": "Array.isArray",
          "line": 246,
          "column": 40,
          "endLine": 246,
          "arguments": [
            {
              "text": "msg.scores",
              "truncated": false
            }
          ]
        },
        {
          "callee": "p.resolve",
          "line": 246,
          "column": 67,
          "endLine": 246,
          "arguments": [
            {
              "text": "msg.scores",
              "truncated": false
            }
          ]
        },
        {
          "callee": "p.reject",
          "line": 247,
          "column": 14,
          "endLine": 247,
          "arguments": [
            {
              "text": "new Error(msg.error ?? 'rerank worker error')",
              "truncated": false
            }
          ]
        },
        {
          "callee": "w.on",
          "line": 251,
          "column": 5,
          "endLine": 262,
          "arguments": [
            {
              "text": "'error'",
              "truncated": false
            },
            {
              "text": "(err) => {\n      if (!initialized) rejectReady(err);\n      if (state.worker !== w) { state.retiring?.get(w)?.settle('errored'); return; }\n      // The",
              "truncated": true
            }
          ]
        },
        {
          "callee": "rejectReady",
          "line": 252,
          "column": 25,
          "endLine": 252,
          "arguments": [
            {
              "text": "err",
              "truncated": false
            }
          ]
        },
        {
          "callee": "state.retiring?.get(w)?.settle",
          "line": 253,
          "column": 33,
          "endLine": 253,
          "arguments": [
            {
              "text": "'errored'",
              "truncated": false
            }
          ]
        },
        {
          "callee": "state.retiring?.get",
          "line": 253,
          "column": 33,
          "endLine": 253,
          "arguments": [
            {
              "text": "w",
              "truncated": false
            }
          ]
        },
        {
          "callee": "p.reject",
          "line": 257,
          "column": 42,
          "endLine": 257,
          "arguments": [
            {
              "text": "err",
              "truncated": false
            }
          ]
        },
        {
          "callee": "state.pending.clear",
          "line": 258,
          "column": 7,
          "endLine": 258,
          "arguments": []
        },
        {
          "callee": "w.on",
          "line": 264,
          "column": 5,
          "endLine": 276,
          "arguments": [
            {
              "text": "'exit'",
              "truncated": false
            },
            {
              "text": "(code) => {\n      if (code !== 0 && !initialized) {\n        rejectReady(new Error(`rerank worker exited with code ${code} before ready`));\n      }\n   ",
              "truncated": true
            }
          ]
        },
        {
          "callee": "rejectReady",
          "line": 266,
          "column": 9,
          "endLine": 266,
          "arguments": [
            {
              "text": "new Error(`rerank worker exited with code ${code} before ready`)",
              "truncated": false
            }
          ]
        },
        {
          "callee": "state.retiring?.get(w)?.settle",
          "line": 268,
          "column": 33,
          "endLine": 268,
          "arguments": [
            {
              "text": "'exited'",
              "truncated": false
            }
          ]
        },
        {
          "callee": "state.retiring?.get",
          "line": 268,
          "column": 33,
          "endLine": 268,
          "arguments": [
            {
              "text": "w",
              "truncated": false
            }
          ]
        },
        {
          "callee": "p.reject",
          "line": 271,
          "column": 42,
          "endLine": 271,
          "arguments": [
            {
              "text": "new Error(`rerank worker exited with code ${code}`)",
              "truncated": false
            }
          ]
        },
        {
          "callee": "state.pending.clear",
          "line": 272,
          "column": 7,
          "endLine": 272,
          "arguments": []
        },
        {
          "callee": "ensureWorker",
          "line": 305,
          "column": 9,
          "endLine": 305,
          "arguments": []
        },
        {
          "callee": "state.pending.set",
          "line": 311,
          "column": 5,
          "endLine": 311,
          "arguments": [
            {
              "text": "id",
              "truncated": false
            },
            {
              "text": "{ resolve: resolveScore, reject: rejectScore, observeFallback }",
              "truncated": false
            }
          ]
        },
        {
          "callee": "syncWorkerRef",
          "line": 315,
          "column": 5,
          "endLine": 315,
          "arguments": []
        },
        {
          "callee": "state.worker!.postMessage",
          "line": 316,
          "column": 5,
          "endLine": 316,
          "arguments": [
            {
              "text": "{ kind: 'score', id, ...payload }",
              "truncated": false
            }
          ]
        },
        {
          "callee": "p.reject",
          "line": 336,
          "column": 40,
          "endLine": 336,
          "arguments": [
            {
              "text": "err",
              "truncated": false
            }
          ]
        },
        {
          "callee": "state.pending.clear",
          "line": 338,
          "column": 3,
          "endLine": 338,
          "arguments": []
        },
        {
          "callee": "retireWorker",
          "line": 345,
          "column": 24,
          "endLine": 345,
          "arguments": [
            {
              "text": "old",
              "truncated": false
            },
            {
              "text": "opts?.drainMs ?? RERANK_WORKER_RETIRE_DRAIN_MS",
              "truncated": false
            }
          ]
        },
        {
          "callee": "old.terminate",
          "line": 346,
          "column": 24,
          "endLine": 346,
          "arguments": []
        },
        {
          "callee": "Promise.all",
          "line": 350,
          "column": 9,
          "endLine": 350,
          "arguments": [
            {
              "text": "[...(state.retiring?.values() ?? [])].map((r) => r.done)",
              "truncated": false
            }
          ]
        },
        {
          "callee": "[...(state.retiring?.values() ?? [])].map",
          "line": 350,
          "column": 21,
          "endLine": 350,
          "arguments": [
            {
              "text": "(r) => r.done",
              "truncated": false
            }
          ]
        },
        {
          "callee": "state.retiring?.values",
          "line": 350,
          "column": 26,
          "endLine": 350,
          "arguments": []
        },
        {
          "callee": "retiring.get",
          "line": 357,
          "column": 20,
          "endLine": 357,
          "arguments": [
            {
              "text": "w",
              "truncated": false
            }
          ]
        },
        {
          "callee": "setTimeout",
          "line": 361,
          "column": 17,
          "endLine": 361,
          "arguments": [
            {
              "text": "() => settle('timed-out')",
              "truncated": false
            },
            {
              "text": "drainMs",
              "truncated": false
            }
          ]
        },
        {
          "callee": "settle",
          "line": 361,
          "column": 34,
          "endLine": 361,
          "arguments": [
            {
              "text": "'timed-out'",
              "truncated": false
            }
          ]
        },
        {
          "callee": "timer.unref",
          "line": 362,
          "column": 3,
          "endLine": 362,
          "arguments": []
        },
        {
          "callee": "outcome.then",
          "line": 363,
          "column": 16,
          "endLine": 374,
          "arguments": [
            {
              "text": "async (how) => {\n    clearTimeout(timer);\n    if (how === 'timed-out') {\n      console.warn(`[rerank-worker] retiring worker did not report retired wi",
              "truncated": true
            }
          ]
        },
        {
          "callee": "clearTimeout",
          "line": 364,
          "column": 5,
          "endLine": 364,
          "arguments": [
            {
              "text": "timer",
              "truncated": false
            }
          ]
        },
        {
          "callee": "console.warn",
          "line": 366,
          "column": 7,
          "endLine": 367,
          "arguments": [
            {
              "text": "`[rerank-worker] retiring worker did not report retired within ${drainMs}ms; terminating it anyway `\n        + '(WI-10006567: terminating during a nat",
              "truncated": true
            }
          ]
        },
        {
          "callee": "w.terminate",
          "line": 371,
          "column": 19,
          "endLine": 371,
          "arguments": []
        },
        {
          "callee": "retiring.delete",
          "line": 373,
          "column": 5,
          "endLine": 373,
          "arguments": [
            {
              "text": "w",
              "truncated": false
            }
          ]
        },
        {
          "callee": "retiring.set",
          "line": 375,
          "column": 3,
          "endLine": 375,
          "arguments": [
            {
              "text": "w",
              "truncated": false
            },
            {
              "text": "{ done, settle }",
              "truncated": false
            }
          ]
        },
        {
          "callee": "w.ref",
          "line": 376,
          "column": 9,
          "endLine": 376,
          "arguments": []
        },
        {
          "callee": "w.postMessage",
          "line": 377,
          "column": 9,
          "endLine": 377,
          "arguments": [
            {
              "text": "{ kind: 'retire' }",
              "truncated": false
            }
          ]
        },
        {
          "callee": "settle",
          "line": 377,
          "column": 54,
          "endLine": 377,
          "arguments": [
            {
              "text": "'errored'",
              "truncated": false
            }
          ]
        },
        {
          "callee": "shutdownLocalReranker",
          "line": 398,
          "column": 11,
          "endLine": 398,
          "arguments": []
        },
        {
          "callee": "process.on",
          "line": 400,
          "column": 3,
          "endLine": 400,
          "arguments": [
            {
              "text": "'beforeExit'",
              "truncated": false
            },
            {
              "text": "state.beforeExitListener",
              "truncated": false
            }
          ]
        },
        {
          "callee": "process.off",
          "line": 405,
          "column": 33,
          "endLine": 405,
          "arguments": [
            {
              "text": "'beforeExit'",
              "truncated": false
            },
            {
              "text": "state.beforeExitListener",
              "truncated": false
            }
          ]
        },
        {
          "callee": "observeFallback",
          "line": 438,
          "column": 9,
          "endLine": 438,
          "arguments": [
            {
              "text": "'rerank-worker'",
              "truncated": false
            },
            {
              "text": "{ eligible: 1, applied: 0, reason: 'worker-failed' }",
              "truncated": false
            }
          ]
        },
        {
          "callee": "Date.now",
          "line": 439,
          "column": 15,
          "endLine": 439,
          "arguments": []
        },
        {
          "callee": "console.warn",
          "line": 443,
          "column": 5,
          "endLine": 448,
          "arguments": [
            {
              "text": "'[rerank] worker path failed — falling back to inline (main-thread, blocks the event loop) ' +\n        `for this call, so the timeout bound is only ac",
              "truncated": true
            }
          ]
        },
        {
          "callee": "String",
          "line": 446,
          "column": 48,
          "endLine": 446,
          "arguments": [
            {
              "text": "err",
              "truncated": false
            }
          ]
        }
      ],
      "newExpressions": [
        {
          "callee": "Map",
          "line": 86,
          "column": 56,
          "endLine": 86,
          "arguments": []
        },
        {
          "callee": "Error",
          "line": 183,
          "column": 51,
          "endLine": 183,
          "arguments": [
            {
              "text": "'rerank worker disabled'",
              "truncated": false
            }
          ]
        },
        {
          "callee": "Promise",
          "line": 186,
          "column": 23,
          "endLine": 277,
          "arguments": [
            {
              "text": "(resolveReady, rejectReady) => {\n    let spawned: Worker;\n    try {\n      const scriptPath = workerPath();\n      // WI-10005090: before the first work",
              "truncated": true
            }
          ]
        },
        {
          "callee": "Worker",
          "line": 192,
          "column": 17,
          "endLine": 192,
          "arguments": [
            {
              "text": "scriptPath",
              "truncated": false
            }
          ]
        },
        {
          "callee": "Error",
          "line": 213,
          "column": 54,
          "endLine": 213,
          "arguments": [
            {
              "text": "'rerank worker was shut down before it became ready'",
              "truncated": false
            }
          ]
        },
        {
          "callee": "Error",
          "line": 247,
          "column": 23,
          "endLine": 247,
          "arguments": [
            {
              "text": "msg.error ?? 'rerank worker error'",
              "truncated": false
            }
          ]
        },
        {
          "callee": "Error",
          "line": 266,
          "column": 21,
          "endLine": 266,
          "arguments": [
            {
              "text": "`rerank worker exited with code ${code} before ready`",
              "truncated": false
            }
          ]
        },
        {
          "callee": "Error",
          "line": 271,
          "column": 51,
          "endLine": 271,
          "arguments": [
            {
              "text": "`rerank worker exited with code ${code}`",
              "truncated": false
            }
          ]
        },
        {
          "callee": "Error",
          "line": 306,
          "column": 28,
          "endLine": 306,
          "arguments": [
            {
              "text": "'rerank worker not initialized'",
              "truncated": false
            }
          ]
        },
        {
          "callee": "Promise",
          "line": 309,
          "column": 10,
          "endLine": 317,
          "arguments": [
            {
              "text": "(resolveScore, rejectScore) => {\n    const { observeFallback, ...payload } = req;\n    state.pending.set(id, { resolve: resolveScore, reject: rejectSco",
              "truncated": true
            }
          ]
        },
        {
          "callee": "Error",
          "line": 335,
          "column": 17,
          "endLine": 335,
          "arguments": [
            {
              "text": "`rerank worker was shut down while ${state.pending.size} request(s) were in flight`",
              "truncated": false
            }
          ]
        },
        {
          "callee": "Map",
          "line": 356,
          "column": 40,
          "endLine": 356,
          "arguments": []
        },
        {
          "callee": "Promise",
          "line": 360,
          "column": 19,
          "endLine": 360,
          "arguments": [
            {
              "text": "(resolve) => { settle = resolve; }",
              "truncated": false
            }
          ]
        }
      ],
      "constants": [
        {
          "name": "TRANSFORMERS_PACKAGE",
          "value": "@huggingface/transformers",
          "line": 91,
          "column": 7,
          "endLine": 91
        }
      ],
      "globals": [
        {
          "name": "process.env",
          "line": 442,
          "column": 7,
          "endLine": 442
        }
      ],
      "workerEntrypoints": [
        {
          "path": "src/local-reranker-worker.script.mjs",
          "gitBlob": "f5f414f52c9a1e48589ffc74ffe32bca428dc19a",
          "bytes": 8756,
          "sha256": "499c92c56edc563c3e37db29cb9ee8ea9d7faba43a0a2550a6f22ff522f42b27"
        }
      ]
    }
  ]
}
