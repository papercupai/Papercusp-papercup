/**
 * P-002 (shared-embedding-sidecar-and-enrichment-2026-07-10): the embed
 * sidecar's HTTP surface, driven with INJECTED fake builders on an ephemeral
 * port — no ONNX model ever loads here. The real-model bit-identical proof is
 * the P-005 live smoke (eval CLI sidecar leg vs in-process leg); this file
 * pins the wire contract: validation, routing, D-004 response shape, lazy
 * per-model:kind embedder memoization, and loopback-only binding.
 */
import { getRerankWorkerState, isCoherentTarget } from '@papercusp/rerank';
import { getWorkerState as getMemoryWorkerState } from '@papercusp/memory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbedDeviceSettingLoad } from './embed-device-setting';
import { getBuildInfo } from '../build-info';
import { getBundleStaleness, type BundleStaleness } from '../bundle-staleness';
import type { AdmissionContext } from '../resource-governor/admission';
import type { GovernedOperationInput, runGovernedOperation } from '../resource-governor/execution';
import {
  createEmbedSidecarServer,
  defaultWorkerStates,
  defaultBuildIdentity,
  embedResponseMeasuredModel,
  EMBED_SIDECAR_CONCURRENCY_ENV,
  resolveWarmModels,
  resolveWarmRerankers,
  resolveEmbedSidecarConcurrency,
  validateEmbedRequest,
  validateRerankRequest,
  EMBED_SIDECAR_WARM_ENV,
  MAX_TEXTS_PER_CALL,
  EMBED_SIDECAR_CAP_DEVICE_RELOAD,
  EMBED_SIDECAR_CAP_EMBED,
  EMBED_SIDECAR_CAP_HEALTHZ,
  EMBED_SIDECAR_CAP_RERANK,
  EMBED_SIDECAR_RUNTIME,
  type EmbedDeviceReloadResponse,
  EMBED_SIDECAR_INTERACTIVE_PRIORITY,
  EMBED_SIDECAR_BACKGROUND_PRIORITY,
  EMBED_SIDECAR_PRIORITY_BURST_MAX,
  type EmbedderBuilders,
  type EmbedSidecarHandle,
  type RerankerBuilders,
} from './embed-sidecar-server';

describe('resolveWarmModels', () => {
  it('defaults to gemma when unset/blank', () => {
    expect(resolveWarmModels({})).toEqual(['gemma']);
    expect(resolveWarmModels({ [EMBED_SIDECAR_WARM_ENV]: '  ' })).toEqual(['gemma']);
  });

  it('parses a comma list, trims, dedupes, and drops unknown names', () => {
    expect(resolveWarmModels({ [EMBED_SIDECAR_WARM_ENV]: 'gemma, harrier' })).toEqual(['gemma', 'harrier']);
    expect(resolveWarmModels({ [EMBED_SIDECAR_WARM_ENV]: 'harrier,harrier,gpt-9' })).toEqual(['harrier']);
  });

  it('falls back to gemma when every name is unknown', () => {
    expect(resolveWarmModels({ [EMBED_SIDECAR_WARM_ENV]: 'gpt-9,nope' })).toEqual(['gemma']);
  });
});

describe('resolveEmbedSidecarConcurrency', () => {
  it('accepts a positive integer environment window and floors fractional values', () => {
    expect(resolveEmbedSidecarConcurrency({ [EMBED_SIDECAR_CONCURRENCY_ENV]: '6' })).toBe(6);
    expect(resolveEmbedSidecarConcurrency({ [EMBED_SIDECAR_CONCURRENCY_ENV]: '2.9' })).toBe(2);
  });

  it('ignores blank, non-finite, and non-positive environment values', () => {
    for (const value of ['', '  ', 'nope', '0', '-1', 'Infinity']) {
      expect(resolveEmbedSidecarConcurrency({ [EMBED_SIDECAR_CONCURRENCY_ENV]: value })).toBeUndefined();
    }
  });
});

describe('validateEmbedRequest', () => {
  it('accepts a minimal valid request and defaults model to gemma', () => {
    const v = validateEmbedRequest({ kind: 'query', texts: ['hi'] });
    expect(v).toEqual({ model: 'gemma', kind: 'query', texts: ['hi'], bypassCache: false });
  });

  it('accepts bypassCache and rejects a non-boolean one (EI-19323982006772080)', () => {
    expect(validateEmbedRequest({ kind: 'query', texts: ['hi'], bypassCache: true })).toEqual({
      model: 'gemma',
      kind: 'query',
      texts: ['hi'],
      bypassCache: true,
    });
    // '1' / 'false' are the shapes a shell probe sends by accident; silently
    // coercing them would leave a bench believing it bypassed a cache it did not.
    expect(validateEmbedRequest({ kind: 'query', texts: ['hi'], bypassCache: '1' })).toHaveProperty('error');
    expect(validateEmbedRequest({ kind: 'query', texts: ['hi'], bypassCache: 'false' })).toHaveProperty('error');
  });

  it('rejects unknown models, bad kinds, and bad texts', () => {
    expect(validateEmbedRequest(null)).toHaveProperty('error');
    expect(validateEmbedRequest({ model: 'gpt-9', kind: 'query', texts: ['x'] })).toHaveProperty('error');
    expect(validateEmbedRequest({ kind: 'symmetric', texts: ['x'] })).toHaveProperty('error');
    expect(validateEmbedRequest({ kind: 'query', texts: [] })).toHaveProperty('error');
    expect(validateEmbedRequest({ kind: 'query', texts: [42] })).toHaveProperty('error');
    expect(validateEmbedRequest({ kind: 'query', texts: Array(MAX_TEXTS_PER_CALL + 1).fill('x') })).toHaveProperty(
      'error',
    );
  });
});

