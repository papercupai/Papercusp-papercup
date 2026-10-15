import { describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEmbedSidecarServer } from '../embed-sidecar-server';
import { collectSidecarPerformance, summarizePerformanceReceipts, performanceSchedule, isolatedEvaluationBuilders, verifyCompletedPerformanceRun, type PerformanceInput, type PerformanceReceipt } from './sidecar-performance';
import { sidecarEmbedBatch } from '@papercusp/memory';
import { measurementManifestFixture } from './fixtures/measurement-manifest';
import { failMeasurementCell, fingerprintFile, type PreparedMeasurement } from './measurement-manifest';

const input: PerformanceInput = { formatVersion: 1, seed: 'synthetic', blocks: 5, warmSamples: 3, rounds: 2,
  batches: [1, 2], concurrency: [1, 2], cachedSamples: 2, serverConcurrency: 2,
  requests: { query: [{ id: 'q', corpus: 'memory', text: 'query' }], document: [{ id: 'd', corpus: 'prose', text: 'document' }] } };
async function productionNodeProbe(script: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_FORBID_REAL_PG: '1', PAPERCUSP_EMBED_DEVICE: 'cpu' };
    delete env.VITEST;
    delete env.PAPERCUSP_HTTP_KEEPALIVE_TIMEOUT_MS;
    delete env.PAPERCUSP_HTTP_HEADERS_TIMEOUT_MS;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('idle-boundary child exceeded 25s')); }, 25000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}
