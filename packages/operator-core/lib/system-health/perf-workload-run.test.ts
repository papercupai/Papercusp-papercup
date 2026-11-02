import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { perfProtocolHash } from './perf-workload-protocol';
import { collectPerfWorkloadRun, intactPerfWorkloadRun, perfWorkloadRunSeries, type PerfWorkloadManifest, type PerfWorkloadRunPlan } from './perf-workload-run';

let server: Server;
let origin: string;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const manifest: PerfWorkloadManifest = { source: { file: 'source-sha' }, configuration: { fixture: true },
  runtime: { build: 'test-server' }, host: { boot: 'test-boot' }, workload: { method: 'GET' }, fixture: { response: digest('ok') } };
beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/mcp-fixture') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        if (request.method !== 'POST' || body !== '{"jsonrpc":"2.0","id":1,"method":"ping"}' ||
            request.headers.authorization !== 'Bearer runtime-only-test' || request.headers['content-type'] !== 'application/json' ||
            request.headers.accept !== 'application/json, text/event-stream') {
          response.writeHead(400); response.end('bad fixture'); return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write('event: message\n');
        setTimeout(() => response.end('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'), 5);
      });
    } else if (request.url === '/slow') {
      const timer = setTimeout(() => response.end('ok'), 500);
      response.on('close', () => clearTimeout(timer));
    } else if (request.url === '/disconnect') { response.writeHead(200); response.write('o'); setTimeout(() => response.destroy(), 10); }
    else if (request.url === '/wrong') response.end('wrong');
    else response.end('ok');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve())); });

function plan(path = '/ok'): PerfWorkloadRunPlan {
  return { independentRepeatId: 'synthetic-http-collection', phase: 'baseline', origins: { a: origin, b: origin },
    expectedManifestHashes: { a: perfProtocolHash(manifest), b: perfProtocolHash(manifest) },
    groups: [{ journey: 'http', stratum: 'warm', armOrder: ['b', 'a'], concurrency: 1,
      exposureMs: 160, maximumStartLatenessMs: 100,
      requests: [{ id: 'pair-1', path, atMs: 0, timeoutMs: 60, maximumResponseBytes: 100, expectedStatus: 200, expectedBodySha256: digest('ok') }] }] };
}
const deps = () => ({ captureManifest: async () => structuredClone(manifest), prepare: async () => ({ evidenceRef: 'synthetic-preparation-fixture' }) });