describe('embed sidecar HTTP surface (fake builders, ephemeral port)', () => {
  let handle: EmbedSidecarHandle | null = null;
  let baseUrl = '';
  const builds: string[] = [];

  const fakeBuilders: EmbedderBuilders = {
    gemma: async (kind) => {
      builds.push(`gemma:${kind}`);
      return async (text: string) => [text.length, kind === 'query' ? 1 : 2];
    },
    local: async (kind) => {
      builds.push(`local:${kind}`);
      return async (text: string) => [text.length, 3];
    },
    harrier: async (kind) => {
      builds.push(`harrier:${kind}`);
      return async (text: string) => [text.length, kind === 'query' ? 4 : 5];
    },
  };

  async function boot(): Promise<void> {
    handle = createEmbedSidecarServer({
      port: 0,
      builders: fakeBuilders,
      warmAtBoot: false,
      log: () => {},
      concurrency: 1,
      // No PG here: the device-reload route (probed by the anti-drift test
      // below) must not reach for the real Settings row.
      embedDevice: { load: async () => ({ setting: null, changed: false, readError: null }) },
    });
    const port = await handle.listening;
    baseUrl = `http://127.0.0.1:${port}`;
  }

  afterEach(async () => {
    await handle?.close();
    handle = null;
    builds.length = 0;
  });

  it('serves explicitly registered candidate builders with their revision and model accounting', async () => {
    handle = createEmbedSidecarServer({
      port: 0, warmAtBoot: false, concurrency: 1, log: () => {},
      builders: { mdenseon: async (kind) => async (text) => [text.length, kind === 'query' ? 1 : 2] },
      modelRevisions: { mdenseon: 'pinned-candidate-sha' },
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;
    const health = await (await fetch(`${baseUrl}/healthz`)).json();
    expect(health.modelRevisions).toEqual({ mdenseon: 'pinned-candidate-sha' });
    const request = () => fetch(`${baseUrl}/embed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mdenseon', kind: 'query', texts: ['same', 'same'], bypassCache: true }),
    });
    for (let i = 0; i < 2; i++) {
      const response = await request();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        modelRev: 'pinned-candidate-sha', vectors: [[4, 1], [4, 1]],
        cache: { hits: 0, coalesced: 0, inferred: 2 },
      });
    }
    const unsupported = await fetch(`${baseUrl}/embed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemma', kind: 'query', texts: ['x'] }),
    });
    expect(unsupported.status).toBe(400);
  });

  it('refuses candidate builders without revision evidence before opening a server', () => {
    expect(() => createEmbedSidecarServer({
      builders: { mdenseon: async () => async () => [1] }, warmAtBoot: false,
    })).toThrow('explicit model revision');
    expect(validateEmbedRequest({ model: 'mdenseon', kind: 'query', texts: ['x'] })).toHaveProperty('error');
  });

  it('GET /healthz answers with warm states and the runtime tag', async () => {
    await boot();
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; runtime: string; models: Record<string, string> };
    expect(body.ok).toBe(true);
    expect(body.runtime).toBe(EMBED_SIDECAR_RUNTIME);
    expect(body.models).toEqual({}); // warmAtBoot:false + no embeds yet ⇒ all cold
  });

  it('GET /healthz reports the ACTIVE rerank (device, dtype) pair, and it is always coherent (P-009 D-006)', async () => {
    await boot();
    const body = (await (await fetch(`${baseUrl}/healthz`)).json()) as {
      rerankExecution: { device: string; dtype: string };
    };
    // The pair is what makes this reportable at all: a GPU host whose provider
    // failed to load is demoted to cpu/q8, and search cannot tell you that
    // happened (the engine is fail-safe by design), so /healthz must.
    expect(body.rerankExecution).toBeDefined();
    expect(isCoherentTarget(body.rerankExecution)).toBe(true);
    // Default host, no PAPERCUSP_RERANK_DEVICE ⇒ the CPU pair, both halves.
    expect(body.rerankExecution).toMatchObject({ device: 'cpu', dtype: 'q8' });
  });

  it('GET /healthz reports the EMBED execution target, so latency triage has a device to look at', async () => {
    // The detector half of the embed-latency investigation. Reranking has had
    // this since D-006; the embedders had nothing, so fourteen work-items filed
    // between 2026-08-27 and 2026-09-06 all searched the request path (queue
    // depth, scheduler contention, the query-embed cache) for a cause that lived
    // in the execution target. A 14-probe discriminant refuted all three — the
    // three worst latencies dispatched at queue depth 0, a saturated sample came
    // back in 1543ms — and settling it required reading /proc/<pid>/maps of the
    // live sidecar. This block is what makes the next such question a GET.
    await boot();
    const body = (await (await fetch(`${baseUrl}/healthz`)).json()) as {
      embedExecution: { device: string; dtype: string | null; verified: boolean; why: string };
      embedExecutionHealth: {
        requested: { device: string; dtype: string | null; preference: string; why: string };
        pipelines: Record<string, string>;
        demotion: unknown;
        gpuProviderAvailable: boolean | null;
        providerLibraries: string[] | null;
        defaultBundledBackends: { name: string; bundled: boolean }[] | null;
        probe: string;
        probeError: string | null;
        sessionOptions: { intraOpNumThreads: number; interOpNumThreads: number };
      };
    };

    expect(body.embedExecution).toBeDefined();
    // Since 2026-09-24 the device is CHOSEN (PAPERCUSP_EMBED_DEVICE auto|gpu|cpu,
    // plan memory-reduction-2026-09-24 D-003), so it depends on the host: cpu,
    // cuda, or `mixed` once models constructed on different devices.
    expect(['cpu', 'cuda', 'mixed']).toContain(body.embedExecution.device);
    // `verified` separates what constructed from what will merely be TRIED.
    expect(typeof body.embedExecution.verified).toBe('boolean');
    // `why` carries the basis for the device. A bare pair with no provenance is
    // what let the CPU fact stay invisible while /healthz looked complete.
    expect(body.embedExecution.why).toBeTruthy();

    const health = body.embedExecutionHealth;
    expect(health).toBeDefined();
    // What is requested and why; dtype is ALWAYS null — only the device may move,
    // or new vectors drift away from the stored corpus.
    expect(['cpu', 'cuda']).toContain(health.requested.device);
    expect(health.requested.dtype).toBeNull();
    expect(['auto', 'cuda', 'cpu']).toContain(health.requested.preference);
    expect(health.requested.why).toBeTruthy();
    expect(typeof health.pipelines).toBe('object');
    // An unresolved probe must serialize as null, not false — over the wire is
    // exactly where a fabricated `false` would be read as a measurement.
    expect(['pending', 'ok', 'failed']).toContain(health.probe);
    if (health.probe === 'ok') {
      expect(Array.isArray(health.defaultBundledBackends)).toBe(true);
      // Availability comes from the provider libraries ON DISK. Measured
      // 2026-09-07: listSupportedBackends() reports cuda:{bundled:false} even in
      // a tree where libonnxruntime_providers_cuda.so is installed and CUDA
      // sessions construct, so `bundled` is packaging metadata and must never be
      // serialized as capability.
      if (health.providerLibraries !== null) {
        expect(typeof health.gpuProviderAvailable).toBe('boolean');
      } else {
        expect(health.gpuProviderAvailable).toBeNull();
      }
    } else {
      expect(health.gpuProviderAvailable).toBeNull();
      expect(health.providerLibraries).toBeNull();
      expect(health.defaultBundledBackends).toBeNull();
    }
    // The CPU thread caps govern forward-pass latency directly, so they belong
    // in the same report as the device that makes them load-bearing.
    expect(health.sessionOptions.intraOpNumThreads).toBeGreaterThanOrEqual(1);
    expect(health.sessionOptions.interOpNumThreads).toBeGreaterThanOrEqual(1);
  });

  // WI-37696. Both worker modules fall back to INLINE main-thread work when their
  // thread is unavailable, and each has a `disabled` latch that is permanent once
  // tripped. Because the fallback returns identical values, tripping it produces no
  // error, no log and no exit code — the sidecar keeps answering 200 while the one
  // thing it exists for (a warm model OFF the request thread) is silently gone. This
  // is the only place that state is observable, so a missing `workers` block is a
  // real regression, not a cosmetic one.
  it('GET /healthz reports the embedder + reranker worker breakers (the only runtime signal a tripped latch has)', async () => {
    await boot();
    const body = (await (await fetch(`${baseUrl}/healthz`)).json()) as {
      workers: { embedder: Record<string, unknown>; reranker: Record<string, unknown> };
    };

    // Both halves must be present. Reporting one and not the other is the silent
    // half of the defect: whichever is missing can latch off unnoticed.
    for (const state of [body.workers.embedder, body.workers.reranker]) {
      expect(state).toMatchObject({
        alive: expect.any(Boolean),
        // The field to alert on — cold-but-healthy must read `false`, never absent,
        // so a monitor can tell "not tripped" from "not reported".
        disabled: false,
        pendingCount: expect.any(Number),
        keepAlive: expect.any(Boolean),
      });
    }
  });

  // The mis-mapping guard. Both real getters return the SAME SHAPE and both read
  // cold under fake builders, so `reranker: getEmbedderWorkerState()` — an easy
  // copy-paste — passes every assertion written against the real ones (measured:
  // that mutant survived this suite before the `workerStates` seam existed).
  // Injecting distinguishable readings is the only thing that separates them.
  //
  // It also pins the half that actually matters operationally: a TRIPPED latch
  // has to reach the wire. `disabled: true` here is a permanently degraded
  // sidecar — inline forward passes blocking the request loop — on a process
  // that still answers 200, so if this value did not propagate there would be
  // no signal anywhere.
  it('maps each worker breaker to its OWN module, and propagates a tripped latch to the wire', async () => {
    handle = createEmbedSidecarServer({
      port: 0,
      builders: fakeBuilders,
      warmAtBoot: false,
      log: () => {},
      concurrency: 1,
      workerStates: {
        embedder: () => ({ alive: true, disabled: false, pendingCount: 11, keepAlive: true }),
        reranker: () => ({ alive: false, disabled: true, pendingCount: 22, keepAlive: false }),
      },
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;

    const body = (await (await fetch(`${baseUrl}/healthz`)).json()) as {
      workers: { embedder: Record<string, unknown>; reranker: Record<string, unknown> };
    };

    expect(body.workers.embedder).toEqual({
      alive: true,
      disabled: false,
      pendingCount: 11,
      keepAlive: true,
    });
    expect(body.workers.reranker).toEqual({
      alive: false,
      disabled: true,
      pendingCount: 22,
      keepAlive: false,
    });
  });

  // ...and the companion the test above CANNOT provide. Injecting readers proves
  // the mapping given readers, so it is blind to a DEFAULT pointed at the wrong
  // module — which is the production path. Pinning each default by identity is
  // what closes that: measured, `reranker: getEmbedderWorkerState` survived the
  // injected-reader test and fails here.
  it('wires each DEFAULT reader to its own package (the production path the injected test cannot see)', () => {
    expect(defaultWorkerStates.embedder).toBe(getMemoryWorkerState);
    expect(defaultWorkerStates.reranker).toBe(getRerankWorkerState);
  });

  // WI-10005944: /healthz reports the code this process BOOTED, so serving-runtimes
  // stops inferring it from start time. That inference is false when bundle-host.sh's
  // rebuild failed and the unit booted the last-known-good bundle (WI-10005936 class).
  const healthzWithIdentity = async (identity: { sha: string | null; bundleStale: BundleStaleness | null }) => {
    handle = createEmbedSidecarServer({
      port: 0,
      builders: fakeBuilders,
      warmAtBoot: false,
      log: () => {},
      concurrency: 1,
      buildIdentity: () => identity,
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;
    return (await (await fetch(`${baseUrl}/healthz`)).json()) as Record<string, unknown>;
  };

  it('GET /healthz reports the booted bundle sha and bundleStale when the fallback bundle booted', async () => {
    const stale = {
      schema: 'bundle-stale-v1',
      outfile: 'dist-sidecar/embed-sidecar.mjs',
      servingBundleMtime: '2026-10-03T08:06:00.000Z',
    } as unknown as BundleStaleness;
    const body = await healthzWithIdentity({ sha: 'abc1234', bundleStale: stale });
    expect(body.sha).toBe('abc1234');
    expect(body.bundleStale).toEqual(stale);
  });

  it('GET /healthz omits bundleStale on a healthy build and reports a null sha honestly', async () => {
    const body = await healthzWithIdentity({ sha: null, bundleStale: null });
    expect(body).toHaveProperty('sha', null);
    expect(body).not.toHaveProperty('bundleStale');
  });

  it('wires the DEFAULT build identity to build-info + bundle-staleness (the production path)', () => {
    expect(defaultBuildIdentity()).toEqual({ sha: getBuildInfo().sha, bundleStale: getBundleStaleness() });
  });

  // EI-21341585960652821. The guard for an outage class this endpoint was
  // STRUCTURALLY unable to report. On 2026-08-24 the sidecar sat 100% slot-
  // saturated for hours — novel query embeds queueing ~11.4s median (max 67.8s)
  // against 1200ms/4000ms caller budgets, i.e. semantic retrieval dead fleet-
  // wide — while /healthz answered 200 in 0.6ms with every model `warm`. Five
  // separate work-items were filed for that single cause because no surface
  // could see the shared queue.
  //
  // `workers.embedder.pendingCount` looked like the backlog signal but is
  // `_pending.size` (units already handed to the worker), so it is capped at
  // `concurrency` and CANNOT EXCEED it — pinned at the cap, a 2-deep backlog and
  // a 2000-deep one are the same reading. This test therefore asserts the thing
  // that gauge could never say: a backlog LARGER than the concurrency limit.
  it('GET /healthz reports the FIFO backlog — the state `pendingCount` structurally cannot express', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started = 0;
    const gatedBuilders: EmbedderBuilders = {
      ...fakeBuilders,
      gemma: async (kind) => async (text: string) => {
        started++;
        await gate;
        return [text.length, kind === 'query' ? 1 : 2];
      },
    };
    handle = createEmbedSidecarServer({
      port: 0,
      builders: gatedBuilders,
      warmAtBoot: false,
      log: () => {},
      concurrency: 1,
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;

    // THREE DISTINCT texts: per-text coalescing would collapse identical ones
    // into a single unit and there would be no queue to observe. With
    // concurrency 1 this is 1 in flight and 2 genuinely waiting.
    const inFlight = ['alpha', 'bravo', 'charlie'].map((t) =>
      fetch(`${baseUrl}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'query', texts: [t] }),
      }),
    );
    while (started < 1) await new Promise((r) => setTimeout(r, 5));

    type Health = {
      concurrency: number;
      queue: { depth: number; active: number; saturated: boolean };
    };
    // Poll rather than sampling once: the three requests race to arrive, so a
    // single read can legitimately catch only the first two.
    let body!: Health;
    const deadline = Date.now() + 2000;
    for (;;) {
      body = (await (await fetch(`${baseUrl}/healthz`)).json()) as Health;
      if (body.queue.depth >= 2 || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 5));
    }

    // depth 2 > concurrency 1 — a value the old gauge could not have produced.
    expect(body.queue.depth).toBe(2);
    expect(body.queue.active).toBe(body.concurrency);
    expect(body.queue.saturated).toBe(true);

    // FALSIFIABILITY CONTROL, kept permanently rather than proven once by a
    // mutation probe. A guard that has never failed is a guard nobody has
    // tested, and the failure mode being guarded here is subtle: a depth field
    // that silently saturates at `concurrency` looks correct in every reading
    // below the cap, which is exactly how the original gauge passed for months.
    //
    // So model that wrong implementation explicitly and assert the observed
    // value DISTINGUISHES itself from it. If someone reintroduces a cap, the
    // control collapses onto the real value and this fails — on every run, in
    // the tree, with no mutation of the shared checkout.
    const cappedGaugeWouldReport = Math.min(body.queue.depth, body.concurrency);
    expect(cappedGaugeWouldReport).not.toBe(body.queue.depth);

    release();
    await Promise.all(inFlight);
  });

  it('GET /healthz ADVERTISES every route it serves (EI-19314150478401738)', async () => {
    await boot();
    const body = (await (await fetch(`${baseUrl}/healthz`)).json()) as { capabilities: string[] };
    // A sidecar outlives the code that talks to it, so it must be able to say
    // what it can do — otherwise a route added after the running bundle was
    // built 404s forever and every caller's fail-safe swallows it.
    expect(body.capabilities).toEqual(
      expect.arrayContaining([
        EMBED_SIDECAR_CAP_HEALTHZ,
        EMBED_SIDECAR_CAP_EMBED,
        EMBED_SIDECAR_CAP_RERANK,
        EMBED_SIDECAR_CAP_DEVICE_RELOAD,
      ]),
    );
  });

  it('the advertised capabilities are exactly the DISPATCHABLE routes — they cannot drift', async () => {
    await boot();
    const body = (await (await fetch(`${baseUrl}/healthz`)).json()) as { capabilities: string[] };
    // Every advertised route must actually dispatch (i.e. not 404). This is
    // the anti-drift assertion: advertisement is derived from the route table,
    // so adding a route without advertising it is impossible, and this proves
    // the converse — nothing is advertised that isn't served.
    for (const cap of body.capabilities) {
      const [method, path] = cap.split(' ');
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        ...(method === 'POST'
          ? { headers: { 'Content-Type': 'application/json' }, body: '{}' }
          : {}),
      });
      // 400 (bad body) is fine — it proves the route EXISTS. 404 would mean
      // the sidecar advertised something it cannot serve.
      expect(res.status, `advertised ${cap} must dispatch`).not.toBe(404);
    }
  });

  it('production admits each embed/rerank unit through the durable governor with attributable demand', async () => {
    const admissions: Array<GovernedOperationInput<unknown>> = [];
    const governedOperation = async <T>(
      input: GovernedOperationInput<T>,
      run: (context: AdmissionContext) => Promise<T>,
    ): Promise<T> => {
      admissions.push(input as GovernedOperationInput<unknown>);
      return run({
        contractVersion: 1,
        requestId: `test-${admissions.length}`,
        rootRequestId: `test-${admissions.length}`,
        parentRequestId: null,
        idempotencyKey: `test-key-${admissions.length}`,
        admissionClass: input.admissionClass,
        priority: 0,
        demand: input.demand ?? {},
        depth: 0,
        createdAtMs: 0,
        decisionGeneration: 1,
      });
    };
    handle = createEmbedSidecarServer({
      port: 0,
      builders: fakeBuilders,
      rerankBuilders: {
        rerank: async () => async (_query, texts) => texts.map((text) => text.length),
        'rerank-fast': async () => async (_query, texts) => texts.map((text) => text.length),
      },
      warmAtBoot: false,
      log: () => {},
      workspaceId: 'governor-test-workspace',
      governedOperation,
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;

    const post = (path: string, body: unknown) =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post('/embed', { kind: 'query', texts: ['a', 'bb'] })).status).toBe(200);
    expect((await post('/rerank', { query: 'q', texts: ['x', 'yy'] })).status).toBe(200);

    expect(admissions).toHaveLength(4);
    for (const input of admissions.slice(0, 2)) {
      expect(input).toMatchObject({
        workspaceId: 'governor-test-workspace',
        namespace: 'embed-sidecar',
        admissionClass: 'embedding',
        metadata: { operation: 'embed', kind: 'query', unit: 'single-text' },
        demand: { cpuWeight: 1 },
      });
    }
    for (const input of admissions.slice(2)) {
      expect(input).toMatchObject({
        workspaceId: 'governor-test-workspace',
        namespace: 'embed-sidecar',
        admissionClass: 'inference',
        metadata: { operation: 'rerank', unit: 'single-text' },
        demand: { cpuWeight: 1 },
      });
    }
    expect(admissions[0]?.demand?.memoryBytes).toBe(1);
    expect(admissions[1]?.demand?.memoryBytes).toBe(2);
    expect(admissions[2]?.demand?.memoryBytes).toBe(2);
    expect(admissions[3]?.demand?.memoryBytes).toBe(3);
    expect(admissions.map((input) => input.priority)).toEqual([
      EMBED_SIDECAR_INTERACTIVE_PRIORITY,
      EMBED_SIDECAR_INTERACTIVE_PRIORITY,
      EMBED_SIDECAR_INTERACTIVE_PRIORITY,
      EMBED_SIDECAR_INTERACTIVE_PRIORITY,
    ]);
  });

  it('assigns background priority to document embeds', async () => {
    const admissions: Array<GovernedOperationInput<unknown>> = [];
    const governedOperation = async <T>(
      input: GovernedOperationInput<T>,
      run: (context: AdmissionContext) => Promise<T>,
    ): Promise<T> => {
      admissions.push(input as GovernedOperationInput<unknown>);
      return run({
        contractVersion: 1,
        requestId: 'priority-test',
        rootRequestId: 'priority-test',
        parentRequestId: null,
        idempotencyKey: 'priority-test',
        admissionClass: input.admissionClass,
        priority: input.priority ?? 0,
        demand: input.demand ?? {},
        depth: 0,
        createdAtMs: 0,
        decisionGeneration: 1,
      });
    };
    handle = createEmbedSidecarServer({
      port: 0,
      builders: fakeBuilders,
      warmAtBoot: false,
      log: () => {},
      workspaceId: 'priority-test-workspace',
      governedOperation,
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;
    const response = await fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'document', texts: ['doc'] }),
    });
    expect(response.status).toBe(200);
    expect(admissions).toHaveLength(1);
    expect(admissions[0]?.priority).toBe(EMBED_SIDECAR_BACKGROUND_PRIORITY);
  });

  it('propagates a client abort to the durable governor for abandoned started work', async () => {
    let governedSignal: AbortSignal | undefined;
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const governedOperation = async <T>(
      input: GovernedOperationInput<T>,
      run: (context: AdmissionContext) => Promise<T>,
    ): Promise<T> => {
      governedSignal = input.signal;
      return run({
        contractVersion: 1,
        requestId: 'abort-test',
        rootRequestId: 'abort-test',
        parentRequestId: null,
        idempotencyKey: 'abort-test',
        admissionClass: input.admissionClass,
        priority: 0,
        demand: input.demand ?? {},
        depth: 0,
        createdAtMs: 0,
        decisionGeneration: 1,
      });
    };
    handle = createEmbedSidecarServer({
      port: 0,
      builders: {
        ...fakeBuilders,
        gemma: async () => async (text: string) => {
          started = true;
          await gate;
          return [text.length, 1];
        },
      },
      warmAtBoot: false,
      log: () => {},
      workspaceId: 'abort-test-workspace',
      governedOperation,
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;

    const controller = new AbortController();
    const request = fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'query', texts: ['abandoned'] }),
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(started).toBe(true);
      expect(governedSignal).toBeInstanceOf(AbortSignal);
    });

    controller.abort(new Error('client closed'));
    await expect(request).rejects.toThrow();
    await vi.waitFor(() => expect(governedSignal?.aborted).toBe(true));

    // The operation itself may not support cancellation; releasing it proves
    // the server still drains its started unit without resurrecting the
    // abandoned request or losing the abort signal.
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(governedSignal?.aborted).toBe(true);
  });

  it('does not abort coalesced work until every client leaves', async () => {
    let governedSignal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const governedOperation = async <T>(
      input: GovernedOperationInput<T>,
      run: (context: AdmissionContext) => Promise<T>,
    ): Promise<T> => {
      governedSignal = input.signal;
      return run({
        contractVersion: 1,
        requestId: 'coalesced-abort-test',
        rootRequestId: 'coalesced-abort-test',
        parentRequestId: null,
        idempotencyKey: 'coalesced-abort-test',
        admissionClass: input.admissionClass,
        priority: 0,
        demand: input.demand ?? {},
        depth: 0,
        createdAtMs: 0,
        decisionGeneration: 1,
      });
    };
    handle = createEmbedSidecarServer({
      port: 0,
      builders: {
        ...fakeBuilders,
        gemma: async () => async (text: string) => {
          await gate;
          return [text.length, 1];
        },
      },
      warmAtBoot: false,
      log: () => {},
      workspaceId: 'coalesced-abort-test-workspace',
      governedOperation,
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;

    const firstController = new AbortController();
    const secondController = new AbortController();
    const request = (controller: AbortController) =>
      fetch(`${baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'query', texts: ['shared-abortable'] }),
        signal: controller.signal,
      });
    const first = request(firstController);
    await vi.waitFor(() => expect(governedSignal).toBeInstanceOf(AbortSignal));
    const second = request(secondController);
    await new Promise((resolve) => setTimeout(resolve, 10));

    firstController.abort(new Error('first client closed'));
    await expect(first).rejects.toThrow();
    expect(governedSignal?.aborted).toBe(false);

    secondController.abort(new Error('second client closed'));
    await expect(second).rejects.toThrow();
    await vi.waitFor(() => expect(governedSignal?.aborted).toBe(true));
    release();
  });

  it('POST /embed returns the D-004 shape, ordered per input text', async () => {
    await boot();
    const res = await fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemma', kind: 'query', texts: ['a', 'abc'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vectors: number[][]; dims: number; runtime: string; modelRev: string };
    expect(body.vectors).toEqual([
      [1, 1],
      [3, 1],
    ]);
    expect(body.dims).toBe(2);
    expect(body.runtime).toBe(EMBED_SIDECAR_RUNTIME);
    expect(body.modelRev).toContain('embeddinggemma');
  });

  it('memoizes one embedder per model:kind and reports it warm', async () => {
    await boot();
    const call = (kind: string) =>
      fetch(`${baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gemma', kind, texts: ['x'] }),
      });
    await call('query');
    await call('query');
    await call('document');
    expect(builds).toEqual(['gemma:query', 'gemma:document']);
    expect(handle!.warmStates()).toEqual({ 'gemma:query': 'warm', 'gemma:document': 'warm' });
  });

  it('400s invalid requests and 404s unknown routes', async () => {
    await boot();
    const bad = await fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nope', kind: 'query', texts: ['x'] }),
    });
    expect(bad.status).toBe(400);
    const notJson = await fetch(`${baseUrl}/embed`, { method: 'POST', body: '{{' });
    expect(notJson.status).toBe(400);
    const missing = await fetch(`${baseUrl}/nope`);
    expect(missing.status).toBe(404);
  });

  it('500s an embed failure without killing the server', async () => {
    handle = createEmbedSidecarServer({
      port: 0,
      warmAtBoot: false,
      log: () => {},
      concurrency: 1,
      builders: {
        gemma: async () => async () => {
          throw new Error('worker exploded');
        },
        local: fakeBuilders.local,
        harrier: fakeBuilders.harrier,
      },
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;
    const res = await fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'query', texts: ['x'] }),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/embed_failed/);
    // Server survives — a healthy model still answers.
    const ok = await fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'local', kind: 'document', texts: ['ab'] }),
    });
    expect(ok.status).toBe(200);
  });

  it('coalesces CONCURRENT identical texts into one inference (WI-4196)', async () => {
    // The mem0 per-scope fan-out case: N parallel requests, same query text.
    let embedCalls = 0;
    handle = createEmbedSidecarServer({
      port: 0,
      warmAtBoot: false,
      log: () => {},
      concurrency: 1,
      builders: {
        gemma: async () => async (text: string) => {
          embedCalls++;
          await new Promise((r) => setTimeout(r, 20)); // hold so the peers arrive mid-flight
          return [text.length, embedCalls];
        },
        local: fakeBuilders.local,
        harrier: fakeBuilders.harrier,
      },
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;
    const post = () =>
      fetch(`${baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'query', texts: ['same query'] }),
      }).then((r) => r.json() as Promise<{ vectors: number[][] }>);
    const [a, b, c] = await Promise.all([post(), post(), post()]);
    expect(embedCalls).toBe(1);
    expect(a.vectors).toEqual([[10, 1]]);
    expect(b.vectors).toEqual(a.vectors);
    expect(c.vectors).toEqual(a.vectors);
  });

  it('normalizes exact-query identity across casing and whitespace variants', async () => {
    let embedCalls = 0;
    handle = createEmbedSidecarServer({
      port: 0,
      warmAtBoot: false,
      log: () => {},
      concurrency: 1,
      builders: {
        gemma: async () => async (text: string) => {
          embedCalls++;
          return [text.length];
        },
        local: fakeBuilders.local,
        harrier: fakeBuilders.harrier,
      },
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;
    const post = (text: string) =>
      fetch(`${baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'query', texts: [text] }),
      });
    expect((await (await post('  Same\tQuery ')).json()).vectors).toEqual([[13]]);
    expect((await (await post('same query')).json()).vectors).toEqual([[13]]);
    expect(embedCalls).toBe(1);
  });

  it('serves repeats from the LRU, keys per model:kind, and reports cache stats', async () => {
    let embedCalls = 0;
    handle = createEmbedSidecarServer({
      port: 0,
      warmAtBoot: false,
      log: () => {},
      builders: {
        gemma: async (kind) => async (text: string) => {
          embedCalls++;
          return [text.length, kind === 'query' ? 1 : 2];
        },
        local: fakeBuilders.local,
        harrier: fakeBuilders.harrier,
      },
      concurrency: 1,
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;
    const post = (kind: string) =>
      fetch(`${baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, texts: ['x'] }),
      });
    await post('query');
    await post('query'); // cache hit
    expect(embedCalls).toBe(1);
    await post('document'); // same text, different kind ⇒ its own inference
    expect(embedCalls).toBe(2);
    const health = (await (await fetch(`${baseUrl}/healthz`)).json()) as {
      cache: { hits: number; misses: number; size: number };
    };
    expect(health.cache).toEqual({ hits: 1, misses: 2, size: 2 });
  });

  it('evicts least-recently-used beyond cacheMax; cacheMax:0 disables caching', async () => {
    let embedCalls = 0;
    const boot1 = async (cacheMax: number) => {
      embedCalls = 0;
      handle = createEmbedSidecarServer({
        port: 0,
        warmAtBoot: false,
        log: () => {},
        cacheMax,
        concurrency: 1,
        builders: {
          gemma: async () => async (text: string) => {
            embedCalls++;
            return [text.length];
          },
          local: fakeBuilders.local,
          harrier: fakeBuilders.harrier,
        },
      });
      baseUrl = `http://127.0.0.1:${await handle.listening}`;
    };
    const post = (text: string) =>
      fetch(`${baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'query', texts: [text] }),
      });
    await boot1(1);
    await post('a');
    await post('b'); // evicts 'a'
    await post('a'); // re-infers
    expect(embedCalls).toBe(3);
    await handle!.close();
    await boot1(0);
    await post('a');
    await post('a'); // caching disabled ⇒ re-infers
    expect(embedCalls).toBe(2);
  });

  // EI-19323982006772080 — the sidecar answered a repeated-text throughput
  // probe from its LRU and said nothing about it: 1ms/doc cached vs 353ms/doc
  // uncached, a ~350x error in the OPTIMISTIC direction. These tests pin the
  // per-request accounting that makes the difference reportable, and — more
  // importantly — pin the VERDICT function, so a later change that keeps the
  // counters but stops refusing an unmeasured response trips a named test.
  describe('per-request cache accounting (EI-19323982006772080)', () => {
    let embedCalls = 0;
    const bootCounting = async (): Promise<void> => {
      embedCalls = 0;
      handle = createEmbedSidecarServer({
        port: 0,
        warmAtBoot: false,
        log: () => {},
        concurrency: 1,
        builders: {
          gemma: async () => async (text: string) => {
            embedCalls++;
            return [text.length];
          },
          local: fakeBuilders.local,
          harrier: fakeBuilders.harrier,
        },
      });
      baseUrl = `http://127.0.0.1:${await handle.listening}`;
    };
    const embed = async (
      texts: string[],
      bypassCache?: boolean,
    ): Promise<{ cache: { hits: number; coalesced: number; inferred: number } }> => {
      const res = await fetch(`${baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'query', texts, ...(bypassCache === undefined ? {} : { bypassCache }) }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { cache: { hits: number; coalesced: number; inferred: number } };
    };

    it('REFUSES a repeated-text probe and ACCEPTS the same probe on unique texts', async () => {
      await bootCounting();
      const cold = await embed(['alpha', 'beta']);
      expect(cold.cache).toEqual({ hits: 0, coalesced: 0, inferred: 2 });
      expect(embedResponseMeasuredModel(cold, 2)).toEqual({ ok: true });

      // The bug, reproduced: identical texts, identical request, a response
      // that used to be indistinguishable from the one above.
      const warm = await embed(['alpha', 'beta']);
      expect(warm.cache).toEqual({ hits: 2, coalesced: 0, inferred: 0 });
      expect(embedCalls).toBe(2); // nothing re-inferred — the LRU served it
      const verdict = embedResponseMeasuredModel(warm, 2);
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.reason).toMatch(/0 of 2 texts reached the model/);
    });

    it('counts a coalesced duplicate SEPARATELY from an LRU hit', async () => {
      await bootCounting();
      // Four copies of one text in ONE request: the first registers the
      // in-flight unit, the other three join it. Nothing was cached — reporting
      // these as `hits` would answer "the cache served you" for a request that
      // never touched the cache.
      const body = await embed(['dup', 'dup', 'dup', 'dup']);
      expect(body.cache).toEqual({ hits: 0, coalesced: 3, inferred: 1 });
      expect(embedCalls).toBe(1);
      const verdict = embedResponseMeasuredModel(body, 4);
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.reason).toMatch(/coalesced/);
    });

    it('bypassCache:true reaches the model for every text, without reading or writing the LRU', async () => {
      await bootCounting();
      await embed(['a']); // warm the LRU
      expect((await embed(['a'])).cache.hits).toBe(1); // ordinary repeat: cached

      const bypassed = await embed(['a', 'a'], true);
      // Not served from the LRU, and the in-request duplicate did NOT coalesce
      // — a bypass that coalesced would serve N texts from one forward pass,
      // the same optimistic reading one layer down.
      expect(bypassed.cache).toEqual({ hits: 0, coalesced: 0, inferred: 2 });
      expect(embedResponseMeasuredModel(bypassed, 2)).toEqual({ ok: true });
      expect(embedCalls).toBe(3); // 1 warm + 2 bypassed

      // ...and it left the cache the caller asked it not to touch alone.
      expect((await embed(['a'])).cache.hits).toBe(1);
      expect(embedCalls).toBe(3);
    });

    it('treats a response with NO cache accounting as undecidable, never as a pass', () => {
      // Rig hosts run INSTALLED sidecar bundles with no update path
      // (EI-19330215508907244), so a probe CAN meet a sidecar that predates
      // this field. That must not read as good news.
      const legacy = { vectors: [[1]], dims: 1, runtime: 'node-onnx-worker', modelRev: 'r1' };
      const verdict = embedResponseMeasuredModel(legacy, 1);
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.reason).toMatch(/predates EI-19323982006772080/);

      // CONTROL — the two hand-written checks a caller reaches for instead of
      // the helper. Both are DELIBERATELY WRONG and kept here permanently: they
      // are what "assert the cache was cold" looks like when written by hand,
      // and both report a clean pass on a body that never carried the field.
      // Keeping them beside the real subject is what proves the assertion below
      // can fail — if someone "fixes" embedResponseMeasuredModel by defaulting a
      // missing `cache` to zeroes, the real subject collapses onto these
      // controls and this test goes red instead of going quietly optimistic.
      const hitsOf = (body: Record<string, unknown>): number | undefined =>
        (body as { cache?: { hits?: number } }).cache?.hits;
      const naiveTruthiness = (body: Record<string, unknown>): boolean => !hitsOf(body);
      const naiveEquality = (body: Record<string, unknown>): boolean => hitsOf(body) === 0;
      expect(naiveTruthiness(legacy)).toBe(true); // false green
      expect(naiveEquality(legacy)).toBe(false); // fails, but for the wrong reason
      expect(verdict.ok).not.toBe(naiveTruthiness(legacy));

      // CALIBRATION — on a body that really is fully inferred, the real subject
      // and the naive checks agree. Without this, the controls above would also
      // "pass" if the subject simply refused everything.
      const honest = { cache: { hits: 0, coalesced: 0, inferred: 1 } };
      expect(embedResponseMeasuredModel(honest, 1)).toEqual({ ok: true });
      expect(naiveTruthiness(honest)).toBe(true);
    });

    it('rejects counts that do not partition the request', () => {
      const verdict = embedResponseMeasuredModel({ cache: { hits: 1, coalesced: 0, inferred: 1 } }, 4);
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.reason).toMatch(/does not partition/);
      const malformed = embedResponseMeasuredModel({ cache: { hits: 1 } }, 1);
      expect(malformed.ok).toBe(false);
      expect(malformed.ok === false && malformed.reason).toMatch(/malformed/);
    });

    it('separates "the cache served you" from "the response cannot say" with a code, not prose (WI-1647443)', () => {
      // A caller that must REPORT what happened — the service-health probe —
      // has to distinguish a positive "the model did not run" from an
      // undecidable "this response cannot tell me". Those want opposite
      // reports, and the only thing separating them used to be the wording of
      // `reason`, which a caller can only reach by regex.
      const codeOf = (body: Record<string, unknown>, n: number): string | undefined => {
        const v = embedResponseMeasuredModel(body, n);
        return v.ok ? undefined : v.code;
      };
      expect(codeOf({ cache: { hits: 1, coalesced: 0, inferred: 0 } }, 1)).toBe('served-from-cache');
      expect(codeOf({ cache: { hits: 0, coalesced: 1, inferred: 0 } }, 1)).toBe('served-from-cache');
      expect(codeOf({ vectors: [[1]] }, 1)).toBe('no-accounting');
      expect(codeOf({ cache: { hits: 1 } }, 1)).toBe('malformed');
      expect(codeOf({ cache: { hits: 1, coalesced: 0, inferred: 1 } }, 4)).toBe('not-a-partition');
      expect(codeOf({ cache: { hits: 0, coalesced: 0, inferred: 1 } }, 1)).toBeUndefined();

      // CONTROL — the shortcut a caller reaches for instead of the code: treat
      // any not-ok verdict as "the cache served it". It is DELIBERATELY WRONG
      // and kept here permanently, because it reports the legacy no-accounting
      // body — the one case where nothing is known — as a confident statement
      // that the model was skipped, which is how an undecidable turns into a
      // fabricated finding.
      const naiveServedFromCache = (body: Record<string, unknown>, n: number): boolean =>
        !embedResponseMeasuredModel(body, n).ok;
      expect(naiveServedFromCache({ vectors: [[1]] }, 1)).toBe(true);
      expect(codeOf({ vectors: [[1]] }, 1)).not.toBe('served-from-cache');
      // CALIBRATION — on a body that really WAS served from the LRU, the real
      // subject and the shortcut agree, so the disagreement above is about the
      // undecidable case specifically and not about the subject refusing
      // everything.
      expect(naiveServedFromCache({ cache: { hits: 1, coalesced: 0, inferred: 0 } }, 1)).toBe(true);
    });
  });

  it('does not cache failures: a failed embed retries on the next request', async () => {
    let attempts = 0;
    handle = createEmbedSidecarServer({
      port: 0,
      warmAtBoot: false,
      log: () => {},
      concurrency: 1,
      builders: {
        gemma: async () => async (text: string) => {
          attempts++;
          if (attempts === 1) throw new Error('transient worker fault');
          return [text.length];
        },
        local: fakeBuilders.local,
        harrier: fakeBuilders.harrier,
      },
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;
    const post = () =>
      fetch(`${baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'query', texts: ['x'] }),
      });
    expect((await post()).status).toBe(500);
    expect((await post()).status).toBe(200); // in-flight entry cleaned up, retried
    expect(attempts).toBe(2);
  });

  it('single-flight FIFO: concurrent requests complete in arrival order', async () => {
    const finished: string[] = [];
    handle = createEmbedSidecarServer({
      port: 0,
      warmAtBoot: false,
      log: () => {},
      builders: {
        gemma: async () => async (text: string) => {
          // First request is the slowest — FIFO must still finish it first.
          await new Promise((r) => setTimeout(r, text === 'slow' ? 50 : 1));
          finished.push(text);
          return [1];
        },
        local: fakeBuilders.local,
        harrier: fakeBuilders.harrier,
      },
      concurrency: 1,
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;
    const post = (text: string) =>
      fetch(`${baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'query', texts: [text] }),
      });
    const slow = post('slow');
    // Give the slow request a head start into the queue before the fast one.
    await new Promise((r) => setTimeout(r, 10));
    const fast = post('fast');
    await Promise.all([slow, fast]);
    expect(finished).toEqual(['slow', 'fast']);
  });

});

describe('bounded concurrency (P-004 memory-public-release-hardening-2026-07-11)', () => {
  let handle: EmbedSidecarHandle | null = null;
  let baseUrl = '';

  afterEach(async () => {
    await handle?.close();
    handle = null;
  });

  /** Gated fake: every embed records its start and blocks until released. */
  const makeGated = () => {
    const started: string[] = [];
    const release = new Map<string, () => void>();
    const embed = (text: string) =>
      new Promise<number[]>((res) => {
        started.push(text);
        release.set(text, () => res([1]));
      });
    const builders: EmbedderBuilders = {
      gemma: async () => embed,
      local: async () => embed,
      harrier: async () => embed,
    };
    return { started, release, builders };
  };
  let gated: ReturnType<typeof makeGated>;

  const waitFor = async (cond: () => boolean): Promise<void> => {
    const deadline = Date.now() + 1_000;
    while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  };

  /**
   * Block until the server's own FIFO backlog holds at least `depth` WAITING
   * units (`/healthz` reports the real backlog, excluding the active unit — see
   * the queue-depth guard earlier in this file).
   *
   * A `postKind(...)` call returns a pending `fetch`; the unit is only queued
   * once the server has received and parsed that request. So a test whose
   * subject is QUEUE ORDER must wait on the queue itself — having called
   * `fetch` is not the same as the work being schedulable, and treating it as
   * such measures HTTP arrival timing instead of the scheduler.
   */
  const waitForQueueDepth = async (depth: number): Promise<void> => {
    type Health = { queue: { depth: number } };
    const deadline = Date.now() + 2_000;
    let observed = -1;
    while (Date.now() < deadline) {
      observed = ((await (await fetch(`${baseUrl}/healthz`)).json()) as Health).queue.depth;
      if (observed >= depth) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(observed).toBeGreaterThanOrEqual(depth);
  };

  const boot = async (
    concurrency?: number,
    governedOperation?: typeof runGovernedOperation,
  ): Promise<void> => {
    handle = createEmbedSidecarServer({
      port: 0,
      warmAtBoot: false,
      log: () => {},
      builders: gated.builders,
      concurrency,
      governedOperation,
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;
  };

  const post = (texts: string[]) =>
    fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'query', texts }),
    });
  const postKind = (kind: 'query' | 'document', texts: string[]) =>
    fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, texts }),
    });

  it('concurrency 2: two units run in flight, the third starts only when a slot frees', async () => {
    gated = makeGated();
    await boot(2);
    const req = post(['a', 'b', 'c']);
    await waitFor(() => gated.started.length === 2);
    expect(gated.started).toEqual(['a', 'b']); // c queued — both slots busy
    gated.release.get('a')!();
    await waitFor(() => gated.started.length === 3);
    expect(gated.started).toEqual(['a', 'b', 'c']); // freed slot starts c, arrival order
    gated.release.get('b')!();
    gated.release.get('c')!();
    expect((await req).status).toBe(200);
  });

  it('concurrency 1 (the default contract): strictly serial starts', async () => {
    gated = makeGated();
    await boot(1);
    const req = post(['a', 'b']);
    await waitFor(() => gated.started.length === 1);
    expect(gated.started).toEqual(['a']);
    gated.release.get('a')!();
    await waitFor(() => gated.started.length === 2);
    gated.release.get('b')!();
    expect((await req).status).toBe(200);
  });

  it('round-robins request batches so a later single request is not behind a giant batch', async () => {
    gated = makeGated();
    await boot(1);
    const batch = post(['batch-a', 'batch-b', 'batch-c']);
    await waitFor(() => gated.started.length === 1);

    // Wait until all three batch units are admitted before adding the later
    // request. This makes the old flat FIFO's ordering failure deterministic.
    const later = post(['interactive']);
    const deadline = Date.now() + 1_000;
    let depth = 0;
    while (depth < 3 && Date.now() < deadline) {
      const health = (await (await fetch(`${baseUrl}/healthz`)).json()) as { queue: { depth: number } };
      depth = health.queue.depth;
      if (depth < 3) await new Promise((r) => setTimeout(r, 5));
    }
    expect(depth).toBe(3);

    gated.release.get('batch-a')!();
    await waitFor(() => gated.started.length === 2);
    expect(gated.started).toEqual(['batch-a', 'interactive']);

    gated.release.get('interactive')!();
    await waitFor(() => gated.started.length === 3);
    expect(gated.started).toEqual(['batch-a', 'interactive', 'batch-b']);

    gated.release.get('batch-b')!();
    await waitFor(() => gated.started.length === 4);
    expect(gated.started).toEqual(['batch-a', 'interactive', 'batch-b', 'batch-c']);
    gated.release.get('batch-c')!();

    expect((await batch).status).toBe(200);
    expect((await later).status).toBe(200);
  });

  it('prioritizes interactive queries while bounding the burst so background recovery still runs', async () => {
    gated = makeGated();
    await boot(1);
    const background = postKind('document', ['background-active', 'background-waiting']);
    await waitFor(() => gated.started.length === 1);

    const interactive = Array.from({ length: EMBED_SIDECAR_PRIORITY_BURST_MAX + 1 }, (_, i) =>
      postKind('query', [`interactive-${i}`]),
    );
    // Priority is a property of the QUEUE, so every interactive unit has to be
    // enqueued BEFORE the only slot frees. Releasing `background-active` while
    // those POSTs are still in flight leaves `background-waiting` as the sole
    // queued unit — the scheduler then correctly starts it, and the first
    // assertion in the loop below reads `background-waiting` instead of
    // `interactive-0`. That is a race in this test, not in the scheduler: it
    // passed locally in ~5s and failed only in the loaded gate (~65s wall, p95
    // event-loop lag 199ms vs 21ms) on a byte-identical commit that had already
    // passed the same suite minutes earlier.
    //
    // Waiting on the server's own backlog (rather than a sleep) keeps that
    // deterministic under any load. Depth counts WAITING units: the queued
    // `background-waiting` plus all `BURST_MAX + 1` interactive units.
    await waitForQueueDepth(EMBED_SIDECAR_PRIORITY_BURST_MAX + 2);
    gated.release.get('background-active')!();

    for (let i = 0; i < EMBED_SIDECAR_PRIORITY_BURST_MAX; i++) {
      await waitFor(() => gated.started.length === i + 2);
      expect(gated.started.at(-1)).toBe(`interactive-${i}`);
      gated.release.get(`interactive-${i}`)!();
    }

    await waitFor(() => gated.started.length === EMBED_SIDECAR_PRIORITY_BURST_MAX + 2);
    expect(gated.started.at(-1)).toBe('background-waiting');
    gated.release.get('background-waiting')!();

    await waitFor(() => gated.started.length === EMBED_SIDECAR_PRIORITY_BURST_MAX + 3);
    expect(gated.started.at(-1)).toBe(`interactive-${EMBED_SIDECAR_PRIORITY_BURST_MAX}`);
    gated.release.get(`interactive-${EMBED_SIDECAR_PRIORITY_BURST_MAX}`)!();

    expect((await background).status).toBe(200);
    for (const response of await Promise.all(interactive)) expect(response.status).toBe(200);
  });

  it('an aborted request removes its queued work before it starts', async () => {
    gated = makeGated();
    await boot(1);
    const controller = new AbortController();
    // The request must carry the signal so the server observes the client
    // disconnect while the first unit is holding the only slot.
    const abortedReq = fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'query', texts: ['active', 'abandoned'] }),
      signal: controller.signal,
    });
    await waitFor(() => gated.started.length === 1);
    expect(gated.started).toEqual(['active']);
    controller.abort();
    await expect(abortedReq).rejects.toThrow();
    gated.release.get('active')!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gated.started).toEqual(['active']);
  });

  it('an aborted coalesced caller does not cancel work still needed by a peer', async () => {
    gated = makeGated();
    await boot(1);
    const controller = new AbortController();
    const first = fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'query', texts: ['shared'] }),
      signal: controller.signal,
    });
    await waitFor(() => gated.started.length === 1);
    const second = post(['shared']);
    controller.abort();
    await expect(first).rejects.toThrow();
    gated.release.get('shared')!();
    expect((await second).status).toBe(200);
    expect(gated.started).toEqual(['shared']);
  });

  it('a failed unit frees its slot for the next waiter', async () => {
    gated = makeGated();
    const inner = gated.builders.gemma;
    gated.builders.gemma = async (kind) => {
      const embed = await inner(kind);
      return (text: string) =>
        text === 'boom' ? Promise.reject(new Error('synthetic embed failure')) : embed(text);
    };
    await boot(1);
    const req = post(['boom', 'after']); // Promise.all rejects the request…
    await waitFor(() => gated.started.includes('after')); // …but the slot freed
    gated.release.get('after')!();
    expect((await req).status).toBe(500);
  });

  it('healthz reports the configured concurrency', async () => {
    gated = makeGated();
    await boot(3);
    const body = (await (await fetch(`${baseUrl}/healthz`)).json()) as { concurrency: number };
    expect(body.concurrency).toBe(3);
  });

  it('uses the production environment window while retaining durable-governor admission', async () => {
    gated = makeGated();
    const previous = process.env[EMBED_SIDECAR_CONCURRENCY_ENV];
    process.env[EMBED_SIDECAR_CONCURRENCY_ENV] = '2';
    const admissions: Array<GovernedOperationInput<unknown>> = [];
    const governedOperation = async <T>(
      input: GovernedOperationInput<T>,
      run: (context: AdmissionContext) => Promise<T>,
    ): Promise<T> => {
      admissions.push(input as GovernedOperationInput<unknown>);
      return run({
        contractVersion: 1,
        requestId: `env-window-${admissions.length}`,
        rootRequestId: `env-window-${admissions.length}`,
        parentRequestId: null,
        idempotencyKey: `env-window-${admissions.length}`,
        admissionClass: input.admissionClass,
        priority: 0,
        demand: input.demand ?? {},
        depth: 0,
        createdAtMs: 0,
        decisionGeneration: 1,
      });
    };
    try {
      await boot(undefined, governedOperation);
      const request = post(['a', 'b', 'c']);
      await waitFor(() => gated.started.length === 2);
      expect(gated.started).toEqual(['a', 'b']);

      const health = (await (await fetch(`${baseUrl}/healthz`)).json()) as {
        concurrency: number | null;
        admission: { mode: string };
        queue: { depth: number; active: number; saturated: boolean };
      };
      expect(health).toMatchObject({
        concurrency: 2,
        admission: { mode: 'durable-governor' },
        queue: { depth: 1, active: 2, saturated: true },
      });
      expect(admissions).toHaveLength(2);

      gated.release.get('a')!();
      await waitFor(() => gated.started.length === 3);
      gated.release.get('b')!();
      gated.release.get('c')!();
      expect((await request).status).toBe(200);
      expect(admissions).toHaveLength(3);
    } finally {
      if (previous === undefined) delete process.env[EMBED_SIDECAR_CONCURRENCY_ENV];
      else process.env[EMBED_SIDECAR_CONCURRENCY_ENV] = previous;
    }
  });
});

/**
 * P-005 (local-reranker-gte-modernbert-2026-08-02): the /rerank surface.
 *
 * Same discipline as the embed tests above — INJECTED fake rerankers, no ONNX
 * model ever loads here. The real-model proof is the live verification item;
 * this file pins the wire contract: validation, index-aligned scores, the
 * SHARED warm registry, lazy build with non-memoized failures, and the
 * caching/coalescing the reranker inherits from the embed path.
 */
describe('validateRerankRequest', () => {
  it('accepts a minimal valid request and defaults model to rerank', () => {
    expect(validateRerankRequest({ query: 'q', texts: ['a'] })).toEqual({
      model: 'rerank',
      query: 'q',
      texts: ['a'],
    });
  });

  it('requires a real query — a reranker scores a PAIR, so a blank query is meaningless', () => {
    expect(validateRerankRequest({ texts: ['a'] })).toHaveProperty('error');
    expect(validateRerankRequest({ query: '   ', texts: ['a'] })).toHaveProperty('error');
    expect(validateRerankRequest({ query: 42, texts: ['a'] })).toHaveProperty('error');
  });

  it('rejects unknown models and bad texts, and enforces the batch cap', () => {
    expect(validateRerankRequest(null)).toHaveProperty('error');
    expect(validateRerankRequest({ model: 'zerank-2', query: 'q', texts: ['a'] })).toHaveProperty('error');
    expect(validateRerankRequest({ query: 'q', texts: [] })).toHaveProperty('error');
    expect(validateRerankRequest({ query: 'q', texts: [42] })).toHaveProperty('error');
    expect(validateRerankRequest({ query: 'q', texts: Array(MAX_TEXTS_PER_CALL + 1).fill('x') })).toHaveProperty(
      'error',
    );
  });

  it('accepts the fast tier', () => {
    expect(validateRerankRequest({ model: 'rerank-fast', query: 'q', texts: ['a'] })).toEqual({
      model: 'rerank-fast',
      query: 'q',
      texts: ['a'],
    });
  });
});

describe('warm-env split between embedders and rerankers', () => {
  it('reads reranker ids out of the same env, defaulting to none', () => {
    expect(resolveWarmRerankers({})).toEqual([]);
    expect(resolveWarmRerankers({ [EMBED_SIDECAR_WARM_ENV]: 'gemma,harrier' })).toEqual([]);
    expect(resolveWarmRerankers({ [EMBED_SIDECAR_WARM_ENV]: 'gemma,rerank' })).toEqual(['rerank']);
    expect(resolveWarmRerankers({ [EMBED_SIDECAR_WARM_ENV]: 'rerank,rerank,rerank-fast' })).toEqual([
      'rerank',
      'rerank-fast',
    ]);
  });

  it('a reranker-only list warms NO embedder — not a surprise gemma load', () => {
    expect(resolveWarmModels({ [EMBED_SIDECAR_WARM_ENV]: 'rerank' })).toEqual([]);
    expect(resolveWarmRerankers({ [EMBED_SIDECAR_WARM_ENV]: 'rerank' })).toEqual(['rerank']);
  });

  it('still defaults to gemma when nothing is recognized (the unconfigured case is unchanged)', () => {
    expect(resolveWarmModels({ [EMBED_SIDECAR_WARM_ENV]: 'gpt-9,nope' })).toEqual(['gemma']);
    expect(resolveWarmModels({ [EMBED_SIDECAR_WARM_ENV]: 'gemma,rerank' })).toEqual(['gemma']);
  });
});

describe('rerank sidecar HTTP surface (fake rerankers, ephemeral port)', () => {
  let handle: EmbedSidecarHandle | null = null;
  let baseUrl = '';
  const rerankBuilds: string[] = [];
  const scored: Array<{ query: string; texts: string[] }> = [];

  /** Scores by text length so ordering is assertable without a model. */
  const fakeRerankBuilders: RerankerBuilders = {
    rerank: async () => {
      rerankBuilds.push('rerank');
      return async (query: string, texts: string[]) => {
        scored.push({ query, texts });
        return texts.map((t) => t.length);
      };
    },
    'rerank-fast': async () => {
      rerankBuilds.push('rerank-fast');
      return async (_query: string, texts: string[]) => texts.map((t) => -t.length);
    },
  };

  async function bootRerank(rerankBuilders: RerankerBuilders = fakeRerankBuilders): Promise<void> {
    handle = createEmbedSidecarServer({
      port: 0,
      rerankBuilders,
      warmAtBoot: false,
      log: () => {},
      concurrency: 1,
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;
  }

  const rerank = (body: unknown) =>
    fetch(`${baseUrl}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  afterEach(async () => {
    await handle?.close();
    handle = null;
    rerankBuilds.length = 0;
    scored.length = 0;
  });

  it('returns scores INDEX-ALIGNED with the request texts, never reordered', async () => {
    await bootRerank();
    // Deliberately not in score order: the server must NOT sort. Ordering is
    // the client's job, so a server that "helpfully" sorted would silently
    // misalign every caller that zips scores back onto its own candidates.
    const res = await rerank({ query: 'q', texts: ['aaa', 'a', 'aa'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scores: number[]; runtime: string; modelRev: string };
    expect(body.scores).toEqual([3, 1, 2]);
    expect(body.runtime).toBe(EMBED_SIDECAR_RUNTIME);
    expect(body.modelRev).toContain('gte-reranker-modernbert');
  });

  it('serves the fast tier under its own model rev', async () => {
    await bootRerank();
    const body = (await (await rerank({ model: 'rerank-fast', query: 'q', texts: ['ab'] })).json()) as {
      scores: number[];
      modelRev: string;
    };
    expect(body.scores).toEqual([-2]);
    expect(body.modelRev).toContain('ms-marco');
  });

  it('builds each reranker once and reports it in the SHARED warm registry', async () => {
    await bootRerank();
    await rerank({ query: 'q', texts: ['a'] });
    await rerank({ query: 'q2', texts: ['b'] });
    await rerank({ model: 'rerank-fast', query: 'q', texts: ['c'] });
    expect(rerankBuilds).toEqual(['rerank', 'rerank-fast']);
    expect(handle!.warmStates()).toEqual({ rerank: 'warm', 'rerank-fast': 'warm' });

    // /healthz shows embedders and rerankers in one picture of the host.
    const health = (await (await fetch(`${baseUrl}/healthz`)).json()) as { models: Record<string, string> };
    expect(health.models).toEqual({ rerank: 'warm', 'rerank-fast': 'warm' });
  });

  it.each(['resolve', 'reject'] as const)('reports boot inference completion separately from construction (%s)', async outcome => {
    const savedWarm = process.env[EMBED_SIDECAR_WARM_ENV];
    process.env[EMBED_SIDECAR_WARM_ENV] = 'rerank';
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const inference = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    let started = false;
    try {
      handle = createEmbedSidecarServer({ port: 0, concurrency: 1, log: () => {},
        embedDevice: { load: async () => ({ setting: null, changed: false, readError: null }) },
        rerankBuilders: { ...fakeRerankBuilders, rerank: async () => async () => {
          started = true;
          await inference;
          return [0.5];
        } },
      });
      baseUrl = `http://127.0.0.1:${await handle.listening}`;
      await vi.waitFor(() => expect(started).toBe(true));
      const pending = await (await fetch(`${baseUrl}/healthz`)).json();
      expect(pending.models.rerank).toBe('warm');
      expect(pending.warmups.rerank).toBe('warming');
      if (outcome === 'resolve') finish();
      else fail(new Error('first inference failed'));
      await vi.waitFor(async () => {
        const settled = await (await fetch(`${baseUrl}/healthz`)).json();
        expect(settled.warmups.rerank).toBe(outcome === 'resolve' ? 'warm' : 'failed');
      });
    } finally {
      finish();
      if (savedWarm === undefined) delete process.env[EMBED_SIDECAR_WARM_ENV];
      else process.env[EMBED_SIDECAR_WARM_ENV] = savedWarm;
    }
  });

  it('caches and coalesces per (model, query, text) pair', async () => {
    await bootRerank();
    await rerank({ query: 'q', texts: ['a', 'b'] });
    await rerank({ query: 'q', texts: ['a', 'c'] }); // 'a' is a cache hit
    // One scoring call per UNIQUE pair: a,b,c — not 4.
    expect(scored.map((s) => s.texts[0])).toEqual(['a', 'b', 'c']);

    const health = (await (await fetch(`${baseUrl}/healthz`)).json()) as {
      cache: { hits: number; misses: number };
    };
    expect(health.cache.misses).toBe(3);
    expect(health.cache.hits).toBe(1);
  });

  it('a different query is a different pair — scores are never reused across queries', async () => {
    await bootRerank();
    await rerank({ query: 'q1', texts: ['a'] });
    await rerank({ query: 'q2', texts: ['a'] });
    expect(scored.map((s) => s.query)).toEqual(['q1', 'q2']);
  });

  it('400s invalid requests and 500s a reranker failure without killing the server', async () => {
    await bootRerank();
    expect((await rerank({ model: 'nope', query: 'q', texts: ['a'] })).status).toBe(400);
    expect((await rerank({ query: '', texts: ['a'] })).status).toBe(400);
    expect((await fetch(`${baseUrl}/rerank`, { method: 'POST', body: '{{' })).status).toBe(400);

    await handle!.close();
    let attempts = 0;
    await bootRerank({
      ...fakeRerankBuilders,
      rerank: async () => {
        attempts++;
        throw new Error('model download failed');
      },
    });
    const failed = await rerank({ query: 'q', texts: ['a'] });
    expect(failed.status).toBe(500);
    expect(((await failed.json()) as { error: string }).error).toContain('rerank_failed');
    expect(handle!.warmStates()).toEqual({ rerank: 'failed' });

    // A failed build must NOT be memoized — a transient download fault cannot
    // brick the slot for the process lifetime.
    expect((await rerank({ query: 'q2', texts: ['a'] })).status).toBe(500);
    expect(attempts).toBe(2);

    // …and the server is still serving.
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
  });

  it('GET /rerank is not a route (POST only)', async () => {
    await bootRerank();
    expect((await fetch(`${baseUrl}/rerank`)).status).toBe(404);
  });
});

/**
 * The Settings embedding-device choice (plan memory-reduction-2026-09-24 D-008,
 * WI-10002872). The loader is injected — the real one reads PG and recycles the
 * worker — so what is pinned here is the sidecar's half: WHEN it applies the
 * choice (before the boot warm-up; on POST /embed-device/reload) and what a
 * change does to the models it holds.
 */
describe('embed sidecar — Settings embedding-device choice (D-008)', () => {
  let handle: EmbedSidecarHandle | null = null;
  let baseUrl = '';
  let savedWarmEnv: string | undefined;
  const builds: string[] = [];
  const logs: string[] = [];

  const builders: EmbedderBuilders = {
    gemma: async (kind) => {
      builds.push(`gemma:${kind}`);
      return async (text: string) => [text.length, 1];
    },
    local: async (kind) => {
      builds.push(`local:${kind}`);
      return async (text: string) => [text.length, 3];
    },
    harrier: async (kind) => {
      builds.push(`harrier:${kind}`);
      return async (text: string) => [text.length, 4];
    },
  };

  beforeEach(() => {
    savedWarmEnv = process.env[EMBED_SIDECAR_WARM_ENV];
    delete process.env[EMBED_SIDECAR_WARM_ENV]; // boot-warm set = gemma (the default)
  });

  afterEach(async () => {
    await handle?.close();
    handle = null;
    builds.length = 0;
    logs.length = 0;
    if (savedWarmEnv === undefined) delete process.env[EMBED_SIDECAR_WARM_ENV];
    else process.env[EMBED_SIDECAR_WARM_ENV] = savedWarmEnv;
  });

  async function boot(load: () => Promise<EmbedDeviceSettingLoad>, warmAtBoot = false): Promise<void> {
    handle = createEmbedSidecarServer({
      port: 0,
      builders,
      warmAtBoot,
      log: (line) => logs.push(line),
      concurrency: 1,
      embedDevice: { load },
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;
  }

  const embedQuery = () =>
    fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemma', kind: 'query', texts: ['x'] }),
    });

  const reload = async (): Promise<{ status: number; body: EmbedDeviceReloadResponse }> => {
    const res = await fetch(`${baseUrl}/embed-device/reload`, { method: 'POST' });
    return { status: res.status, body: (await res.json()) as EmbedDeviceReloadResponse };
  };

  it('an unchanged reload reports the held choice and rebuilds nothing', async () => {
    const load = vi.fn(async (): Promise<EmbedDeviceSettingLoad> => ({ setting: 'cuda', changed: false, readError: null }));
    await boot(load);
    expect((await embedQuery()).status).toBe(200);

    const { status, body } = await reload();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, setting: 'cuda', changed: false, readError: null, rewarm: null });
    // The caller renders "in use" from these, so the reload answers them directly.
    expect(body.embedExecution).toBeDefined();
    expect(body.embedExecutionHealth).toBeDefined();
    // warmAtBoot:false ⇒ no boot read; the one call is the reload's.
    expect(load).toHaveBeenCalledTimes(1);
    expect(builds).toEqual(['gemma:query']);
  });

  it('a changed reload drops the memoized embedders and re-warms the boot-warm set', async () => {
    await boot(async () => ({ setting: 'cpu', changed: true, readError: null }));
    expect((await embedQuery()).status).toBe(200);
    expect(builds).toEqual(['gemma:query']);

    const { status, body } = await reload();
    expect(status).toBe(200);
    expect(body.changed).toBe(true);
    expect(body.rewarm).toEqual({
      timedOut: false,
      models: { 'gemma:document': 'warm', 'gemma:query': 'warm' },
    });
    // gemma:query is REBUILT, not reused: its old closure may hold an inline
    // pipeline built on the previous device. Keeping the memo would add only
    // gemma:document here.
    expect(builds.slice(1).sort()).toEqual(['gemma:document', 'gemma:query']);
    expect(handle!.warmStates()).toEqual({ 'gemma:document': 'warm', 'gemma:query': 'warm' });
  });

  it('a failing loader keeps the current device — 200 with readError, never a 500', async () => {
    await boot(async () => {
      throw new Error('pg unreachable');
    });
    const { status, body } = await reload();
    expect(status).toBe(200);
    expect(body).toMatchObject({ changed: false, readError: 'pg unreachable', rewarm: null });
    expect(logs.some((l) => l.includes('read failed: pg unreachable'))).toBe(true);
  });

  it('boot applies the choice BEFORE any model loads, then warms', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = vi.fn(async (): Promise<EmbedDeviceSettingLoad> => {
      await gate;
      return { setting: 'cpu', changed: true, readError: null };
    });
    await boot(load, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The read is in flight and nothing has been built: a warm-up that raced
    // ahead would load on auto and then need a recycle.
    expect(load).toHaveBeenCalledTimes(1);
    expect(builds).toEqual([]);

    release();
    await vi.waitFor(() =>
      expect(handle!.warmStates()).toEqual({ 'gemma:document': 'warm', 'gemma:query': 'warm' }),
    );
    expect(logs.some((l) => l.includes('embedding device setting (boot): cpu'))).toBe(true);
  });
});