describe('performance collector through real HTTP/client/sidecar queue', () => {
  it.each(['sequential', 'concurrent-batch'] as const)('captures %s pool lifecycle across a response-completion pause without retry', async (poolShape) => {
    // The real warm128 probe failed on the first POST after a 10s gap. Run
    // the same server/client in a production Node child so pausing its loop
    // cannot stall Vitest or its other tests. Synthetic weights isolate the
    // transport; this is a recurrence guard, not model-performance evidence.
    const serverModule = fileURLToPath(new URL('../embed-sidecar-server.ts', import.meta.url));
    const clientModule = fileURLToPath(new URL('../../../../../libs/generic/memory/src/sidecar-embedder.ts', import.meta.url));
    const collectorModule = fileURLToPath(new URL('./sidecar-performance.ts', import.meta.url));
    const script = `
      import { createEmbedSidecarServer } from ${JSON.stringify(serverModule)};
      import { sidecarEmbedBatch } from ${JSON.stringify(clientModule)};
      import { observeSidecarTransport } from ${JSON.stringify(collectorModule)};
      const sidecar = createEmbedSidecarServer({ port: 0, warmAtBoot: false, concurrency: 4,
        builders: { harrier: async () => async () => [1, ...Array(1023).fill(0)] }, log: () => {} });
      const events = [];
      // Force the observed original idle policy only for this trace guard.
      // A passed guard does not establish the real-model reset's cause.
      sidecar.server.keepAliveTimeout = 5000;
      const url = 'http://127.0.0.1:' + await sidecar.listening;
      const stopTrace = observeSidecarTransport(sidecar.server, url, event => events.push(event));
      const report = { keepAliveTimeout: sidecar.server.keepAliveTimeout,
        headersTimeout: sidecar.server.headersTimeout, poolShape: ${JSON.stringify(poolShape)},
        completed: 0, error: null, events };
      const call = async (batchSize) => {
        await sidecarEmbedBatch(url, { model: 'harrier', kind: 'query',
          texts: Array(batchSize).fill('frozen'), bypassCache: true });
        report.completed++;
      };
      try {
        for (let i = 0; i < 4; i++) {
          await call(1);
          if (i < 3) await new Promise(resolve => setTimeout(resolve, 20));
        }
        if (report.poolShape === 'concurrent-batch') {
          // Preserve the failed v4 collector's pool topology before 16x1:
          // four rounds at each preceding batch/concurrency combination.
          for (const batchSize of [1, 4]) for (const concurrency of [1, 4]) {
            for (let round = 0; round < 4; round++) {
              await Promise.all(Array.from({ length: concurrency }, () => call(batchSize)));
            }
          }
        }
        report.completedBeforePause = report.completed;
        report.lastResponseAt = events.filter(event => event.event === 'server-response').at(-1).at;
        report.pauseStartedAt = Date.now();
        // Stay in the response-completion microtask, as the collector's
        // synchronous sample append does; a timer-phase pause is different.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10500);
        report.pauseEndedAt = Date.now();
        await call(report.poolShape === 'concurrent-batch' ? 16 : 1);
      } catch (error) {
        report.error = { message: error.message, code: error.cause?.code,
          cause: error.cause?.message };
      } finally {
        await sidecar.close();
        stopTrace();
        console.log(JSON.stringify(report));
        process.exit(0);
      }
    `;
    const result = await productionNodeProbe(script);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    const lastSend = report.events.filter((event: { event: string }) => event.event === 'client-send').at(-1);
    const failureEvidence = { poolShape, completed: report.completed, error: report.error,
      lastResponseAt: report.lastResponseAt, pauseStartedAt: report.pauseStartedAt, pauseEndedAt: report.pauseEndedAt,
      // Put the causal tail first: bounded test ledgers otherwise retain the
      // successful warm-up head and discard the closing actor's evidence.
      tail: report.events.filter((event: { at: string; clientPort?: number }) =>
        Date.parse(event.at) >= report.pauseStartedAt && event.clientPort === lastSend.clientPort)
        .map((event: { at: string; event: string; clientPort?: number; code?: string }) =>
        ({ at: event.at, event: event.event, port: event.clientPort, code: event.code })) };
    if (report.error) {
      // This direct synchronous control measures the runtime race. The
      // collector guard below requires successful async retention instead.
      expect(poolShape).toBe('concurrent-batch');
      expect(report.error.code, JSON.stringify(failureEvidence)).toBe('ECONNRESET');
      expect(failureEvidence.tail.map((event: { event: string }) => event.event), JSON.stringify(failureEvidence))
        .toEqual(['client-send', 'server-idle-timeout', 'client-error']);
    }
    expect(report.completedBeforePause).toBe(poolShape === 'concurrent-batch' ? 44 : 4);
    expect(report.completed).toBe(report.completedBeforePause + (report.error ? 0 : 1));
    expect(report.pauseEndedAt - report.pauseStartedAt).toBeGreaterThanOrEqual(10500);
    expect(report.events.filter((event: { event: string }) => event.event === 'client-send')).toHaveLength(report.completedBeforePause + 1);
    expect(report.events.some((event: { event: string }) => event.event === 'server-idle-timeout')).toBe(true);
    expect(report.events.filter((event: { event: string; clientPort?: number }) => event.event === 'client-send')
      .every((event: { clientPort?: number }) => Number.isInteger(event.clientPort))).toBe(true);
    const sends = report.events.filter((event: { event: string }) => event.event === 'client-send');
    if (poolShape === 'concurrent-batch') {
      expect(new Set(sends.slice(0, -1).map((event: { clientPort: number }) => event.clientPort)).size).toBeGreaterThanOrEqual(4);
    }
    expect(Date.parse(sends.at(-1).at) - Date.parse(report.lastResponseAt)).toBeGreaterThanOrEqual(10500);
    expect(report.events.filter((event: { event: string }) => event.event === 'client-error')).toHaveLength(report.error ? 1 : 0);
    expect(report.events.some((event: { event: string }) => event.event === 'server-error')).toBe(false);
    expect(JSON.stringify(report.events)).not.toContain('frozen');
  }, 30000);
  it('awaits asynchronous sample retention across the concurrent pool idle boundary', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-async-retention-'));
    const serverModule = fileURLToPath(new URL('../embed-sidecar-server.ts', import.meta.url));
    const collectorModule = fileURLToPath(new URL('./sidecar-performance.ts', import.meta.url));
    const fixtureModule = fileURLToPath(new URL('./fixtures/measurement-manifest.ts', import.meta.url));
    try {
      const result = await productionNodeProbe(`
        import fs from 'node:fs';
        import { createEmbedSidecarServer } from ${JSON.stringify(serverModule)};
        import { collectSidecarPerformance, observeSidecarTransport } from ${JSON.stringify(collectorModule)};
        import { measurementManifestFixture } from ${JSON.stringify(fixtureModule)};
        const sampleFile = ${JSON.stringify(path.join(dir, 'samples.jsonl'))};
        const arm = measurementManifestFixture('/private').arms[0];
        const sidecar = createEmbedSidecarServer({ port: 0, warmAtBoot: false, concurrency: 4,
          builders: { mdenseon: async () => async () => [1, ...Array(767).fill(0)] },
          modelRevisions: { mdenseon: arm.modelRev }, log: () => {} });
        sidecar.server.keepAliveTimeout = 5000;
        const url = 'http://127.0.0.1:' + await sidecar.listening, events = [];
        const stopTrace = observeSidecarTransport(sidecar.server, url, event => events.push(event));
        const outcome = { error: null, paused: false, retained: 0, completed: 0 };
        try {
          const report = await collectSidecarPerformance(url, arm, ${JSON.stringify({ ...input, warmSamples: 4, rounds: 4, batches: [1, 4, 16], concurrency: [1, 4], serverConcurrency: 4 })}, {
            processStartedAtMs: Date.now(),
            onSample: async sample => {
              if (sample.sequence === 45) {
                outcome.paused = true;
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10500);
              }
              await fs.promises.appendFile(sampleFile, JSON.stringify(sample) + '\\n');
              outcome.retained++;
            }
          });
          outcome.completed = report.samples.length;
        } catch (error) { outcome.error = { message: error.message, code: error.cause?.cause?.code }; }
        finally {
          await sidecar.close(); stopTrace();
          outcome.idleTimeouts = events.filter(event => event.event === 'server-idle-timeout').length;
          outcome.clientErrors = events.filter(event => event.event === 'client-error').length;
          console.log(JSON.stringify(outcome)); process.exit(0);
        }
      `);
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
      expect(report.error, JSON.stringify(report)).toBeNull();
      expect(report.paused).toBe(true);
      expect(report.idleTimeouts).toBeGreaterThan(0);
      expect(report.clientErrors).toBe(0);
      const retained = fs.readFileSync(path.join(dir, 'samples.jsonl'), 'utf8').trim().split('\n').map((row) => JSON.parse(row));
      expect(report.retained).toBe(report.completed);
      expect(retained).toHaveLength(report.completed);
      expect(new Set(retained.map((sample) => sample.sequence)).size).toBe(report.completed);
      expect(retained.some((sample) => sample.kind === 'query' && sample.batchSize === 16 && sample.concurrency === 1)).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 30000);
  it('retains the actual socket failure cause and frozen request identity in its failure receipt', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-socket-failure-'));
    const server = http.createServer((req) => req.socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const manifest = measurementManifestFixture(dir);
    const prepared = { manifest, manifestSha256: 'a'.repeat(64), arm: manifest.arms[0], cell: manifest.cells[0],
      rawOutput: path.join(dir, 'out.json'), claimPath: path.join(dir, 'out.running') } as PreparedMeasurement;
    fs.writeFileSync(prepared.claimPath, 'owned');
    try {
      let failure: unknown;
      try { await collectSidecarPerformance(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, prepared.arm, input); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      failMeasurementCell(prepared, failure);
      const receipt = JSON.parse(fs.readFileSync(`${prepared.rawOutput}.failure.json`, 'utf8'));
      expect(receipt.error.cause.cause.code).toBe('UND_ERR_SOCKET');
      expect(receipt.error.request).toMatchObject({ phase: 'cold', kind: 'query', sequence: 0,
        model: prepared.arm.model, requestIds: ['q'], batchSize: 1, concurrency: 1 });
      expect(fs.existsSync(prepared.claimPath)).toBe(false);
      expect(fs.existsSync(prepared.rawOutput)).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('admits all three model arms through the exact isolated CLI builder-map assembler', async () => {
    const arms = measurementManifestFixture('/private').arms;
    const builder = (dims: number) => async () => async () => [1, ...Array(dims - 1).fill(0)];
    const server = createEmbedSidecarServer({ port: 0, concurrency: 1, warmAtBoot: false,
      builders: isolatedEvaluationBuilders(builder(768), { gemma: builder(768), harrier: builder(1024) }),
      modelRevisions: Object.fromEntries(arms.map((a) => [a.model, a.modelRev])) });
    try {
      const url = `http://127.0.0.1:${await server.listening}`;
      for (const arm of arms) {
        const response = await sidecarEmbedBatch(url, { model: arm.model, kind: 'query', texts: ['same frozen request'], bypassCache: true });
        expect(response.modelRev).toBe(arm.modelRev); expect(response.dims).toBe(arm.profile.targetDims);
        expect(response.cache).toEqual({ hits: 0, coalesced: 0, inferred: 1 });
      }
    } finally { await server.close(); }
  });
  it('retains every uncached request and separates real cache hits with group-wall throughput', async () => {
    let calls = 0;
    const arm = measurementManifestFixture('/private').arms[0];
    const server = createEmbedSidecarServer({ port: 0, concurrency: 2, warmAtBoot: false,
      builders: { mdenseon: async () => async () => { calls++; return [1, ...Array(767).fill(0)]; } },
      modelRevisions: { mdenseon: arm.modelRev } });
    try {
      const report = await collectSidecarPerformance(`http://127.0.0.1:${await server.listening}`, arm, input);
      expect(report.samples).toHaveLength(38);
      expect(report.samples.filter((s) => s.phase === 'warm')).toHaveLength(6);
      expect(report.samples.filter((s) => s.phase === 'cached')).toHaveLength(4);
      expect(report.samples.filter((s) => s.phase === 'cached').every((s) => s.cache.hits === 1 && s.cache.inferred === 0)).toBe(true);
      expect(report.samples.filter((s) => s.phase !== 'cached').every((s) => s.cache.inferred === s.batchSize)).toBe(true);
      expect(calls).toBe(report.samples.reduce((n, s) => n + s.cache.inferred, 0));
      expect(report.groups).toHaveLength(8);
      for (const group of report.groups) {
        expect(group.sampleIndices).toHaveLength(input.rounds * group.concurrency);
        expect(group.textsPerSecond).toBeCloseTo(group.sampleIndices.length * group.batchSize * 1000 / group.wallMs);
      }
      expect(report.resource.gpuMemory.status).toBe('not-applicable');
      // Synthetic replay of the collected HTTP rows qualifies the five-block
      // admission guard, never the real-model performance acceptance bar.
      const manifest = measurementManifestFixture('/private'); manifest.seed = input.seed;
      const receipts = performanceSchedule(input.seed, 5, manifest.arms.map((a) => a.id)).map((s, i) => {
        const a = manifest.arms.find((x) => x.id === s.armId)!;
        const copy = structuredClone(report);
        copy.pid = 100000 + i;
        copy.samples = copy.samples.map((x) => ({ ...x, modelRev: a.modelRev, dims: a.profile.targetDims }));
        return { manifestSha256: 'a'.repeat(64), ownerId: manifest.ownerId, cellId: s.cellId, armId: s.armId,
          measuredAt: new Date().toISOString(), report: { ...copy, block: s.block, order: s.order,
            execution: { device: 'cpu', verified: true }, workerState: { alive: true, disabled: false } } } as PerformanceReceipt;
      });
      expect(summarizePerformanceReceipts(manifest, 'a'.repeat(64), input, receipts).performanceComplete).toBe(true);
      const missing = structuredClone(receipts); missing.pop();
      expect(() => summarizePerformanceReceipts(manifest, 'a'.repeat(64), input, missing)).toThrow('cell');
      const shared = structuredClone(receipts); shared[1].report.pid = shared[0].report.pid;
      expect(() => summarizePerformanceReceipts(manifest, 'a'.repeat(64), input, shared)).toThrow('non-fresh');
      const stale = structuredClone(receipts); stale[0].report.warm.query.p99Ms += 1;
      expect(() => summarizePerformanceReceipts(manifest, 'a'.repeat(64), input, stale)).toThrow('raw samples');
      const cached = structuredClone(receipts); cached[0].report.samples.find((s) => s.phase === 'warm')!.cache.hits = 1;
      expect(() => summarizePerformanceReceipts(manifest, 'a'.repeat(64), input, cached)).toThrow('raw samples');
      const group = structuredClone(receipts); group[0].report.groups[1].sampleIndices[0] = group[0].report.groups[0].sampleIndices[0];
      expect(() => summarizePerformanceReceipts(manifest, 'a'.repeat(64), input, group)).toThrow('group sample');
      // Terminal shell state or a fifteen-entry summary cannot serialize model
      // work unless its complete raw population is still present and bound.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-predecessor-'));
      try {
        const predecessor = measurementManifestFixture(dir); predecessor.seed = input.seed;
        const requestFile = path.join(dir, 'requests.json'); fs.writeFileSync(requestFile, JSON.stringify(input));
        predecessor.inputs.requests = await fingerprintFile(requestFile);
        predecessor.cells = [...predecessor.cells.filter((cell) => cell.bar !== 'performance'),
          performanceSchedule(input.seed, 5, predecessor.arms.map((arm) => arm.id)).map((cell) => ({
            id: cell.cellId, bar: 'performance' as const, armId: cell.armId, inputIds: ['requests'],
            parameters: { block: cell.block, order: cell.order, requests: 'requests' }, output: cell.cellId,
          }))].flat();
        const manifestFile = path.join(dir, 'manifest.json'); fs.writeFileSync(manifestFile, JSON.stringify(predecessor));
        const sha = (await fingerprintFile(manifestFile)).sha256;
        const root = path.join(dir, predecessor.runId); fs.mkdirSync(root);
        const bound = receipts.map((receipt) => ({ ...receipt, ownerId: predecessor.ownerId, manifestSha256: sha }));
        const rawArtifacts = [];
        for (const receipt of bound) {
          const raw = path.join(root, `${receipt.cellId}.json`); fs.writeFileSync(raw, JSON.stringify(receipt));
          rawArtifacts.push(await fingerprintFile(raw));
        }
        const saved = { ownerId: predecessor.ownerId, manifestSha256: sha, rawArtifacts,
          summary: summarizePerformanceReceipts(predecessor, sha, input, bound) };
        const summaryFile = path.join(root, 'performance-summary.json'); fs.writeFileSync(summaryFile, JSON.stringify(saved));
        const driverFile = path.join(root, 'driver.json');
        const driver = { ownerId: predecessor.ownerId, manifestSha256: sha, status: 'running', current: '',
          completed: bound.map((receipt) => receipt.cellId) };
        fs.writeFileSync(driverFile, JSON.stringify(driver));
        await expect(verifyCompletedPerformanceRun(manifestFile, sha)).rejects.toThrow('not complete');
        driver.status = 'completed'; fs.writeFileSync(driverFile, JSON.stringify(driver));
        await expect(verifyCompletedPerformanceRun(manifestFile, sha)).resolves.toMatchObject({ cells: 15, inferencePerformed: false });
        fs.appendFileSync(rawArtifacts[0].path, ' ');
        await expect(verifyCompletedPerformanceRun(manifestFile, sha)).rejects.toThrow('fingerprint');
        fs.writeFileSync(rawArtifacts[0].path, JSON.stringify(bound[0]));
        saved.summary.cells[0].warm.query.p99Ms += 1; fs.writeFileSync(summaryFile, JSON.stringify(saved));
        await expect(verifyCompletedPerformanceRun(manifestFile, sha)).rejects.toThrow('disagrees');
        fs.rmSync(summaryFile);
        await expect(verifyCompletedPerformanceRun(manifestFile, sha)).rejects.toThrow('ENOENT');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    } finally { await server.close(); }
  });
  it('refuses a stale model revision before producing a performance result', async () => {
    const arm = measurementManifestFixture('/private').arms[0];
    const server = createEmbedSidecarServer({ port: 0, concurrency: 1, warmAtBoot: false,
      builders: { mdenseon: async () => async () => [1, ...Array(767).fill(0)] }, modelRevisions: { mdenseon: 'wrong' } });
    try {
      await expect(collectSidecarPerformance(`http://127.0.0.1:${await server.listening}`, arm, input)).rejects.toThrow('identity mismatch');
    } finally { await server.close(); }
  });
});