describe('scheduled real HTTP workload collection', () => {
  function mcpPlan() {
    const input = plan('/mcp-fixture');
    input.groups[0].exposureMs = 300;
    Object.assign(input.groups[0].requests[0], { method: 'POST',
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}', contentType: 'application/json',
      accept: 'application/json, text/event-stream', expectedContentType: 'text/event-stream',
      expectedBodySha256: digest('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n') });
    return input;
  }
  it('sends pinned MCP POST bytes, retains the complete finite SSE oracle and excludes runtime credentials', async () => {
    const input = mcpPlan();
    const runtimeHeaders = { a: { authorization: 'Bearer runtime-only-test' }, b: { authorization: 'Bearer runtime-only-test' } };
    const run = await collectPerfWorkloadRun(input, { ...deps(), transportHeaders: runtimeHeaders,
      captureManifest: async () => {
        input.groups[0].requests[0].body = 'changed after start';
        runtimeHeaders.a.authorization = 'changed after start';
        return manifest;
      } });
    expect(run.status).toBe('collected');
    expect(run.groups[0].arms.every(arm => arm.requests[0].outcome === 'success')).toBe(true);
    expect(run.groups[0].arms[0].requests[0]).toMatchObject({ responseContentType: 'text/event-stream', oracleMatched: true });
    expect(run.plan.groups[0].requests[0].body).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    expect(JSON.stringify(run)).not.toContain('runtime-only-test');
    expect(perfWorkloadRunSeries(run)![0].a.failures).toBe(0);
  });
  it.each(['body', 'expectedContentType', 'expectedBodySha256'] as const)('retains a failed MCP %s oracle in both paired series', async field => {
    const input = mcpPlan();
    input.groups[0].requests[0][field] = field === 'expectedBodySha256' ? digest('truncated stream') : field === 'expectedContentType' ? 'application/json' : '{}';
    const run = await collectPerfWorkloadRun(input, { ...deps(), transportHeaders: {
      a: { authorization: 'Bearer runtime-only-test' }, b: { authorization: 'Bearer runtime-only-test' } } });
    const series = perfWorkloadRunSeries(run)!;
    expect(series[0].a.failures).toBe(1);
    expect(series[0].b.throughput).toEqual([0]);
  });
  it('rejects unsupported methods, GET bodies and unpinned header syntax before I/O', async () => {
    for (const change of [{ method: 'DELETE' }, { body: '{}' }, { contentType: 'text/plain' },
      { accept: 'application/json\r\nx-header: injected' }, { expectedContentType: 'text/event-stream; charset=utf-8' }]) {
      const input = plan(); Object.assign(input.groups[0].requests[0], change);
      await expect(collectPerfWorkloadRun(input, deps())).rejects.toThrow('invalid workload request');
    }
  });
  it('retains paired schedule, full manifests and exact body oracle; mean rate uses fixed exposure', async () => {
    const run = await collectPerfWorkloadRun(plan(), deps());
    expect(run.status).toBe('collected');
    expect(run.groups[0].arms.map(row => row.arm)).toEqual(['b', 'a']);
    for (const arm of run.groups[0].arms) {
      expect(arm.before).toEqual(manifest);
      expect(arm.after).toEqual(manifest);
      expect(arm.requests[0]).toMatchObject({ id: 'pair-1', outcome: 'success', oracleMatched: true, responseSha256: digest('ok'), responseBytes: 2 });
    }
    const series = perfWorkloadRunSeries(run)!;
    expect(series[0].a.throughput).toEqual([1000 / 160]);
    expect(series[0].b.failures).toBe(0);
    run.groups[0].arms[0].requests[0].elapsedMs = 0;
    expect(perfWorkloadRunSeries(run)).toBeNull();
  });
  it.each(['/wrong', '/slow', '/disconnect'])('keeps %s failures and conservative censored latency in the raw and derived series', async path => {
    const run = await collectPerfWorkloadRun(plan(path), deps());
    expect(run.groups[0].arms.every(row => row.requests.length === 1)).toBe(true);
    const series = perfWorkloadRunSeries(run)!;
    expect(series[0].a.failures).toBe(1);
    expect(series[0].a.throughput).toEqual([0]);
    if (path !== '/wrong') expect(series[0].a.latencyMs[0]).toBeGreaterThanOrEqual(60);
  });
  it('captures a changed runtime after the requests and refuses to derive qualified inputs', async () => {
    let captures = 0;
    const run = await collectPerfWorkloadRun(plan(), { ...deps(), captureManifest: async () => {
      captures++;
      return captures === 2 ? { ...manifest, runtime: { build: 'changed' } } : manifest;
    } });
    expect(run.status).toBe('unknown');
    expect(run.reasons).toContain('manifest-mismatch:b');
    expect(run.groups[0].arms[0].requests).toHaveLength(1);
    expect(perfWorkloadRunSeries(run)).toBeNull();
  });
  it('fails closed on missing arms/pairs even in a freshly rehashed artifact', async () => {
    const run = await collectPerfWorkloadRun(plan(), deps());
    run.groups[0].arms.pop();
    const { hash: _hash, ...body } = run;
    run.hash = perfProtocolHash(body);
    expect(intactPerfWorkloadRun(run)).toBe(true);
    expect(perfWorkloadRunSeries(run)).toBeNull();
    expect(intactPerfWorkloadRun({ ...run, endedAtMs: NaN })).toBe(false);
  });
  it('honors positive fractional offsets without dispatching before the immutable schedule', async () => {
    const input = plan(); input.groups[0].requests[0].atMs = 20.75;
    const run = await collectPerfWorkloadRun(input, deps());
    expect(run.status).toBe('collected');
    for (const arm of run.groups[0].arms) expect(arm.requests[0].startedAtMs).toBeGreaterThanOrEqual(20.75);
    expect(perfWorkloadRunSeries(run)).not.toBeNull();
  });
  it('retains undispatched pairs on missing preparation or concurrent overload', async () => {
    const missing = await collectPerfWorkloadRun(plan(), { ...deps(), prepare: async () => { throw new Error('missing'); } });
    expect(missing.status).toBe('unknown');
    expect(missing.groups[0].arms[0].requests[0].outcome).toBe('not-dispatched');
    const overloaded = plan('/slow');
    overloaded.groups[0].requests.push({ ...overloaded.groups[0].requests[0], id: 'pair-2' });
    const run = await collectPerfWorkloadRun(overloaded, deps());
    expect(run.status).toBe('unknown');
    expect(run.groups[0].arms.every(row => row.requests.map(request => request.id).join(',') === 'pair-1,pair-2')).toBe(true);
    expect(run.groups[0].arms[0].requests[1].outcome).toBe('not-dispatched');
  });
  it('prepares every cold request independently and pins the plan before any await', async () => {
    const input = plan(); input.groups[0].stratum = 'cold';
    const prepared: string[] = [];
    const run = await collectPerfWorkloadRun(input, { ...deps(), prepare: async context => {
      prepared.push(`${context.arm}:${context.requestId}`);
      input.groups[0].requests[0].path = '/wrong';
      return { evidenceRef: `synthetic-reset:${context.requestId}` };
    } });
    expect(prepared).toEqual(['b:pair-1', 'a:pair-1']);
    expect(run.plan.groups[0].requests[0].path).toBe('/ok');
    expect(run.groups[0].arms[0].requests[0].preparation).toEqual({ evidenceRef: 'synthetic-reset:pair-1' });
  });
  it('refuses candidate collection before touching runtime without retained pretrial proof', async () => {
    const input = plan(); input.phase = 'candidate';
    await expect(collectPerfWorkloadRun(input, { captureManifest: async () => { throw new Error('must not run'); },
      prepare: async () => { throw new Error('must not run'); } })).rejects.toThrow('retained preregistration');
  });
  it('rejects mismatched/cross-origin schedules before performing requests', async () => {
    for (const mutate of [
      (p: PerfWorkloadRunPlan) => { p.groups[0].requests[0].path = '//other-host/path'; },
      (p: PerfWorkloadRunPlan) => { p.groups[0].requests[0].atMs = 159; },
      (p: PerfWorkloadRunPlan) => { p.groups[0].armOrder = ['a', 'a']; },
    ]) {
      const input = plan(); mutate(input);
      await expect(collectPerfWorkloadRun(input, deps())).rejects.toThrow('invalid workload');
    }
  });
});
