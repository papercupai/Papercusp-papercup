---
rel_path: "security/p001-sidecar-client-source-preparation-20261106-v1.json"
updated_at: 1793939233262
_body: "content"
---

{
  "schema": "p001-sidecar-client-source-preparation-v1",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "workItem": "WI-6554700010044289",
  "currentWorkItem": "WI-6554700010045753",
  "producer": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "status": "source-preparation-only",
  "recordedAt": "2026-11-06T04:27:13.220Z",
  "evidenceScope": "Exact pinned source bytes, offline TypeScript AST and independent Python/git-show identities. No current loaded-process, distribution, platform, confinement or shipment qualification.",
  "sources": {
    "priorCanonical": "security/p001-native-distribution-source-classification-20261106-memory-package-entry-v13.json",
    "extraction": "security/p001-sidecar-client-source-extraction-20261106-v1.json",
    "verification": "security/p001-sidecar-client-source-verification-20261106-v1.json",
    "consumer": "packages/operator-core/lib/memory/embed-sidecar-wiring.ts"
  },
  "rootIdentityReused": {
    "revision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
    "memoryRevision": "fe9878936d3da86d872fc1a5fdd29877e903d1f0",
    "rerankRevision": "40e78e06b07a94203e151a44979394acc2dbc871",
    "note": "Reused retained v13 root/gitlink/package/entry identity. This unit does not replay those measurements."
  },
  "extraction": {
    "schema": "p001-sidecar-client-source-extraction-v1",
    "rootRevision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
    "analyzer": {
      "name": "typescript compiler API",
      "version": "6.0.3",
      "purpose": "offline parsing only; candidate modules never imported"
    },
    "scope": {
      "files": 2,
      "moduleEdges": "syntax with type-only bindings and pinned relative candidate identities",
      "calls": "all syntactic call expressions; not runtime effect closure",
      "candidateExecution": false
    },
    "rows": [
      {
        "repository": "libs/generic/memory",
        "repositoryRevision": "fe9878936d3da86d872fc1a5fdd29877e903d1f0",
        "path": "src/sidecar-embedder.ts",
        "gitBlob": "f4df564acaa54415b14b59b3a7ab41969b447937",
        "sha256": "6aa17f449b4fe25ac09da37ce77dc77070f0c0fb091e6d72a31bf9c312b9a092",
        "bytes": 19360,
        "text": "/**\n * Sidecar-first embedder client (P-003, plan\n * shared-embedding-sidecar-and-enrichment-2026-07-10; sidecar-REQUIRED since\n * WI-4021, owner directive 2026-07-11).\n *\n * The consumer-side seam for the shared embedding sidecar: an EmbedFn over the\n * loopback sidecar (D-004 wire — POST {url}/embed { model, kind, texts }).\n *\n * AVAILABILITY CONTRACT (v2 — D-003 retired): when a sidecar URL is\n * configured, the sidecar is REQUIRED. A failure is retried briefly (the\n * sidecar is systemd-supervised with Restart=always, so a crash window is\n * seconds) and then THROWN — never silently absorbed by an in-process model\n * load. The old D-003 in-process failover let a stalling sidecar drag every\n * embedding host into duplicate in-process model loads (the 2026-07-11\n * \"mem0 down\" flap incident) and hid sidecar sickness instead of surfacing\n * it; memory writes survive a real outage via the write-ahead journal\n * (memory-write-journal-auto-recovery-2026-07-11), reads fail loudly.\n *\n * The caller-supplied in-process builder is used ONLY when NO sidecar is\n * configured (url null — desktop installs, tests, bench rigs): there it is\n * the sole engine, not a fallback. Vectors are BIT-IDENTICAL either way\n * (D-002): the sidecar wraps the SAME @papercusp/memory builders (model,\n * prompts, MRL truncation, ORT runtime) — same space on every path.\n *\n * Retry shape: one total `timeoutMs` budget (default 15s — a freshly\n * restarted sidecar may still be warm-loading) spans ALL attempts, so a\n * slow-but-alive sidecar is never hammered past its budget; fast failures\n * (connect refused during a restart) get up to `maxAttempts` tries with short\n * linear backoff inside that budget.\n *\n * Plain `fetch`, zero new dependencies — this library is deliberately dep-free\n * (pg only); the server lives in operator-core, never here.\n */\n\nimport type { GemmaEmbedKind } from './gemma-embedder';\n\ntype EmbedFn = (text: string, signal?: AbortSignal) => Promise<number[]>;\n\n/** Consumers point at a sidecar by setting this (e.g. http://127.0.0.1:3384). */\nexport const EMBED_SIDECAR_URL_ENV = 'PAPERCUSP_EMBED_SIDECAR_URL';\n\n/** The sidecar base URL this process should use, or null when none is\n *  configured (→ pure in-process embedding). */\nexport function resolveEmbedSidecarUrl(env: NodeJS.ProcessEnv = process.env): string | null {\n  const url = env[EMBED_SIDECAR_URL_ENV]?.trim();\n  return url ? url.replace(/\\/$/, '') : null;\n}\n\nexport interface SidecarEmbedBatchOpts {\n  model: string;\n  kind: GemmaEmbedKind;\n  texts: string[];\n  /** Evaluate inference directly rather than the sidecar's cache. */\n  bypassCache?: boolean;\n  timeoutMs?: number;\n  /** Optional caller lifetime. Aborting it closes the HTTP request immediately\n   *  instead of leaving stale work in the shared sidecar FIFO until the\n   *  client's independent timeout expires. */\n  signal?: AbortSignal;\n  fetchFn?: typeof fetch;\n}\n\nexport interface SidecarEmbedResponse {\n  vectors: number[][];\n  dims: number;\n  runtime: string;\n  modelRev: string;\n  cache?: { hits: number; coalesced: number; inferred: number };\n}\n\nexport const DEFAULT_SIDECAR_TIMEOUT_MS = 15_000;\n\n/**\n * Per-text allowance added on top of the base budget for a BATCH embed.\n *\n * WHY A BATCH CANNOT INHERIT THE SINGLE-EMBED DEFAULT (EI-19464574865993243):\n * `DEFAULT_SIDECAR_TIMEOUT_MS` is a budget for ONE embed. `sidecarEmbedBatch`\n * accepts `texts[]`, so a caller that omits `timeoutMs` silently gives N texts\n * the deadline sized for one — and every real caller omitted it. Measured\n * 2026-08-03 on papercup-bg-host: `embedBatchSize` is 128 on a server-tier box\n * and the observed throughput is ~0.22s/text, so a full batch needs ~28s and\n * was being aborted at 15s on EVERY sweep for hours. The AbortController fires,\n * fetch rejects with \"This operation was aborted\", and embed-backfill falls back\n * to the per-row path — same rows embedded, same success counts, just ~N× slower.\n *\n * The failure is HARDWARE-TIERED, which is why it hid: a laptop profile batches\n * 32 (~7s, fits in 15s) and works fine. The bigger the box, the more certainly\n * the batch optimization disables itself — it broke exactly where it was meant\n * to pay off.\n *\n * 2s/text is deliberately conservative after WI-2146713's 2026-09-06 live\n * probe: 16 unique 2,000-character gemma/document texts reached the model\n * (cache hits 0) and completed in 34.4s. That makes the old 30s n=16 budget a\n * false-abort path. The ceiling exists to catch a SICK sidecar, not to pace a\n * healthy one, and a false abort here costs the entire batch optimization.\n * Erring long is the cheap direction.\n */\nexport const SIDECAR_BATCH_PER_TEXT_MS = 2_000;\n\n/** Absolute ceiling for a batch budget, so a huge `texts[]` cannot produce an\n *  effectively unbounded request. */\nexport const SIDECAR_BATCH_TIMEOUT_CAP_MS = 180_000;\n\n/**\n * The default budget for a batch of `textCount` texts. Exported so a caller\n * that also imposes its OWN outer bound can derive it from the SAME number\n * instead of picking a second one — two independently-chosen deadlines where\n * the tighter silently wins is precisely how this bug survived: embed-backfill\n * wrapped the batch in a deliberate 90s race, which could never fire, because\n * this client aborted it at 15s first.\n */\nexport function sidecarBatchTimeoutMs(textCount: number): number {\n  const scaled = DEFAULT_SIDECAR_TIMEOUT_MS + SIDECAR_BATCH_PER_TEXT_MS * Math.max(0, textCount - 1);\n  return Math.min(SIDECAR_BATCH_TIMEOUT_CAP_MS, scaled);\n}\n/** Attempts per embed when the sidecar is required (fast failures only — the\n *  shared `timeoutMs` budget caps total wall time regardless). */\nexport const DEFAULT_SIDECAR_MAX_ATTEMPTS = 3;\n\n/** The sidecar server's own per-text char cap (embed-sidecar-server.ts\n *  MAX_TEXT_CHARS — kept in sync here since the client, not the server, is\n *  the one place every embed caller funnels through). A text over this limit\n *  is truncated client-side BEFORE it is ever sent (EI-14101): the sidecar's\n *  own 400 for this condition says \"truncate before embedding\", so truncating\n *  at the ONE shared client seam means no individual caller (embed-backfill,\n *  write-journal, memory writes, …) has to reimplement the cap. */\nexport const SIDECAR_MAX_TEXT_CHARS = 32_000;\n\n/** Thrown by sidecarEmbedBatch on a non-2xx sidecar response. Carries the\n *  HTTP status so a retry policy can tell a DETERMINISTIC client-side\n *  rejection (4xx — the exact same request can never succeed on retry) apart\n *  from a transient server/network failure (5xx, connect refused, timeout) —\n *  see isNonRetryableSidecarError. */\nexport class SidecarEmbedHttpError extends Error {\n  readonly status: number;\n  constructor(status: number, detail: string) {\n    super(`sidecar_embed_${status}: ${detail}`);\n    this.name = 'SidecarEmbedHttpError';\n    this.status = status;\n  }\n}\n\n/** True for a sidecar failure that retrying can never fix (a 4xx: the\n *  sidecar looked at THIS request and rejected it — bad shape, unknown\n *  model, oversized text pre-truncation, …). False for anything else\n *  (network/connect/timeout/5xx), which IS worth a bounded retry — the\n *  sidecar may just be mid-restart. */\nexport function isNonRetryableSidecarError(e: unknown): boolean {\n  return e instanceof SidecarEmbedHttpError && e.status >= 400 && e.status < 500;\n}\n\n/**\n * One D-004 wire call. Throws on ANY failure (network, timeout, non-200,\n * malformed/mismatched response) — callers own the fallback decision.\n * Exported for batch consumers (embed-backfill, P-004) that want the\n * texts[] amortization the single-text EmbedFn seam can't express.\n *\n * Texts over SIDECAR_MAX_TEXT_CHARS are truncated before submission (the\n * sidecar rejects them outright otherwise — a deterministic 400 that no\n * amount of retrying would fix).\n */\nexport async function sidecarEmbedBatch(url: string, opts: SidecarEmbedBatchOpts): Promise<SidecarEmbedResponse> {\n  const fetchFn = opts.fetchFn ?? fetch;\n  const texts = opts.texts.map((t) => (t.length > SIDECAR_MAX_TEXT_CHARS ? t.slice(0, SIDECAR_MAX_TEXT_CHARS) : t));\n  // Scales with the batch: the single-embed default aborts a full batch mid-flight\n  // and every caller omitted `timeoutMs` (EI-19464574865993243).\n  const timeoutMs = opts.timeoutMs ?? sidecarBatchTimeoutMs(texts.length);\n  const ctl = new AbortController();\n  const timer = setTimeout(() => ctl.abort(), timeoutMs);\n  const abortFromCaller = (): void => ctl.abort(opts.signal?.reason);\n  if (opts.signal?.aborted) abortFromCaller();\n  else opts.signal?.addEventListener('abort', abortFromCaller, { once: true });\n  try {\n    const res = await fetchFn(`${url.replace(/\\/$/, '')}/embed`, {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ model: opts.model, kind: opts.kind, texts,\n        ...(opts.bypassCache === undefined ? {} : { bypassCache: opts.bypassCache }) }),\n      signal: ctl.signal,\n    });\n    if (!res.ok) {\n      const detail = await res.text().catch(() => '');\n      throw new SidecarEmbedHttpError(res.status, detail.slice(0, 200));\n    }\n    const body = (await res.json()) as SidecarEmbedResponse;\n    if (\n      !Array.isArray(body.vectors) ||\n      body.vectors.length !== texts.length ||\n      body.vectors.some((v) => !Array.isArray(v) || v.length === 0 || typeof v[0] !== 'number')\n    ) {\n      throw new Error('sidecar_embed_bad_shape: vectors missing/mismatched');\n    }\n    return body;\n  } finally {\n    clearTimeout(timer);\n    opts.signal?.removeEventListener('abort', abortFromCaller);\n  }\n}\n\nexport interface SidecarFirstEmbedderOpts {\n  /** Sidecar-side model name ('gemma' | 'local' | 'harrier'). */\n  model: string;\n  /** Asymmetric task side — the sidecar owns the actual prompt text (D-004). */\n  kind: GemmaEmbedKind;\n  /** Lazy builder for the in-process embedder — used ONLY when no sidecar is\n   *  configured (url null AND no ensure hook), where it is the sole engine.\n   *  When a url or an ensure hook is set it is never built: the sidecar is\n   *  required (WI-4021, D-003 retired). */\n  fallback: () => EmbedFn | Promise<EmbedFn>;\n  /** Sidecar base URL; defaults to resolveEmbedSidecarUrl(). null/absent ⇒\n   *  pure in-process, unless `ensure` is set (see there). */\n  url?: string | null;\n  /** TOTAL budget per embed across every attempt (default 15s). */\n  timeoutMs?: number;\n  /** Attempts within the budget on sidecar failure (default 3). */\n  maxAttempts?: number;\n  fetchFn?: typeof fetch;\n  /** Clock seam for tests. */\n  now?: () => number;\n  /** Backoff-sleep seam for tests. */\n  sleepFn?: (ms: number) => Promise<void>;\n  /** Down/up/rejected transition logging seam (default console.warn,\n   *  transition-only). 'rejected' = the sidecar is UP and correctly\n   *  refusing a bad request (deterministic 4xx) — distinct from 'down' so\n   *  the log never claims the sidecar is unavailable when it isn't. */\n  onTransition?: (state: 'down' | 'up' | 'rejected', detail: string) => void;\n  /** Re-establish the sidecar before each attempt. A sidecar this process\n   *  spawned may have exited after an idle period, and this hook re-launches\n   *  it on demand. It should be cheap when the sidecar is already running.\n   *  It runs inside the same total budget. If the budget runs out first, the\n   *  attempt fails and the ensure keeps running, so a later call finds the\n   *  sidecar warming or ready. Leave unset for a sidecar another process owns.\n   *  It may resolve to the sidecar's current base URL; the client then sends\n   *  this and later attempts there (see nextSidecarUrl).\n   *  With `url` null, the ensure hook is the ONLY source of the address: a\n   *  sidecar this process is configured to spawn that is not up yet (its first\n   *  start timed out). The client stays sidecar-only and fails the attempt\n   *  until an ensure reports a URL. It never loads the model in-process, which\n   *  would keep a second copy in this process for good (WI-10005932). */\n  ensure?: () => Promise<unknown>;\n}\n\n/** P-530: an ensure hook may resolve to the sidecar's CURRENT base URL. A\n *  sidecar this process spawns on an ephemeral port comes back on a different\n *  port after an idle exit, so the client must follow it. Anything that is not\n *  a non-empty string keeps the URL it already has. */\nexport function nextSidecarUrl(current: string, ensured: unknown): string;\nexport function nextSidecarUrl(current: string | null, ensured: unknown): string | null;\nexport function nextSidecarUrl(current: string | null, ensured: unknown): string | null {\n  return typeof ensured === 'string' && ensured.trim() ? ensured.trim().replace(/\\/$/, '') : current;\n}\n\n/** Settle `work` within `ms`, or reject with `sidecar_ensure_timeout`. A late\n *  settle of `work` is ignored. `Promise.race` subscribes to it, so a late\n *  rejection is never an unhandled rejection. */\nexport async function settleSidecarEnsureWithin<T>(\n  work: Promise<T>,\n  ms: number,\n  signal?: AbortSignal,\n): Promise<T> {\n  let timer: ReturnType<typeof setTimeout> | undefined;\n  let onAbort: (() => void) | undefined;\n  try {\n    return await Promise.race([\n      work,\n      new Promise<never>((_, reject) => {\n        timer = setTimeout(\n          () => reject(new Error(`sidecar_ensure_timeout: sidecar not ready within ${Math.max(0, Math.round(ms))}ms`)),\n          Math.max(0, ms),\n        );\n        if (signal) {\n          onAbort = () => reject(signal.reason ?? new Error('aborted'));\n          if (signal.aborted) onAbort();\n          else signal.addEventListener('abort', onAbort, { once: true });\n        }\n      }),\n    ]);\n  } finally {\n    clearTimeout(timer);\n    if (onAbort) signal?.removeEventListener('abort', onAbort);\n  }\n}\n\n/**\n * Build a sidecar-first EmbedFn. With a url: sidecar-REQUIRED — brief retries\n * inside one total budget, then throw (`sidecar_required_unavailable`); the\n * in-process builder is never touched. Without a url: the plain in-process\n * embedder. Same closure shape as buildGemmaEmbedder/buildLocalEmbedder so it\n * drops into every existing embedder seam.\n */\nexport function buildSidecarFirstEmbedder(opts: SidecarFirstEmbedderOpts): EmbedFn {\n  const url = opts.url === undefined ? resolveEmbedSidecarUrl() : opts.url;\n  const now = opts.now ?? Date.now;\n  const sleep = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));\n  const timeoutMs = opts.timeoutMs ?? DEFAULT_SIDECAR_TIMEOUT_MS;\n  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_SIDECAR_MAX_ATTEMPTS);\n  const onTransition =\n    opts.onTransition ??\n    ((state: 'down' | 'up' | 'rejected', detail: string) =>\n      console.warn(`[sidecar-embedder] ${opts.model}:${opts.kind} sidecar ${state}: ${detail}`));\n\n  if (!url && !opts.ensure) {\n    // No sidecar configured: the plain in-process embedder is the sole engine\n    // (desktop installs, tests, bench rigs) with zero per-call overhead. A\n    // failed build is not memoized — the next embed retries it.\n    let fallbackPromise: Promise<EmbedFn> | null = null;\n    const getFallback = (): Promise<EmbedFn> => {\n      if (!fallbackPromise) {\n        fallbackPromise = Promise.resolve()\n          .then(() => opts.fallback())\n          .catch((e) => {\n            fallbackPromise = null;\n            throw e;\n          });\n      }\n      return fallbackPromise;\n    };\n    return async (text: string, signal?: AbortSignal) => {\n      signal?.throwIfAborted();\n      const embed = await getFallback();\n      signal?.throwIfAborted();\n      return embed(text, signal);\n    };\n  }\n\n  let wasDown = false;\n  // P-530: shared by every call of this embedder, so once an ensure reports a\n  // new address (a re-launched sidecar on a fresh ephemeral port) later calls\n  // start there too.\n  // WI-10005932: null until an ensure reports where a spawned sidecar listens.\n  let currentUrl: string | null = url || null;\n\n  return async (text: string, signal?: AbortSignal): Promise<number[]> => {\n    const deadline = now() + timeoutMs;\n    let lastErr: unknown;\n    for (let attempt = 1; attempt <= maxAttempts; attempt++) {\n      const remaining = deadline - now();\n      if (remaining <= 0) break;\n      try {\n        let left = remaining;\n        if (opts.ensure) {\n          currentUrl = nextSidecarUrl(currentUrl, await settleSidecarEnsureWithin(opts.ensure(), remaining, signal));\n          left = deadline - now();\n          if (left <= 0) throw new Error('sidecar_ensure_timeout: budget spent re-establishing the sidecar');\n        }\n        if (currentUrl === null) throw new Error('sidecar_not_ready: no sidecar address reported yet');\n        const res = await sidecarEmbedBatch(currentUrl, {\n          model: opts.model,\n          kind: opts.kind,\n          texts: [text],\n          timeoutMs: left,\n          signal,\n          fetchFn: opts.fetchFn,\n        });\n        if (wasDown) {\n          wasDown = false;\n          onTransition('up', `sidecar answering again (attempt ${attempt})`);\n        }\n        return res.vectors[0];\n      } catch (e) {\n        lastErr = e;\n        // A caller budget/route abort is terminal for THIS request. Retrying\n        // would recreate the stale queue entry the signal exists to remove.\n        if (signal?.aborted) throw signal.reason ?? e;\n        if (isNonRetryableSidecarError(e)) {\n          // Deterministic 4xx: the sidecar is UP and correctly rejecting\n          // THIS exact request (bad shape / oversized text / unknown model)\n          // — retrying the same payload can never succeed, so stop right\n          // away instead of burning the retry budget (EI-14101). Logged as\n          // 'rejected', never 'down' — the sidecar isn't unavailable.\n          onTransition(\n            'rejected',\n            `${e instanceof Error ? e.message : String(e)} — sidecar correctly rejected the request (non-retryable, not a downtime issue)`,\n          );\n          break;\n        }\n        if (!wasDown) {\n          wasDown = true;\n          onTransition(\n            'down',\n            `${e instanceof Error ? e.message : String(e)} — sidecar is REQUIRED (no in-process fallback, WI-4021); retrying within budget`,\n          );\n        }\n        // Short linear backoff before the next attempt — but only when enough\n        // budget remains for the backoff AND a meaningful retry.\n        const backoffMs = 250 * attempt;\n        if (attempt < maxAttempts && deadline - now() > backoffMs + 250) await sleep(backoffMs);\n        else break;\n      }\n    }\n    throw isNonRetryableSidecarError(lastErr)\n      ? new Error(\n          `sidecar_rejected_request: ${lastErr instanceof Error ? lastErr.message : String(lastErr)} ` +\n            `(${currentUrl}, ${opts.model}:${opts.kind}) — the sidecar rejected this request (non-retryable); ` +\n            'check payload shape/size — this is not a downtime issue',\n          { cause: lastErr },\n        )\n      : new Error(\n          `sidecar_required_unavailable: ${lastErr instanceof Error ? lastErr.message : String(lastErr)} ` +\n            `(${currentUrl}, ${opts.model}:${opts.kind}, budget ${timeoutMs}ms) — embedding requires the sidecar; ` +\n            'writes are parked in the memory write journal and auto-recover when it returns',\n          { cause: lastErr },\n        );\n  };\n}\n",
        "parseDiagnostics": [],
        "moduleEdges": [
          {
            "kind": "import",
            "specifier": "./gemma-embedder",
            "typeOnly": true,
            "defaultImport": null,
            "named": [
              {
                "name": "GemmaEmbedKind",
                "imported": "GemmaEmbedKind",
                "typeOnly": true
              }
            ],
            "line": 35,
            "column": 1,
            "endLine": 35,
            "resolved": [
              {
                "path": "src/gemma-embedder.ts",
                "gitBlob": "809e6ff255b819fd60a22e4c600646d94c3aa915",
                "bytes": 9897,
                "sha256": "9e262d1e81c9b7d9746896d33e14d48142e37c2172ec3e6cf7e5b687b7378987"
              }
            ]
          }
        ],
        "calls": [
          {
            "callee": "env[EMBED_SIDECAR_URL_ENV]?.trim",
            "line": 45,
            "column": 15,
            "endLine": 45,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "url.replace",
            "line": 46,
            "column": 16,
            "endLine": 46,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "/\\/$/",
                "truncated": false
              },
              {
                "text": "''",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Math.max",
            "line": 113,
            "column": 75,
            "endLine": 113,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "0",
                "truncated": false
              },
              {
                "text": "textCount - 1",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Math.min",
            "line": 114,
            "column": 10,
            "endLine": 114,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "SIDECAR_BATCH_TIMEOUT_CAP_MS",
                "truncated": false
              },
              {
                "text": "scaled",
                "truncated": false
              }
            ]
          },
          {
            "callee": "super",
            "line": 137,
            "column": 5,
            "endLine": 137,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "`sidecar_embed_${status}: ${detail}`",
                "truncated": false
              }
            ]
          },
          {
            "callee": "opts.texts.map",
            "line": 164,
            "column": 17,
            "endLine": 164,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "(t) => (t.length > SIDECAR_MAX_TEXT_CHARS ? t.slice(0, SIDECAR_MAX_TEXT_CHARS) : t)",
                "truncated": false
              }
            ]
          },
          {
            "callee": "t.slice",
            "line": 164,
            "column": 76,
            "endLine": 164,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "0",
                "truncated": false
              },
              {
                "text": "SIDECAR_MAX_TEXT_CHARS",
                "truncated": false
              }
            ]
          },
          {
            "callee": "sidecarBatchTimeoutMs",
            "line": 167,
            "column": 39,
            "endLine": 167,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "texts.length",
                "truncated": false
              }
            ]
          },
          {
            "callee": "setTimeout",
            "line": 169,
            "column": 17,
            "endLine": 169,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "() => ctl.abort()",
                "truncated": false
              },
              {
                "text": "timeoutMs",
                "truncated": false
              }
            ]
          },
          {
            "callee": "ctl.abort",
            "line": 169,
            "column": 34,
            "endLine": 169,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "ctl.abort",
            "line": 170,
            "column": 39,
            "endLine": 170,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "opts.signal?.reason",
                "truncated": false
              }
            ]
          },
          {
            "callee": "abortFromCaller",
            "line": 171,
            "column": 29,
            "endLine": 171,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "opts.signal?.addEventListener",
            "line": 172,
            "column": 8,
            "endLine": 172,
            "argumentCount": 3,
            "arguments": [
              {
                "text": "'abort'",
                "truncated": false
              },
              {
                "text": "abortFromCaller",
                "truncated": false
              },
              {
                "text": "{ once: true }",
                "truncated": false
              }
            ]
          },
          {
            "callee": "fetchFn",
            "line": 174,
            "column": 23,
            "endLine": 180,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "`${url.replace(/\\/$/, '')}/embed`",
                "truncated": false
              },
              {
                "text": "{\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ model: opts.model, kind: opts.kind, texts,\n        ...(opts.bypassCache === undefined ? {} : { bypassCache: opts.bypassCache }) }),\n      signal: ctl.signal,\n    }",
                "truncated": false
              }
            ]
          },
          {
            "callee": "url.replace",
            "line": 174,
            "column": 34,
            "endLine": 174,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "/\\/$/",
                "truncated": false
              },
              {
                "text": "''",
                "truncated": false
              }
            ]
          },
          {
            "callee": "JSON.stringify",
            "line": 177,
            "column": 13,
            "endLine": 178,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "{ model: opts.model, kind: opts.kind, texts,\n        ...(opts.bypassCache === undefined ? {} : { bypassCache: opts.bypassCache }) }",
                "truncated": false
              }
            ]
          },
          {
            "callee": "res.text().catch",
            "line": 182,
            "column": 28,
            "endLine": 182,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "() => ''",
                "truncated": false
              }
            ]
          },
          {
            "callee": "res.text",
            "line": 182,
            "column": 28,
            "endLine": 182,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "detail.slice",
            "line": 183,
            "column": 51,
            "endLine": 183,
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
            "callee": "res.json",
            "line": 185,
            "column": 25,
            "endLine": 185,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "Array.isArray",
            "line": 187,
            "column": 8,
            "endLine": 187,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "body.vectors",
                "truncated": false
              }
            ]
          },
          {
            "callee": "body.vectors.some",
            "line": 189,
            "column": 7,
            "endLine": 189,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "(v) => !Array.isArray(v) || v.length === 0 || typeof v[0] !== 'number'",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Array.isArray",
            "line": 189,
            "column": 33,
            "endLine": 189,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "v",
                "truncated": false
              }
            ]
          },
          {
            "callee": "clearTimeout",
            "line": 195,
            "column": 5,
            "endLine": 195,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "timer",
                "truncated": false
              }
            ]
          },
          {
            "callee": "opts.signal?.removeEventListener",
            "line": 196,
            "column": 5,
            "endLine": 196,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "'abort'",
                "truncated": false
              },
              {
                "text": "abortFromCaller",
                "truncated": false
              }
            ]
          },
          {
            "callee": "ensured.trim",
            "line": 250,
            "column": 41,
            "endLine": 250,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "ensured.trim().replace",
            "line": 250,
            "column": 58,
            "endLine": 250,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "/\\/$/",
                "truncated": false
              },
              {
                "text": "''",
                "truncated": false
              }
            ]
          },
          {
            "callee": "ensured.trim",
            "line": 250,
            "column": 58,
            "endLine": 250,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "Promise.race",
            "line": 264,
            "column": 18,
            "endLine": 277,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "[\n      work,\n      new Promise<never>((_, reject) => {\n        timer = setTimeout(\n          () => reject(new Error(`sidecar_ensure_timeout: sidecar not ready within ${Math.max(0, Math.round(ms))}ms`)),\n          Math.max(0, ms),\n        );\n        if (signal) {\n          onAbort = () => reject(signal.reason ?? new Error('aborted'));\n          if (signal.ab",
                "truncated": true
              }
            ]
          },
          {
            "callee": "setTimeout",
            "line": 267,
            "column": 17,
            "endLine": 270,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "() => reject(new Error(`sidecar_ensure_timeout: sidecar not ready within ${Math.max(0, Math.round(ms))}ms`))",
                "truncated": false
              },
              {
                "text": "Math.max(0, ms)",
                "truncated": false
              }
            ]
          },
          {
            "callee": "reject",
            "line": 268,
            "column": 17,
            "endLine": 268,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "new Error(`sidecar_ensure_timeout: sidecar not ready within ${Math.max(0, Math.round(ms))}ms`)",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Math.max",
            "line": 268,
            "column": 86,
            "endLine": 268,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "0",
                "truncated": false
              },
              {
                "text": "Math.round(ms)",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Math.round",
            "line": 268,
            "column": 98,
            "endLine": 268,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "ms",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Math.max",
            "line": 269,
            "column": 11,
            "endLine": 269,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "0",
                "truncated": false
              },
              {
                "text": "ms",
                "truncated": false
              }
            ]
          },
          {
            "callee": "reject",
            "line": 272,
            "column": 27,
            "endLine": 272,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "signal.reason ?? new Error('aborted')",
                "truncated": false
              }
            ]
          },
          {
            "callee": "onAbort",
            "line": 273,
            "column": 31,
            "endLine": 273,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "signal.addEventListener",
            "line": 274,
            "column": 16,
            "endLine": 274,
            "argumentCount": 3,
            "arguments": [
              {
                "text": "'abort'",
                "truncated": false
              },
              {
                "text": "onAbort",
                "truncated": false
              },
              {
                "text": "{ once: true }",
                "truncated": false
              }
            ]
          },
          {
            "callee": "clearTimeout",
            "line": 279,
            "column": 5,
            "endLine": 279,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "timer",
                "truncated": false
              }
            ]
          },
          {
            "callee": "signal?.removeEventListener",
            "line": 280,
            "column": 18,
            "endLine": 280,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "'abort'",
                "truncated": false
              },
              {
                "text": "onAbort",
                "truncated": false
              }
            ]
          },
          {
            "callee": "resolveEmbedSidecarUrl",
            "line": 292,
            "column": 40,
            "endLine": 292,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "setTimeout",
            "line": 294,
            "column": 75,
            "endLine": 294,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "r",
                "truncated": false
              },
              {
                "text": "ms",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Math.max",
            "line": 296,
            "column": 23,
            "endLine": 296,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "1",
                "truncated": false
              },
              {
                "text": "opts.maxAttempts ?? DEFAULT_SIDECAR_MAX_ATTEMPTS",
                "truncated": false
              }
            ]
          },
          {
            "callee": "console.warn",
            "line": 300,
            "column": 7,
            "endLine": 300,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "`[sidecar-embedder] ${opts.model}:${opts.kind} sidecar ${state}: ${detail}`",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Promise.resolve()\n          .then(() => opts.fallback())\n          .catch",
            "line": 309,
            "column": 27,
            "endLine": 314,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "(e) => {\n            fallbackPromise = null;\n            throw e;\n          }",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Promise.resolve()\n          .then",
            "line": 309,
            "column": 27,
            "endLine": 310,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "() => opts.fallback()",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Promise.resolve",
            "line": 309,
            "column": 27,
            "endLine": 309,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "opts.fallback",
            "line": 310,
            "column": 23,
            "endLine": 310,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "signal?.throwIfAborted",
            "line": 319,
            "column": 7,
            "endLine": 319,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "getFallback",
            "line": 320,
            "column": 27,
            "endLine": 320,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "signal?.throwIfAborted",
            "line": 321,
            "column": 7,
            "endLine": 321,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "embed",
            "line": 322,
            "column": 14,
            "endLine": 322,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "text",
                "truncated": false
              },
              {
                "text": "signal",
                "truncated": false
              }
            ]
          },
          {
            "callee": "now",
            "line": 334,
            "column": 22,
            "endLine": 334,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "now",
            "line": 337,
            "column": 36,
            "endLine": 337,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "nextSidecarUrl",
            "line": 342,
            "column": 24,
            "endLine": 342,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "currentUrl",
                "truncated": false
              },
              {
                "text": "await settleSidecarEnsureWithin(opts.ensure(), remaining, signal)",
                "truncated": false
              }
            ]
          },
          {
            "callee": "settleSidecarEnsureWithin",
            "line": 342,
            "column": 57,
            "endLine": 342,
            "argumentCount": 3,
            "arguments": [
              {
                "text": "opts.ensure()",
                "truncated": false
              },
              {
                "text": "remaining",
                "truncated": false
              },
              {
                "text": "signal",
                "truncated": false
              }
            ]
          },
          {
            "callee": "opts.ensure",
            "line": 342,
            "column": 83,
            "endLine": 342,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "now",
            "line": 343,
            "column": 29,
            "endLine": 343,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "sidecarEmbedBatch",
            "line": 347,
            "column": 27,
            "endLine": 354,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "currentUrl",
                "truncated": false
              },
              {
                "text": "{\n          model: opts.model,\n          kind: opts.kind,\n          texts: [text],\n          timeoutMs: left,\n          signal,\n          fetchFn: opts.fetchFn,\n        }",
                "truncated": false
              }
            ]
          },
          {
            "callee": "onTransition",
            "line": 357,
            "column": 11,
            "endLine": 357,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "'up'",
                "truncated": false
              },
              {
                "text": "`sidecar answering again (attempt ${attempt})`",
                "truncated": false
              }
            ]
          },
          {
            "callee": "isNonRetryableSidecarError",
            "line": 365,
            "column": 13,
            "endLine": 365,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "e",
                "truncated": false
              }
            ]
          },
          {
            "callee": "onTransition",
            "line": 371,
            "column": 11,
            "endLine": 374,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "'rejected'",
                "truncated": false
              },
              {
                "text": "`${e instanceof Error ? e.message : String(e)} — sidecar correctly rejected the request (non-retryable, not a downtime issue)`",
                "truncated": false
              }
            ]
          },
          {
            "callee": "String",
            "line": 373,
            "column": 49,
            "endLine": 373,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "e",
                "truncated": false
              }
            ]
          },
          {
            "callee": "onTransition",
            "line": 379,
            "column": 11,
            "endLine": 382,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "'down'",
                "truncated": false
              },
              {
                "text": "`${e instanceof Error ? e.message : String(e)} — sidecar is REQUIRED (no in-process fallback, WI-4021); retrying within budget`",
                "truncated": false
              }
            ]
          },
          {
            "callee": "String",
            "line": 381,
            "column": 49,
            "endLine": 381,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "e",
                "truncated": false
              }
            ]
          },
          {
            "callee": "now",
            "line": 387,
            "column": 49,
            "endLine": 387,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "sleep",
            "line": 387,
            "column": 80,
            "endLine": 387,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "backoffMs",
                "truncated": false
              }
            ]
          },
          {
            "callee": "isNonRetryableSidecarError",
            "line": 391,
            "column": 11,
            "endLine": 391,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "lastErr",
                "truncated": false
              }
            ]
          },
          {
            "callee": "String",
            "line": 393,
            "column": 85,
            "endLine": 393,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "lastErr",
                "truncated": false
              }
            ]
          },
          {
            "callee": "String",
            "line": 399,
            "column": 89,
            "endLine": 399,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "lastErr",
                "truncated": false
              }
            ]
          }
        ],
        "globals": [
          {
            "name": "process.env",
            "line": 44,
            "column": 65,
            "endLine": 44
          }
        ],
        "topLevelStatements": [
          {
            "kind": "ImportDeclaration",
            "name": null,
            "exported": false,
            "line": 35,
            "column": 1,
            "endLine": 35
          },
          {
            "kind": "TypeAliasDeclaration",
            "name": "EmbedFn",
            "exported": false,
            "line": 37,
            "column": 1,
            "endLine": 37
          },
          {
            "kind": "FirstStatement",
            "name": null,
            "exported": true,
            "line": 40,
            "column": 1,
            "endLine": 40
          },
          {
            "kind": "FunctionDeclaration",
            "name": "resolveEmbedSidecarUrl",
            "exported": true,
            "line": 44,
            "column": 1,
            "endLine": 47
          },
          {
            "kind": "InterfaceDeclaration",
            "name": "SidecarEmbedBatchOpts",
            "exported": true,
            "line": 49,
            "column": 1,
            "endLine": 61
          },
          {
            "kind": "InterfaceDeclaration",
            "name": "SidecarEmbedResponse",
            "exported": true,
            "line": 63,
            "column": 1,
            "endLine": 69
          },
          {
            "kind": "FirstStatement",
            "name": null,
            "exported": true,
            "line": 71,
            "column": 1,
            "endLine": 71
          },
          {
            "kind": "FirstStatement",
            "name": null,
            "exported": true,
            "line": 98,
            "column": 1,
            "endLine": 98
          },
          {
            "kind": "FirstStatement",
            "name": null,
            "exported": true,
            "line": 102,
            "column": 1,
            "endLine": 102
          },
          {
            "kind": "FunctionDeclaration",
            "name": "sidecarBatchTimeoutMs",
            "exported": true,
            "line": 112,
            "column": 1,
            "endLine": 115
          },
          {
            "kind": "FirstStatement",
            "name": null,
            "exported": true,
            "line": 118,
            "column": 1,
            "endLine": 118
          },
          {
            "kind": "FirstStatement",
            "name": null,
            "exported": true,
            "line": 127,
            "column": 1,
            "endLine": 127
          },
          {
            "kind": "ClassDeclaration",
            "name": "SidecarEmbedHttpError",
            "exported": true,
            "line": 134,
            "column": 1,
            "endLine": 141
          },
          {
            "kind": "FunctionDeclaration",
            "name": "isNonRetryableSidecarError",
            "exported": true,
            "line": 148,
            "column": 1,
            "endLine": 150
          },
          {
            "kind": "FunctionDeclaration",
            "name": "sidecarEmbedBatch",
            "exported": true,
            "line": 162,
            "column": 1,
            "endLine": 198
          },
          {
            "kind": "InterfaceDeclaration",
            "name": "SidecarFirstEmbedderOpts",
            "exported": true,
            "line": 200,
            "column": 1,
            "endLine": 241
          },
          {
            "kind": "FunctionDeclaration",
            "name": "nextSidecarUrl",
            "exported": true,
            "line": 247,
            "column": 1,
            "endLine": 247
          },
          {
            "kind": "FunctionDeclaration",
            "name": "nextSidecarUrl",
            "exported": true,
            "line": 248,
            "column": 1,
            "endLine": 248
          },
          {
            "kind": "FunctionDeclaration",
            "name": "nextSidecarUrl",
            "exported": true,
            "line": 249,
            "column": 1,
            "endLine": 251
          },
          {
            "kind": "FunctionDeclaration",
            "name": "settleSidecarEnsureWithin",
            "exported": true,
            "line": 256,
            "column": 1,
            "endLine": 282
          },
          {
            "kind": "FunctionDeclaration",
            "name": "buildSidecarFirstEmbedder",
            "exported": true,
            "line": 291,
            "column": 1,
            "endLine": 405
          }
        ]
      },
      {
        "repository": "libs/generic/rerank",
        "repositoryRevision": "40e78e06b07a94203e151a44979394acc2dbc871",
        "path": "src/sidecar-reranker.ts",
        "gitBlob": "7e9d79ec39396063a25a4ee10d1a1bb85cb4b9b9",
        "sha256": "359fdd2b4d5dc851ba4d0d906049ffbca6934773e678e233aec240a1599c94d9",
        "bytes": 22554,
        "text": "/**\n * Sidecar-first reranker client — the consumer side of the shared sidecar's\n * `POST {url}/rerank` wire.\n *\n * AVAILABILITY CONTRACT — deliberately identical to the embedder's\n * (`@papercusp/memory` sidecar-embedder.ts, sidecar-REQUIRED since WI-4021):\n * when a sidecar URL is configured the sidecar is REQUIRED. A failure is\n * retried briefly inside ONE total budget and then THROWN — never silently\n * absorbed by loading an in-process model. Silent failover is what let a\n * stalling sidecar drag every host into duplicate model loads and hid sidecar\n * sickness instead of surfacing it. The in-process engine is used ONLY when NO\n * sidecar is configured (desktop installs, tests, bench rigs), where it is the\n * sole engine rather than a fallback.\n *\n * ⚠ Throwing here does NOT make search brittle, and the two behaviours are not\n * in tension: this client throws so sidecar sickness is VISIBLE, and the lib's\n * single fail-safe seam one layer up (`localEngineScores` → `rerank`'s\n * passthrough) converts that throw into \"keep retrieval order\". So a rerank\n * outage still degrades rather than breaking search — it just stops being\n * invisible on the way.\n *\n * Same sidecar PROCESS as the embedder, so it is the same env var and the same\n * base URL — a host runs one sidecar serving both /embed and /rerank.\n *\n * Plain `fetch`, no new dependencies.\n *\n * ⚠ The retry/budget/transition POLICY below intentionally mirrors\n * sidecar-embedder.ts line for line. It is duplicated rather than shared\n * because these are two independently-borrowable libs and neither may depend\n * on the other. If you change the policy here, change it there too — and see\n * EI-19310953148940030, which proposes extracting it once a third client\n * appears (each bullet of that policy is a bug someone already paid for, so a\n * one-sided fix is the real risk).\n */\n\nimport { LOCAL_RERANKER_MODEL, scoreCrossEncoder, type LocalRerankOptions } from './local-engine';\nimport { RerankDeadlineError, isDeadlineFailure } from './scorer-gate';\n\n/**\n * Per-call scoring controls. Optional so that every existing\n * `(query, texts) => …` scorer still satisfies {@link RerankScoreFn} unchanged.\n */\nexport interface RerankScoreCallOpts {\n  /**\n   * Absolute epoch-ms instant after which scoring should STOP.\n   *\n   * Honoured by both engines. The in-process engine uses it to stop scoring\n   * after the caller has degraded; the sidecar path uses it for admission and\n   * for the HTTP attempt budget. Without this, concurrent callers can queue\n   * behind the sidecar's serialized scorer and then all abort together, while\n   * the client incorrectly reports a healthy-but-busy sidecar as down.\n   */\n  deadline?: number;\n}\n\n/** Scores `texts` against `query`, index-aligned. Throws on failure. */\nexport type RerankScoreFn = (\n  query: string,\n  texts: string[],\n  opts?: RerankScoreCallOpts,\n) => Promise<number[]>;\n\n/** The SAME env var the embedder uses — one sidecar process serves both. */\nexport const RERANK_SIDECAR_URL_ENV = 'PAPERCUSP_EMBED_SIDECAR_URL';\n\n/** The sidecar base URL this process should use, or null when none is\n *  configured (→ pure in-process reranking). */\nexport function resolveRerankSidecarUrl(env: NodeJS.ProcessEnv = process.env): string | null {\n  const url = env[RERANK_SIDECAR_URL_ENV]?.trim();\n  return url ? url.replace(/\\/$/, '') : null;\n}\n\nexport const DEFAULT_SIDECAR_TIMEOUT_MS = 15_000;\n/** Attempts per call when the sidecar is required (fast failures only — the\n *  shared `timeoutMs` budget caps total wall time regardless). */\nexport const DEFAULT_SIDECAR_MAX_ATTEMPTS = 3;\n\n/** Kept in sync with the sidecar server's own per-text cap. Truncating at this\n *  ONE client seam means no individual caller has to reimplement it, and the\n *  server's 400 for an oversized text becomes unreachable in practice. */\nexport const SIDECAR_MAX_TEXT_CHARS = 32_000;\n\nexport interface SidecarRerankResponse {\n  scores: number[];\n  runtime: string;\n  modelRev: string;\n}\n\n/** Thrown on a non-2xx sidecar response. Carries the HTTP status so a retry\n *  policy can tell a DETERMINISTIC client-side rejection (4xx — this exact\n *  request can never succeed) apart from a transient failure (5xx, connect\n *  refused, timeout). */\nexport class SidecarRerankHttpError extends Error {\n  readonly status: number;\n  constructor(status: number, detail: string) {\n    super(`sidecar_rerank_${status}: ${detail}`);\n    this.name = 'SidecarRerankHttpError';\n    this.status = status;\n  }\n}\n\n/** True for a failure retrying can never fix (a 4xx). False for anything else\n *  (network/connect/timeout/5xx), which IS worth a bounded retry. */\nexport function isNonRetryableSidecarError(e: unknown): boolean {\n  return e instanceof SidecarRerankHttpError && e.status >= 400 && e.status < 500;\n}\n\nexport interface SidecarRerankBatchOpts {\n  model: string;\n  query: string;\n  texts: string[];\n  timeoutMs?: number;\n  fetchFn?: typeof fetch;\n}\n\n/**\n * One wire call. Throws on ANY failure (network, timeout, non-200, malformed\n * or mis-sized response) — callers own the retry/fallback decision.\n */\nexport async function sidecarRerankBatch(url: string, opts: SidecarRerankBatchOpts): Promise<SidecarRerankResponse> {\n  const fetchFn = opts.fetchFn ?? fetch;\n  const timeoutMs = opts.timeoutMs ?? DEFAULT_SIDECAR_TIMEOUT_MS;\n  const texts = opts.texts.map((t) => (t.length > SIDECAR_MAX_TEXT_CHARS ? t.slice(0, SIDECAR_MAX_TEXT_CHARS) : t));\n  const query =\n    opts.query.length > SIDECAR_MAX_TEXT_CHARS ? opts.query.slice(0, SIDECAR_MAX_TEXT_CHARS) : opts.query;\n  const ctl = new AbortController();\n  const timer = setTimeout(() => ctl.abort(), timeoutMs);\n  try {\n    const res = await fetchFn(`${url.replace(/\\/$/, '')}/rerank`, {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ model: opts.model, query, texts }),\n      signal: ctl.signal,\n    });\n    if (!res.ok) {\n      const detail = await res.text().catch(() => '');\n      throw new SidecarRerankHttpError(res.status, detail.slice(0, 200));\n    }\n    const body = (await res.json()) as SidecarRerankResponse;\n    // A length mismatch would silently misalign every score with its document,\n    // producing a plausible-looking but wrong ordering — reject it loudly.\n    if (\n      !Array.isArray(body.scores) ||\n      body.scores.length !== texts.length ||\n      body.scores.some((s) => typeof s !== 'number' || !Number.isFinite(s))\n    ) {\n      throw new Error('sidecar_rerank_bad_shape: scores missing/mismatched');\n    }\n    return body;\n  } finally {\n    clearTimeout(timer);\n  }\n}\n\ninterface SidecarAdmissionEntry {\n  pairs: number;\n  deadline: number;\n  run: () => Promise<unknown>;\n  resolve: (value: unknown) => void;\n  reject: (reason?: unknown) => void;\n}\n\ninterface SidecarAdmissionGate {\n  enqueue<T>(pairs: number, deadline: number, run: () => Promise<T>): Promise<T>;\n}\n\n/**\n * The sidecar's default scorer is one serialized inference resource. A\n * per-scorer HTTP queue keeps concurrent callers from piling whole batches\n * into the server FIFO. Recent observations of the SAME batch size can shed\n * a call before it opens a socket. HTTP latency includes fixed queue/ensure\n * costs, so it cannot be divided by pair count and extrapolated to an unseen\n * batch size. Expired observations are unknown, allowing a bounded new sample.\n * This is deliberately a separate gate from scorer-gate.ts:\n * the latter protects local CPU, while this one protects the remote sidecar.\n */\nfunction createSidecarAdmissionGate(now: () => number): SidecarAdmissionGate {\n  let active = false;\n  const waiting: SidecarAdmissionEntry[] = [];\n  const batchCosts = new Map<number, { elapsedMs: number; measuredAt: number }>();\n\n  const deadlineError = (entry: SidecarAdmissionEntry, remaining: number, predictedMs: number | null): Error =>\n    new RerankDeadlineError(\n      `rerank: scoring deadline exceeded before sidecar dispatch for ${entry.pairs} pairs — ` +\n        `the sidecar queue needs ~${predictedMs ?? 'unknown'}ms but only ${Math.max(0, Math.round(remaining))}ms remain; ` +\n        'shedding now rather than labeling a healthy sidecar as down',\n    );\n\n  const pump = (): void => {\n    if (active) return;\n    const entry = waiting.shift();\n    if (!entry) return;\n\n    const instant = now();\n    const remaining = entry.deadline - instant;\n    for (const [pairs, cost] of batchCosts) {\n      if (instant - cost.measuredAt >= DEFAULT_SIDECAR_TIMEOUT_MS) batchCosts.delete(pairs);\n    }\n    const observed = batchCosts.get(entry.pairs);\n    const predictedMs = observed ? Math.ceil(observed.elapsedMs) : null;\n    if (remaining <= 0 || (predictedMs !== null && predictedMs > remaining)) {\n      entry.reject(deadlineError(entry, remaining, predictedMs));\n      // A queue can contain several calls whose deadlines have already\n      // expired. Drain those synchronously instead of leaving them to be\n      // mistaken for sidecar failures on a later wake.\n      pump();\n      return;\n    }\n\n    active = true;\n    const startedAt = now();\n    let completed = false;\n    void Promise.resolve()\n      .then(() => entry.run())\n      .then(\n        (value) => {\n          completed = true;\n          entry.resolve(value);\n        },\n        (err) => entry.reject(err),\n      )\n      .finally(() => {\n        if (completed) {\n          const elapsed = Math.max(0, now() - startedAt);\n          if (elapsed > 0 && entry.pairs > 0) {\n            const prior = batchCosts.get(entry.pairs);\n            batchCosts.set(entry.pairs, { elapsedMs: prior ? prior.elapsedMs * 0.3 + elapsed * 0.7 : elapsed,\n              measuredAt: now() });\n            // Bound bookkeeping even for clients with unusual batch sizes.\n            if (batchCosts.size > 128) batchCosts.delete(batchCosts.keys().next().value!);\n          }\n        }\n        active = false;\n        pump();\n      });\n  };\n\n  return {\n    enqueue<T>(pairs: number, deadline: number, run: () => Promise<T>): Promise<T> {\n      return new Promise<T>((resolve, reject) => {\n        waiting.push({\n          pairs,\n          deadline,\n          run,\n          resolve: (value) => resolve(value as T),\n          reject,\n        });\n        pump();\n      });\n    },\n  };\n}\n\n/**\n * Every operator-side scorer normally shares one builder, but keep the gate\n * shared even when a bench or a test creates several clients. The weak keys\n * avoid retaining custom fetch/clock seams after their caller is gone, while\n * the production `fetch`/`Date.now` pair gives all clients for one sidecar a\n * single admission lane.\n */\nconst sidecarAdmissionGates = new Map<string, WeakMap<object, WeakMap<object, SidecarAdmissionGate>>>();\n\nfunction sidecarAdmissionGateFor(\n  url: string,\n  model: string,\n  fetchFn: typeof fetch,\n  now: () => number,\n): SidecarAdmissionGate {\n  const key = `${url}\\0${model}`;\n  let byFetch = sidecarAdmissionGates.get(key);\n  if (!byFetch) {\n    byFetch = new WeakMap<object, WeakMap<object, SidecarAdmissionGate>>();\n    sidecarAdmissionGates.set(key, byFetch);\n  }\n  const fetchKey = fetchFn as unknown as object;\n  let byClock = byFetch.get(fetchKey);\n  if (!byClock) {\n    byClock = new WeakMap<object, SidecarAdmissionGate>();\n    byFetch.set(fetchKey, byClock);\n  }\n  const clockKey = now as unknown as object;\n  let gate = byClock.get(clockKey);\n  if (!gate) {\n    gate = createSidecarAdmissionGate(now);\n    byClock.set(clockKey, gate);\n  }\n  return gate;\n}\n\nexport interface SidecarFirstRerankerOpts {\n  /** Host observation seam for the configured in-process scorer. */\n  observeFallback?: LocalRerankOptions['observeFallback'];\n  /** Sidecar-side model name ('rerank' | 'rerank-fast'). */\n  model?: string;\n  /** In-process model id, used only when no sidecar is configured. */\n  localModel?: string;\n  /** In-process dtype, used only when no sidecar is configured. */\n  dtype?: string;\n  /** Sidecar base URL; defaults to resolveRerankSidecarUrl(). null/absent ⇒\n   *  pure in-process, unless `ensure` is set (see there). */\n  url?: string | null;\n  /** Explicit TOTAL sidecar cap per call across every attempt. When omitted,\n   * the caller's absolute deadline owns the budget; 15s is the fallback only\n   * when neither caller nor client supplies a budget. An explicit cap still\n   * wins over a longer caller deadline. */\n  timeoutMs?: number;\n  /** Attempts within the budget on sidecar failure (default 3). */\n  maxAttempts?: number;\n  fetchFn?: typeof fetch;\n  /** Clock seam for tests. */\n  now?: () => number;\n  /** Backoff-sleep seam for tests. */\n  sleepFn?: (ms: number) => Promise<void>;\n  /** In-process scorer seam (tests inject; default is the local ONNX engine). */\n  localScorer?: RerankScoreFn;\n  /** Down/up/rejected transition logging seam (transition-only, so a sustained\n   *  outage logs once rather than per call). 'rejected' = the sidecar is UP and\n   *  correctly refusing a bad request — distinct from 'down' so the log never\n   *  claims unavailability when the sidecar is fine. */\n  onTransition?: (state: 'down' | 'up' | 'rejected', detail: string) => void;\n  /** Re-establish the sidecar before each attempt. A sidecar this process\n   *  spawned may have exited after an idle period, and this hook re-launches\n   *  it on demand. It should be cheap when the sidecar is already running.\n   *  It runs inside the call's deadline. If the deadline passes first, the\n   *  ensure keeps running, so a later call finds the sidecar warming or ready.\n   *  Leave unset for a sidecar another process owns.\n   *  With `url` null, the ensure hook is the ONLY source of the address (a\n   *  sidecar this process is configured to spawn that is not up yet). The\n   *  client stays sidecar-only until an ensure reports a URL and never loads\n   *  the cross-encoder in-process (WI-10005932). */\n  ensure?: () => Promise<unknown>;\n}\n\n/** WI-10005932: admission-lane key for a spawned sidecar whose address is not known yet. */\nconst PENDING_SPAWNED_SIDECAR_KEY = 'spawned-sidecar:pending';\n\n/** Settle `work` within `ms`, or reject. A late settle is ignored, and because\n *  `Promise.race` subscribes to `work`, a late rejection is never unhandled.\n *  (The embedder client in @papercusp/memory has the same helper. This\n *  library does not depend on that one, so it keeps its own copy.) */\n/** P-530: an ensure hook may resolve to the sidecar's CURRENT base URL (a\n *  sidecar spawned on an ephemeral port comes back on a different port after\n *  an idle exit). Anything that is not a non-empty string keeps `current`.\n *  Same rule as nextSidecarUrl in @papercusp/memory; kept local for the same\n *  reason as the settle helper below. */\nexport function nextRerankSidecarUrl(current: string, ensured: unknown): string;\nexport function nextRerankSidecarUrl(current: string | null, ensured: unknown): string | null;\nexport function nextRerankSidecarUrl(current: string | null, ensured: unknown): string | null {\n  return typeof ensured === 'string' && ensured.trim() ? ensured.trim().replace(/\\/$/, '') : current;\n}\n\nasync function settleEnsureWithin<T>(work: Promise<T>, ms: number): Promise<T> {\n  let timer: ReturnType<typeof setTimeout> | undefined;\n  try {\n    return await Promise.race([\n      work,\n      new Promise<never>((_, reject) => {\n        timer = setTimeout(\n          () => reject(new Error(`sidecar_ensure_timeout: sidecar not ready within ${Math.max(0, Math.round(ms))}ms`)),\n          Math.max(0, ms),\n        );\n      }),\n    ]);\n  } finally {\n    clearTimeout(timer);\n  }\n}\n\n/**\n * Build a sidecar-first RerankScoreFn. With a url: sidecar-REQUIRED — brief\n * retries inside one total budget, then throw (`sidecar_required_unavailable`);\n * the in-process engine is never touched. Without a url: the plain in-process\n * cross-encoder.\n */\nexport function buildSidecarFirstReranker(opts: SidecarFirstRerankerOpts = {}): RerankScoreFn {\n  const url = opts.url === undefined ? resolveRerankSidecarUrl() : opts.url;\n  const model = opts.model ?? 'rerank';\n  const now = opts.now ?? Date.now;\n  const sleep = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));\n  const timeoutMs = opts.timeoutMs ?? DEFAULT_SIDECAR_TIMEOUT_MS;\n  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_SIDECAR_MAX_ATTEMPTS);\n  const onTransition =\n    opts.onTransition ??\n    ((state: 'down' | 'up' | 'rejected', detail: string) =>\n      console.warn(`[sidecar-reranker] ${model} sidecar ${state}: ${detail}`));\n\n  if (!url && !opts.ensure) {\n    // No sidecar configured: the in-process engine is the sole engine.\n    //\n    // `dtype` is forwarded ONLY when the caller actually set one. Defaulting it\n    // here to DEFAULT_RERANK_DTYPE would look harmless but would break the\n    // (device, dtype) pair: an explicitly-set dtype makes the engine treat the\n    // call as a caller override and take `device` from the host, so on a GPU\n    // host this line would silently request q8 weights on the CUDA provider.\n    // Passing nothing lets the engine resolve the whole coherent pair.\n    const local =\n      opts.localScorer ??\n      ((query: string, texts: string[], callOpts?: RerankScoreCallOpts) =>\n        scoreCrossEncoder(query, texts, {\n          observeFallback: opts.observeFallback,\n          model: opts.localModel ?? LOCAL_RERANKER_MODEL,\n          ...(opts.dtype === undefined ? {} : { dtype: opts.dtype }),\n          // THE path EI-20005411672741677 is about: no sidecar ⇒ this in-process\n          // engine holds the main thread. Forwarding the caller's deadline is\n          // what lets it stop scoring once the caller has already degraded,\n          // instead of running on unwatched. Without this line the deadline\n          // reaches every direct `localEngineScores` caller but NOT the shipped\n          // desktop path, which is the only one that actually has the problem.\n          ...(callOpts?.deadline === undefined ? {} : { deadline: callOpts.deadline }),\n        }));\n    return local;\n  }\n\n  const fetchFn = opts.fetchFn ?? fetch;\n  const admission = sidecarAdmissionGateFor(url || PENDING_SPAWNED_SIDECAR_KEY, model, fetchFn, now);\n  let wasDown = false;\n  // P-530: an ensure hook may report a new address (a sidecar re-launched on a\n  // fresh ephemeral port after an idle exit). Shared across calls so later\n  // calls start there. The admission gate stays keyed by the first URL: it\n  // still guards the same logical sidecar for this process.\n  let currentUrl: string | null = url || null;\n\n  return async (query: string, texts: string[], callOpts?: RerankScoreCallOpts): Promise<number[]> => {\n    if (texts.length === 0) return [];\n    if (callOpts?.deadline !== undefined && !Number.isFinite(callOpts.deadline)) {\n      throw new RangeError('Rerank deadline must be finite');\n    }\n    const ownDeadline = now() + timeoutMs;\n    // A default is not a second, hidden cap. Batch consumers (e.g. Dream)\n    // already budget their whole review and pass the remaining time here.\n    const deadline = callOpts?.deadline === undefined\n      ? ownDeadline\n      : opts.timeoutMs === undefined\n        ? callOpts.deadline\n        : Math.min(callOpts.deadline, ownDeadline);\n\n    return await admission.enqueue(texts.length, deadline, async () => {\n      let lastErr: unknown;\n      for (let attempt = 1; attempt <= maxAttempts; attempt++) {\n        const remaining = deadline - now();\n        if (remaining <= 0) throw new RerankDeadlineError('Rerank deadline elapsed before a sidecar attempt');\n        try {\n          let left = remaining;\n          if (opts.ensure) {\n            currentUrl = nextRerankSidecarUrl(currentUrl, await settleEnsureWithin(opts.ensure(), remaining));\n            left = deadline - now();\n            if (left <= 0) throw new RerankDeadlineError('Rerank deadline elapsed while re-establishing the sidecar');\n          }\n          if (currentUrl === null) throw new Error('sidecar_not_ready: no sidecar address reported yet');\n          const res = await sidecarRerankBatch(currentUrl, {\n            model,\n            query,\n            texts,\n            timeoutMs: left,\n            fetchFn,\n          });\n          if (wasDown) {\n            wasDown = false;\n            onTransition('up', `sidecar answering again (attempt ${attempt})`);\n          }\n          return res.scores;\n        } catch (e) {\n          lastErr = e;\n          if (isDeadlineFailure(e)) break;\n          // The request timer aborts fetch with AbortError, not our typed\n          // deadline error. Once our own deadline has elapsed, this says\n          // nothing about the sidecar's health and must not emit a down alarm.\n          if (now() >= deadline) {\n            lastErr = new RerankDeadlineError('Rerank deadline elapsed during the sidecar request');\n            break;\n          }\n          if (isNonRetryableSidecarError(e)) {\n            // Deterministic 4xx: the sidecar is UP and correctly rejecting THIS\n            // request. Retrying the same payload can never succeed, so stop\n            // instead of burning the budget. Logged 'rejected', never 'down'.\n            onTransition(\n              'rejected',\n              `${e instanceof Error ? e.message : String(e)} — sidecar correctly rejected the request (non-retryable, not a downtime issue)`,\n            );\n            break;\n          }\n          if (!wasDown) {\n            wasDown = true;\n            onTransition(\n              'down',\n              `${e instanceof Error ? e.message : String(e)} — sidecar is REQUIRED (no in-process fallback); retrying within budget`,\n            );\n          }\n          const backoffMs = 250 * attempt;\n          if (attempt < maxAttempts && deadline - now() > backoffMs + 250) await sleep(backoffMs);\n          else break;\n        }\n      }\n      if (isDeadlineFailure(lastErr)) throw lastErr;\n      throw isNonRetryableSidecarError(lastErr)\n        ? new Error(\n            `sidecar_rejected_request: ${lastErr instanceof Error ? lastErr.message : String(lastErr)} ` +\n              `(${currentUrl}, ${model}) — the sidecar rejected this request (non-retryable); ` +\n              'check payload shape/size — this is not a downtime issue',\n          )\n        : new Error(\n            `sidecar_required_unavailable: ${lastErr instanceof Error ? lastErr.message : String(lastErr)} ` +\n              `(${currentUrl}, ${model}, budget ${timeoutMs}ms) — reranking requires the sidecar; ` +\n              'search degrades to retrieval order while it is down',\n          );\n    });\n  };\n}\n",
        "parseDiagnostics": [],
        "moduleEdges": [
          {
            "kind": "import",
            "specifier": "./local-engine",
            "typeOnly": false,
            "defaultImport": null,
            "named": [
              {
                "name": "LOCAL_RERANKER_MODEL",
                "imported": "LOCAL_RERANKER_MODEL",
                "typeOnly": false
              },
              {
                "name": "scoreCrossEncoder",
                "imported": "scoreCrossEncoder",
                "typeOnly": false
              },
              {
                "name": "LocalRerankOptions",
                "imported": "LocalRerankOptions",
                "typeOnly": true
              }
            ],
            "line": 36,
            "column": 1,
            "endLine": 36,
            "resolved": [
              {
                "path": "src/local-engine.ts",
                "gitBlob": "fc3dad4ae91c448b87c0222800a98788f9afb7a2",
                "bytes": 25500,
                "sha256": "0d175f7d3e8206454626fa2ce614e69d040e3ac5ebbdf094fd3694b9bc61877d"
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
                "name": "RerankDeadlineError",
                "imported": "RerankDeadlineError",
                "typeOnly": false
              },
              {
                "name": "isDeadlineFailure",
                "imported": "isDeadlineFailure",
                "typeOnly": false
              }
            ],
            "line": 37,
            "column": 1,
            "endLine": 37,
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
        "calls": [
          {
            "callee": "env[RERANK_SIDECAR_URL_ENV]?.trim",
            "line": 69,
            "column": 15,
            "endLine": 69,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "url.replace",
            "line": 70,
            "column": 16,
            "endLine": 70,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "/\\/$/",
                "truncated": false
              },
              {
                "text": "''",
                "truncated": false
              }
            ]
          },
          {
            "callee": "super",
            "line": 96,
            "column": 5,
            "endLine": 96,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "`sidecar_rerank_${status}: ${detail}`",
                "truncated": false
              }
            ]
          },
          {
            "callee": "opts.texts.map",
            "line": 123,
            "column": 17,
            "endLine": 123,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "(t) => (t.length > SIDECAR_MAX_TEXT_CHARS ? t.slice(0, SIDECAR_MAX_TEXT_CHARS) : t)",
                "truncated": false
              }
            ]
          },
          {
            "callee": "t.slice",
            "line": 123,
            "column": 76,
            "endLine": 123,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "0",
                "truncated": false
              },
              {
                "text": "SIDECAR_MAX_TEXT_CHARS",
                "truncated": false
              }
            ]
          },
          {
            "callee": "opts.query.slice",
            "line": 125,
            "column": 50,
            "endLine": 125,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "0",
                "truncated": false
              },
              {
                "text": "SIDECAR_MAX_TEXT_CHARS",
                "truncated": false
              }
            ]
          },
          {
            "callee": "setTimeout",
            "line": 127,
            "column": 17,
            "endLine": 127,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "() => ctl.abort()",
                "truncated": false
              },
              {
                "text": "timeoutMs",
                "truncated": false
              }
            ]
          },
          {
            "callee": "ctl.abort",
            "line": 127,
            "column": 34,
            "endLine": 127,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "fetchFn",
            "line": 129,
            "column": 23,
            "endLine": 134,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "`${url.replace(/\\/$/, '')}/rerank`",
                "truncated": false
              },
              {
                "text": "{\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ model: opts.model, query, texts }),\n      signal: ctl.signal,\n    }",
                "truncated": false
              }
            ]
          },
          {
            "callee": "url.replace",
            "line": 129,
            "column": 34,
            "endLine": 129,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "/\\/$/",
                "truncated": false
              },
              {
                "text": "''",
                "truncated": false
              }
            ]
          },
          {
            "callee": "JSON.stringify",
            "line": 132,
            "column": 13,
            "endLine": 132,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "{ model: opts.model, query, texts }",
                "truncated": false
              }
            ]
          },
          {
            "callee": "res.text().catch",
            "line": 136,
            "column": 28,
            "endLine": 136,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "() => ''",
                "truncated": false
              }
            ]
          },
          {
            "callee": "res.text",
            "line": 136,
            "column": 28,
            "endLine": 136,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "detail.slice",
            "line": 137,
            "column": 52,
            "endLine": 137,
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
            "callee": "res.json",
            "line": 139,
            "column": 25,
            "endLine": 139,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "Array.isArray",
            "line": 143,
            "column": 8,
            "endLine": 143,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "body.scores",
                "truncated": false
              }
            ]
          },
          {
            "callee": "body.scores.some",
            "line": 145,
            "column": 7,
            "endLine": 145,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "(s) => typeof s !== 'number' || !Number.isFinite(s)",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Number.isFinite",
            "line": 145,
            "column": 57,
            "endLine": 145,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "s",
                "truncated": false
              }
            ]
          },
          {
            "callee": "clearTimeout",
            "line": 151,
            "column": 5,
            "endLine": 151,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "timer",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Math.max",
            "line": 185,
            "column": 76,
            "endLine": 185,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "0",
                "truncated": false
              },
              {
                "text": "Math.round(remaining)",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Math.round",
            "line": 185,
            "column": 88,
            "endLine": 185,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "remaining",
                "truncated": false
              }
            ]
          },
          {
            "callee": "waiting.shift",
            "line": 191,
            "column": 19,
            "endLine": 191,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "now",
            "line": 194,
            "column": 21,
            "endLine": 194,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "batchCosts.delete",
            "line": 197,
            "column": 68,
            "endLine": 197,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "pairs",
                "truncated": false
              }
            ]
          },
          {
            "callee": "batchCosts.get",
            "line": 199,
            "column": 22,
            "endLine": 199,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "entry.pairs",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Math.ceil",
            "line": 200,
            "column": 36,
            "endLine": 200,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "observed.elapsedMs",
                "truncated": false
              }
            ]
          },
          {
            "callee": "entry.reject",
            "line": 202,
            "column": 7,
            "endLine": 202,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "deadlineError(entry, remaining, predictedMs)",
                "truncated": false
              }
            ]
          },
          {
            "callee": "deadlineError",
            "line": 202,
            "column": 20,
            "endLine": 202,
            "argumentCount": 3,
            "arguments": [
              {
                "text": "entry",
                "truncated": false
              },
              {
                "text": "remaining",
                "truncated": false
              },
              {
                "text": "predictedMs",
                "truncated": false
              }
            ]
          },
          {
            "callee": "pump",
            "line": 206,
            "column": 7,
            "endLine": 206,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "now",
            "line": 211,
            "column": 23,
            "endLine": 211,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "Promise.resolve()\n      .then(() => entry.run())\n      .then(\n        (value) => {\n          completed = true;\n          entry.resolve(value);\n        },\n        (err) => entry.reject(err),\n      )\n      .finally",
            "line": 213,
            "column": 10,
            "endLine": 235,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "() => {\n        if (completed) {\n          const elapsed = Math.max(0, now() - startedAt);\n          if (elapsed > 0 && entry.pairs > 0) {\n            const prior = batchCosts.get(entry.pairs);\n            batchCosts.set(entry.pairs, { elapsedMs: prior ? prior.elapsedMs * 0.3 + elapsed * 0.7 : elapsed,\n              measuredAt: now() });\n            // Bound",
                "truncated": true
              }
            ]
          },
          {
            "callee": "Promise.resolve()\n      .then(() => entry.run())\n      .then",
            "line": 213,
            "column": 10,
            "endLine": 221,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "(value) => {\n          completed = true;\n          entry.resolve(value);\n        }",
                "truncated": false
              },
              {
                "text": "(err) => entry.reject(err)",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Promise.resolve()\n      .then",
            "line": 213,
            "column": 10,
            "endLine": 214,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "() => entry.run()",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Promise.resolve",
            "line": 213,
            "column": 10,
            "endLine": 213,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "entry.run",
            "line": 214,
            "column": 19,
            "endLine": 214,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "entry.resolve",
            "line": 218,
            "column": 11,
            "endLine": 218,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "value",
                "truncated": false
              }
            ]
          },
          {
            "callee": "entry.reject",
            "line": 220,
            "column": 18,
            "endLine": 220,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "err",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Math.max",
            "line": 224,
            "column": 27,
            "endLine": 224,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "0",
                "truncated": false
              },
              {
                "text": "now() - startedAt",
                "truncated": false
              }
            ]
          },
          {
            "callee": "now",
            "line": 224,
            "column": 39,
            "endLine": 224,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "batchCosts.get",
            "line": 226,
            "column": 27,
            "endLine": 226,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "entry.pairs",
                "truncated": false
              }
            ]
          },
          {
            "callee": "batchCosts.set",
            "line": 227,
            "column": 13,
            "endLine": 228,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "entry.pairs",
                "truncated": false
              },
              {
                "text": "{ elapsedMs: prior ? prior.elapsedMs * 0.3 + elapsed * 0.7 : elapsed,\n              measuredAt: now() }",
                "truncated": false
              }
            ]
          },
          {
            "callee": "now",
            "line": 228,
            "column": 27,
            "endLine": 228,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "batchCosts.delete",
            "line": 230,
            "column": 40,
            "endLine": 230,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "batchCosts.keys().next().value!",
                "truncated": false
              }
            ]
          },
          {
            "callee": "batchCosts.keys().next",
            "line": 230,
            "column": 58,
            "endLine": 230,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "batchCosts.keys",
            "line": 230,
            "column": 58,
            "endLine": 230,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "pump",
            "line": 234,
            "column": 9,
            "endLine": 234,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "waiting.push",
            "line": 241,
            "column": 9,
            "endLine": 247,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "{\n          pairs,\n          deadline,\n          run,\n          resolve: (value) => resolve(value as T),\n          reject,\n        }",
                "truncated": false
              }
            ]
          },
          {
            "callee": "resolve",
            "line": 245,
            "column": 31,
            "endLine": 245,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "value as T",
                "truncated": false
              }
            ]
          },
          {
            "callee": "pump",
            "line": 248,
            "column": 9,
            "endLine": 248,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "sidecarAdmissionGates.get",
            "line": 270,
            "column": 17,
            "endLine": 270,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "key",
                "truncated": false
              }
            ]
          },
          {
            "callee": "sidecarAdmissionGates.set",
            "line": 273,
            "column": 5,
            "endLine": 273,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "key",
                "truncated": false
              },
              {
                "text": "byFetch",
                "truncated": false
              }
            ]
          },
          {
            "callee": "byFetch.get",
            "line": 276,
            "column": 17,
            "endLine": 276,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "fetchKey",
                "truncated": false
              }
            ]
          },
          {
            "callee": "byFetch.set",
            "line": 279,
            "column": 5,
            "endLine": 279,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "fetchKey",
                "truncated": false
              },
              {
                "text": "byClock",
                "truncated": false
              }
            ]
          },
          {
            "callee": "byClock.get",
            "line": 282,
            "column": 14,
            "endLine": 282,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "clockKey",
                "truncated": false
              }
            ]
          },
          {
            "callee": "createSidecarAdmissionGate",
            "line": 284,
            "column": 12,
            "endLine": 284,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "now",
                "truncated": false
              }
            ]
          },
          {
            "callee": "byClock.set",
            "line": 285,
            "column": 5,
            "endLine": 285,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "clockKey",
                "truncated": false
              },
              {
                "text": "gate",
                "truncated": false
              }
            ]
          },
          {
            "callee": "ensured.trim",
            "line": 349,
            "column": 41,
            "endLine": 349,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "ensured.trim().replace",
            "line": 349,
            "column": 58,
            "endLine": 349,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "/\\/$/",
                "truncated": false
              },
              {
                "text": "''",
                "truncated": false
              }
            ]
          },
          {
            "callee": "ensured.trim",
            "line": 349,
            "column": 58,
            "endLine": 349,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "Promise.race",
            "line": 355,
            "column": 18,
            "endLine": 363,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "[\n      work,\n      new Promise<never>((_, reject) => {\n        timer = setTimeout(\n          () => reject(new Error(`sidecar_ensure_timeout: sidecar not ready within ${Math.max(0, Math.round(ms))}ms`)),\n          Math.max(0, ms),\n        );\n      }),\n    ]",
                "truncated": false
              }
            ]
          },
          {
            "callee": "setTimeout",
            "line": 358,
            "column": 17,
            "endLine": 361,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "() => reject(new Error(`sidecar_ensure_timeout: sidecar not ready within ${Math.max(0, Math.round(ms))}ms`))",
                "truncated": false
              },
              {
                "text": "Math.max(0, ms)",
                "truncated": false
              }
            ]
          },
          {
            "callee": "reject",
            "line": 359,
            "column": 17,
            "endLine": 359,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "new Error(`sidecar_ensure_timeout: sidecar not ready within ${Math.max(0, Math.round(ms))}ms`)",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Math.max",
            "line": 359,
            "column": 86,
            "endLine": 359,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "0",
                "truncated": false
              },
              {
                "text": "Math.round(ms)",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Math.round",
            "line": 359,
            "column": 98,
            "endLine": 359,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "ms",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Math.max",
            "line": 360,
            "column": 11,
            "endLine": 360,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "0",
                "truncated": false
              },
              {
                "text": "ms",
                "truncated": false
              }
            ]
          },
          {
            "callee": "clearTimeout",
            "line": 365,
            "column": 5,
            "endLine": 365,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "timer",
                "truncated": false
              }
            ]
          },
          {
            "callee": "resolveRerankSidecarUrl",
            "line": 376,
            "column": 40,
            "endLine": 376,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "setTimeout",
            "line": 379,
            "column": 75,
            "endLine": 379,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "r",
                "truncated": false
              },
              {
                "text": "ms",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Math.max",
            "line": 381,
            "column": 23,
            "endLine": 381,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "1",
                "truncated": false
              },
              {
                "text": "opts.maxAttempts ?? DEFAULT_SIDECAR_MAX_ATTEMPTS",
                "truncated": false
              }
            ]
          },
          {
            "callee": "console.warn",
            "line": 385,
            "column": 7,
            "endLine": 385,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "`[sidecar-reranker] ${model} sidecar ${state}: ${detail}`",
                "truncated": false
              }
            ]
          },
          {
            "callee": "scoreCrossEncoder",
            "line": 399,
            "column": 9,
            "endLine": 410,
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
                "text": "{\n          observeFallback: opts.observeFallback,\n          model: opts.localModel ?? LOCAL_RERANKER_MODEL,\n          ...(opts.dtype === undefined ? {} : { dtype: opts.dtype }),\n          // THE path EI-20005411672741677 is about: no sidecar ⇒ this in-process\n          // engine holds the main thread. Forwarding the caller's deadline is\n          // what le",
                "truncated": true
              }
            ]
          },
          {
            "callee": "sidecarAdmissionGateFor",
            "line": 415,
            "column": 21,
            "endLine": 415,
            "argumentCount": 4,
            "arguments": [
              {
                "text": "url || PENDING_SPAWNED_SIDECAR_KEY",
                "truncated": false
              },
              {
                "text": "model",
                "truncated": false
              },
              {
                "text": "fetchFn",
                "truncated": false
              },
              {
                "text": "now",
                "truncated": false
              }
            ]
          },
          {
            "callee": "Number.isFinite",
            "line": 425,
            "column": 46,
            "endLine": 425,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "callOpts.deadline",
                "truncated": false
              }
            ]
          },
          {
            "callee": "now",
            "line": 428,
            "column": 25,
            "endLine": 428,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "Math.min",
            "line": 435,
            "column": 11,
            "endLine": 435,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "callOpts.deadline",
                "truncated": false
              },
              {
                "text": "ownDeadline",
                "truncated": false
              }
            ]
          },
          {
            "callee": "admission.enqueue",
            "line": 437,
            "column": 18,
            "endLine": 506,
            "argumentCount": 3,
            "arguments": [
              {
                "text": "texts.length",
                "truncated": false
              },
              {
                "text": "deadline",
                "truncated": false
              },
              {
                "text": "async () => {\n      let lastErr: unknown;\n      for (let attempt = 1; attempt <= maxAttempts; attempt++) {\n        const remaining = deadline - now();\n        if (remaining <= 0) throw new RerankDeadlineError('Rerank deadline elapsed before a sidecar attempt');\n        try {\n          let left = remaining;\n          if (opts.ensure) {\n            currentUrl ",
                "truncated": true
              }
            ]
          },
          {
            "callee": "now",
            "line": 440,
            "column": 38,
            "endLine": 440,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "nextRerankSidecarUrl",
            "line": 445,
            "column": 26,
            "endLine": 445,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "currentUrl",
                "truncated": false
              },
              {
                "text": "await settleEnsureWithin(opts.ensure(), remaining)",
                "truncated": false
              }
            ]
          },
          {
            "callee": "settleEnsureWithin",
            "line": 445,
            "column": 65,
            "endLine": 445,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "opts.ensure()",
                "truncated": false
              },
              {
                "text": "remaining",
                "truncated": false
              }
            ]
          },
          {
            "callee": "opts.ensure",
            "line": 445,
            "column": 84,
            "endLine": 445,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "now",
            "line": 446,
            "column": 31,
            "endLine": 446,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "sidecarRerankBatch",
            "line": 450,
            "column": 29,
            "endLine": 456,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "currentUrl",
                "truncated": false
              },
              {
                "text": "{\n            model,\n            query,\n            texts,\n            timeoutMs: left,\n            fetchFn,\n          }",
                "truncated": false
              }
            ]
          },
          {
            "callee": "onTransition",
            "line": 459,
            "column": 13,
            "endLine": 459,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "'up'",
                "truncated": false
              },
              {
                "text": "`sidecar answering again (attempt ${attempt})`",
                "truncated": false
              }
            ]
          },
          {
            "callee": "isDeadlineFailure",
            "line": 464,
            "column": 15,
            "endLine": 464,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "e",
                "truncated": false
              }
            ]
          },
          {
            "callee": "now",
            "line": 468,
            "column": 15,
            "endLine": 468,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "isNonRetryableSidecarError",
            "line": 472,
            "column": 15,
            "endLine": 472,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "e",
                "truncated": false
              }
            ]
          },
          {
            "callee": "onTransition",
            "line": 476,
            "column": 13,
            "endLine": 479,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "'rejected'",
                "truncated": false
              },
              {
                "text": "`${e instanceof Error ? e.message : String(e)} — sidecar correctly rejected the request (non-retryable, not a downtime issue)`",
                "truncated": false
              }
            ]
          },
          {
            "callee": "String",
            "line": 478,
            "column": 51,
            "endLine": 478,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "e",
                "truncated": false
              }
            ]
          },
          {
            "callee": "onTransition",
            "line": 484,
            "column": 13,
            "endLine": 487,
            "argumentCount": 2,
            "arguments": [
              {
                "text": "'down'",
                "truncated": false
              },
              {
                "text": "`${e instanceof Error ? e.message : String(e)} — sidecar is REQUIRED (no in-process fallback); retrying within budget`",
                "truncated": false
              }
            ]
          },
          {
            "callee": "String",
            "line": 486,
            "column": 51,
            "endLine": 486,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "e",
                "truncated": false
              }
            ]
          },
          {
            "callee": "now",
            "line": 490,
            "column": 51,
            "endLine": 490,
            "argumentCount": 0,
            "arguments": []
          },
          {
            "callee": "sleep",
            "line": 490,
            "column": 82,
            "endLine": 490,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "backoffMs",
                "truncated": false
              }
            ]
          },
          {
            "callee": "isDeadlineFailure",
            "line": 494,
            "column": 11,
            "endLine": 494,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "lastErr",
                "truncated": false
              }
            ]
          },
          {
            "callee": "isNonRetryableSidecarError",
            "line": 495,
            "column": 13,
            "endLine": 495,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "lastErr",
                "truncated": false
              }
            ]
          },
          {
            "callee": "String",
            "line": 497,
            "column": 87,
            "endLine": 497,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "lastErr",
                "truncated": false
              }
            ]
          },
          {
            "callee": "String",
            "line": 502,
            "column": 91,
            "endLine": 502,
            "argumentCount": 1,
            "arguments": [
              {
                "text": "lastErr",
                "truncated": false
              }
            ]
          }
        ],
        "globals": [
          {
            "name": "process.env",
            "line": 68,
            "column": 66,
            "endLine": 68
          }
        ],
        "topLevelStatements": [
          {
            "kind": "ImportDeclaration",
            "name": null,
            "exported": false,
            "line": 36,
            "column": 1,
            "endLine": 36
          },
          {
            "kind": "ImportDeclaration",
            "name": null,
            "exported": false,
            "line": 37,
            "column": 1,
            "endLine": 37
          },
          {
            "kind": "InterfaceDeclaration",
            "name": "RerankScoreCallOpts",
            "exported": true,
            "line": 43,
            "column": 1,
            "endLine": 54
          },
          {
            "kind": "TypeAliasDeclaration",
            "name": "RerankScoreFn",
            "exported": true,
            "line": 57,
            "column": 1,
            "endLine": 61
          },
          {
            "kind": "FirstStatement",
            "name": null,
            "exported": true,
            "line": 64,
            "column": 1,
            "endLine": 64
          },
          {
            "kind": "FunctionDeclaration",
            "name": "resolveRerankSidecarUrl",
            "exported": true,
            "line": 68,
            "column": 1,
            "endLine": 71
          },
          {
            "kind": "FirstStatement",
            "name": null,
            "exported": true,
            "line": 73,
            "column": 1,
            "endLine": 73
          },
          {
            "kind": "FirstStatement",
            "name": null,
            "exported": true,
            "line": 76,
            "column": 1,
            "endLine": 76
          },
          {
            "kind": "FirstStatement",
            "name": null,
            "exported": true,
            "line": 81,
            "column": 1,
            "endLine": 81
          },
          {
            "kind": "InterfaceDeclaration",
            "name": "SidecarRerankResponse",
            "exported": true,
            "line": 83,
            "column": 1,
            "endLine": 87
          },
          {
            "kind": "ClassDeclaration",
            "name": "SidecarRerankHttpError",
            "exported": true,
            "line": 93,
            "column": 1,
            "endLine": 100
          },
          {
            "kind": "FunctionDeclaration",
            "name": "isNonRetryableSidecarError",
            "exported": true,
            "line": 104,
            "column": 1,
            "endLine": 106
          },
          {
            "kind": "InterfaceDeclaration",
            "name": "SidecarRerankBatchOpts",
            "exported": true,
            "line": 108,
            "column": 1,
            "endLine": 114
          },
          {
            "kind": "FunctionDeclaration",
            "name": "sidecarRerankBatch",
            "exported": true,
            "line": 120,
            "column": 1,
            "endLine": 153
          },
          {
            "kind": "InterfaceDeclaration",
            "name": "SidecarAdmissionEntry",
            "exported": false,
            "line": 155,
            "column": 1,
            "endLine": 161
          },
          {
            "kind": "InterfaceDeclaration",
            "name": "SidecarAdmissionGate",
            "exported": false,
            "line": 163,
            "column": 1,
            "endLine": 165
          },
          {
            "kind": "FunctionDeclaration",
            "name": "createSidecarAdmissionGate",
            "exported": false,
            "line": 177,
            "column": 1,
            "endLine": 252
          },
          {
            "kind": "FirstStatement",
            "name": null,
            "exported": false,
            "line": 261,
            "column": 1,
            "endLine": 261
          },
          {
            "kind": "FunctionDeclaration",
            "name": "sidecarAdmissionGateFor",
            "exported": false,
            "line": 263,
            "column": 1,
            "endLine": 288
          },
          {
            "kind": "InterfaceDeclaration",
            "name": "SidecarFirstRerankerOpts",
            "exported": true,
            "line": 290,
            "column": 1,
            "endLine": 332
          },
          {
            "kind": "FirstStatement",
            "name": null,
            "exported": false,
            "line": 335,
            "column": 1,
            "endLine": 335
          },
          {
            "kind": "FunctionDeclaration",
            "name": "nextRerankSidecarUrl",
            "exported": true,
            "line": 346,
            "column": 1,
            "endLine": 346
          },
          {
            "kind": "FunctionDeclaration",
            "name": "nextRerankSidecarUrl",
            "exported": true,
            "line": 347,
            "column": 1,
            "endLine": 347
          },
          {
            "kind": "FunctionDeclaration",
            "name": "nextRerankSidecarUrl",
            "exported": true,
            "line": 348,
            "column": 1,
            "endLine": 350
          },
          {
            "kind": "FunctionDeclaration",
            "name": "settleEnsureWithin",
            "exported": false,
            "line": 352,
            "column": 1,
            "endLine": 367
          },
          {
            "kind": "FunctionDeclaration",
            "name": "buildSidecarFirstReranker",
            "exported": true,
            "line": 375,
            "column": 1,
            "endLine": 508
          }
        ]
      }
    ]
  },
  "verification": {
    "schema": "p001-sidecar-client-source-verification-v1",
    "method": "Independent Python hashlib SHA256 and git-blob SHA1 of git-show bytes versus Node crypto and git-cat-file capture; exact source text, static import assertions and resolved relative target identities. AST parsing is navigation only.",
    "extraction": {
      "path": "/tmp/p001-sidecar-client-source-extraction-20261106-v1.json",
      "bytes": 111000,
      "sha256": "c60dc551ec8620aa5e472e9d2486306a93c16900d32640186ef8987ba243ef5c"
    },
    "checks": [
      {
        "repository": "libs/generic/memory",
        "revision": "fe9878936d3da86d872fc1a5fdd29877e903d1f0",
        "path": "src/sidecar-embedder.ts",
        "sha256": "6aa17f449b4fe25ac09da37ce77dc77070f0c0fb091e6d72a31bf9c312b9a092",
        "gitBlob": "f4df564acaa54415b14b59b3a7ab41969b447937",
        "bytes": 19360,
        "textMatches": true,
        "metadataMatches": true,
        "staticImportAssertionsMatch": true,
        "diagnosticsEmpty": true,
        "callsObserved": 69,
        "resolvedModuleIdentitiesMatch": true
      },
      {
        "repository": "libs/generic/rerank",
        "revision": "40e78e06b07a94203e151a44979394acc2dbc871",
        "path": "src/sidecar-reranker.ts",
        "sha256": "359fdd2b4d5dc851ba4d0d906049ffbca6934773e678e233aec240a1599c94d9",
        "gitBlob": "7e9d79ec39396063a25a4ee10d1a1bb85cb4b9b9",
        "bytes": 22554,
        "textMatches": true,
        "metadataMatches": true,
        "staticImportAssertionsMatch": true,
        "diagnosticsEmpty": true,
        "callsObserved": 96,
        "resolvedModuleIdentitiesMatch": true
      }
    ]
  },
  "scannerScope": {
    "parser": "TypeScript compiler API; offline parsing only",
    "moduleEdges": "Static declaration and per-binding type-only markers plus exact relative candidate source identities. Syntax does not prove loaded closure.",
    "calls": "All syntactic call expressions retained with bounded argument snippets, locations and full source text; no runtime effect inference.",
    "resolution": "Pinned git tree candidates, not deployed loader resolution or tree-shaking proof."
  },
  "sourceFindings": [
    {
      "repository": "libs/generic/memory",
      "path": "src/sidecar-embedder.ts",
      "findings": [
        {
          "lines": [
            35
          ],
          "finding": "The only direct source import is type-only GemmaEmbedKind; this does not qualify package-entry re-export or runtime dependency closure."
        },
        {
          "lines": [
            44,
            45,
            46,
            162,
            163,
            174,
            177
          ],
          "finding": "The default resolver reads PAPERCUSP_EMBED_SIDECAR_URL from process.env. The supplied or resolved URL is trimmed and used for POST /embed through opts.fetchFn or ambient fetch. These source functions contain no loopback allowlist or broker capability decision; upstream address authority remains unmeasured."
        },
        {
          "lines": [
            168,
            169,
            170,
            171,
            172,
            194,
            195,
            196
          ],
          "finding": "The batch request owns an AbortController and timer, links a caller abort event and removes the event listener in finally."
        },
        {
          "lines": [
            291,
            292,
            294,
            298,
            302,
            307,
            310,
            318,
            322
          ],
          "finding": "With neither URL nor ensure hook, the returned function lazily builds opts.fallback and invokes its EmbedFn. Injected fallback/fetch/clock/sleep/transition hooks remain opaque code/effect dependencies."
        },
        {
          "lines": [
            256,
            264,
            265,
            267,
            279,
            280,
            341,
            342
          ],
          "finding": "The ensure hook is raced against deadline/caller abort; the Promise race does not cancel the underlying hook. Its independently owned sidecar spawn/restart effects require separate closure."
        },
        {
          "lines": [
            336,
            365,
            371,
            379,
            387,
            391,
            398
          ],
          "finding": "Configured sidecar mode uses bounded attempts/backoff and throws on rejection or unavailability; transition callbacks and console.warn are effect seams. This availability policy does not establish security confinement."
        }
      ]
    },
    {
      "repository": "libs/generic/rerank",
      "path": "src/sidecar-reranker.ts",
      "findings": [
        {
          "lines": [
            36,
            37
          ],
          "finding": "Runtime module imports bind local-engine and scorer-gate before builder branch selection. LocalRerankOptions in the mixed import is type-only. A configured remote branch does not remove these runtime dependency obligations."
        },
        {
          "lines": [
            64,
            68,
            69,
            70,
            120,
            121,
            126,
            127,
            129,
            132,
            150,
            151
          ],
          "finding": "The resolver uses the shared environment URL and POST /rerank uses injected or ambient fetch, an AbortController and a timer. Local source address normalization does not establish caller authorization or destination confinement."
        },
        {
          "lines": [
            177,
            189,
            213,
            214,
            222,
            261,
            263,
            269,
            284
          ],
          "finding": "A module-level Map and weak maps coordinate per-URL/model/fetch/clock queues. Queue Promise callbacks and the clock are effect dependencies; this is scheduling, not an OS isolation boundary."
        },
        {
          "lines": [
            375,
            376,
            379,
            383,
            387,
            396,
            397,
            399,
            409,
            411
          ],
          "finding": "With neither URL nor ensure hook, localScorer or scoreCrossEncoder is returned, forwarding caller deadline and local model/dtype options. The default local-engine implementation is a new named runtime source obligation."
        },
        {
          "lines": [
            352,
            355,
            356,
            358,
            365,
            444,
            445
          ],
          "finding": "Ensure work is raced against a timer without cancellation of the underlying hook. Hook-owned effects and resolved URL provenance remain open."
        },
        {
          "lines": [
            414,
            415,
            423,
            437,
            450,
            476,
            484,
            490,
            494,
            495
          ],
          "finding": "Configured mode goes through shared admission and bounded attempts then throws without switching to the in-process scorer. Fetch, transition, clock and sleep callbacks remain independently unqualified."
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
    "Configured handler/entry/caller occurrence population remains incomplete.",
    "Runtime package-entry, local-engine, scorer-gate, opaque injected callback and external dependency/effect closure remains incomplete.",
    "Loaded current-build/distribution/platform identities and independently immutable row applicability remain unmeasured.",
    "Row-bound positive/negative security acceptance and outside-lineage review are not supplied by source preparation."
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
        "path": "src/local-engine.ts",
        "gitBlob": "fc3dad4ae91c448b87c0222800a98788f9afb7a2",
        "bytes": 25500,
        "sha256": "0d175f7d3e8206454626fa2ce614e69d040e3ac5ebbdf094fd3694b9bc61877d",
        "via": "./local-engine"
      },
      {
        "repository": "libs/generic/rerank",
        "repositoryRevision": "40e78e06b07a94203e151a44979394acc2dbc871",
        "path": "src/scorer-gate.ts",
        "gitBlob": "57cc70ea08efdd476c8afa9af3da0e647fc6d29b",
        "bytes": 9054,
        "sha256": "10a883a24c62748d3f83f11f7cd5d0417afc124dc860f90fed723a32c7b6f602",
        "via": "./scorer-gate"
      }
    ],
    "instruction": "Read these exact runtime-imported local-engine and scorer-gate source files next. Reuse v14 and all retained prior identities; do not replay prior sources/tests/census or claim a loaded/confinement closure."
  }
}
