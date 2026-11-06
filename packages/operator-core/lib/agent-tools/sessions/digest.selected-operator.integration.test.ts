/**
 * Selected-operator acceptance for sessions:digest.
 *
 * This live journey exercises the configured operator and session ledger; it does not
 * need the shared PostgreSQL fixture used by the digest component integration tests.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, inject, it } from 'vitest';
import type { RecordedRuntimeEnvironment } from '@papercusp/test-config/execution-details';

declare module 'vitest' {
  interface ProvidedContext {
    sessionRecoveryRuntime?: { url: string; runtime: RecordedRuntimeEnvironment | null };
  }
}

// Frozen by plan agent-session-tooling-recovery-2026-10-31, Design. Other
// failure classes belong to the isolated fixtures above; these are rate limits.
const RECOVERY_STOP_REFS = [
  'session_turn:claude:9cafc15a-d92d-4cdf-8b29-bd91b7bb87be:54',
  'session_turn:claude:9cafc15a-d92d-4cdf-8b29-bd91b7bb87be:52',
  'session_turn:claude:38dc8b0f-410d-4640-8124-40644a4b11eb:1',
  'session_turn:claude:243b1919-ee42-4bdd-a35c-3c8d9b9dbd47:1',
  'session_turn:claude:39f66ee4-6095-422b-b81e-f6457d74b404:1',
  'session_turn:claude:9cafc15a-d92d-4cdf-8b29-bd91b7bb87be:50',
  'session_turn:claude:d9da04bd-6273-4962-be44-716a667686e0:1',
  'session_turn:claude:96eb151a-b11d-4588-90f9-bb4824b7126f:1',
  'session_turn:claude:7aca07d3-81c8-4c91-8208-1813caf8200f:1',
  'session_turn:claude:ad45de10-bc04-4eb5-b974-9883ca431180:1',
  'session_turn:claude:22c44342-f2a4-44ce-98ed-0048004ee1c7:1',
  'session_turn:claude:2eb31622-8b5f-44bf-8bb5-faff7426952b:1',
  'session_turn:claude:a7f49aed-f5e9-4b99-8e70-4543a09958cf:1',
  'session_turn:claude:0ccd8906-315e-4d33-9520-11a8452ffe3c:90',
  'session_turn:claude:6a2b3f32-98bb-474d-a554-123c998b83f7:39',
  'session_turn:claude:1205c31b-3da8-473e-964a-81fe978b97ef:87',
  'session_turn:claude:9cafc15a-d92d-4cdf-8b29-bd91b7bb87be:46',
  'session_turn:claude:1205c31b-3da8-473e-964a-81fe978b97ef:83',
  'session_turn:claude:9cafc15a-d92d-4cdf-8b29-bd91b7bb87be:44',
  'session_turn:claude:6a2b3f32-98bb-474d-a554-123c998b83f7:33',
  'session_turn:claude:1205c31b-3da8-473e-964a-81fe978b97ef:81',
  'session_turn:claude:0ccd8906-315e-4d33-9520-11a8452ffe3c:86',
  'session_turn:claude:0ccd8906-315e-4d33-9520-11a8452ffe3c:84',
  'session_turn:claude:9cafc15a-d92d-4cdf-8b29-bd91b7bb87be:40',
  'session_turn:claude:0ccd8906-315e-4d33-9520-11a8452ffe3c:82',
  'session_turn:claude:1205c31b-3da8-473e-964a-81fe978b97ef:77',
  'session_turn:claude:0ccd8906-315e-4d33-9520-11a8452ffe3c:80',
  'session_turn:claude:1205c31b-3da8-473e-964a-81fe978b97ef:75',
];

const selectedRecovery = inject('sessionRecoveryRuntime');
// A normal isolated-PG run is component evidence only. The two maintained live
// profiles collect the real case; missing history/identity must then fail.
describe.skipIf(!selectedRecovery)('sessions:digest selected-operator acceptance', () => {
  it('supported recovery journey against the selected operator', async () => {
    const selected = selectedRecovery!;
    expect(selected.runtime, 'unknown selected runtime').not.toBeNull();
    expect(selected.runtime!.fingerprint).toBeTruthy();
    const target = new URL(selected.url);
    expect(target.protocol).toBe('http:');
    expect(['127.0.0.1', 'localhost']).toContain(target.hostname);
    expect(['3170', '3070']).toContain(target.port);
    expect(selected.runtime!.units).toEqual([`hono-host:${target.port}`]);
    expect(process.env.PAPERCUSP_SID, 'retain the authenticated calling session').toBeTruthy();
    const expected = [...RECOVERY_STOP_REFS].sort();
    expect(createHash('sha256').update(expected.join('\n')).digest('hex'))
      .toBe('55d490b5049d30f5c6d502777b9196f925185360616e3849a636454031bc5ec0');

    const { buildMcpUrl, buildCallToolParams, resolveTokenPaths, requireServingGeneration,
      listAllTools, callToolWithPressureRetry, resultToText, unwrapOutputEnvelope } = await import('../../../../../apps/operator/scripts/ptool.mjs');
    const { connectAgentMcp } = await import('../../agent-mcp-client');
    const { CallToolResultSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const bearer = resolveTokenPaths().map((path: string) => {
      try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
    }).find(Boolean);
    expect(bearer, 'authenticated operator credential unavailable').toBeTruthy();
    const started = performance.now();
    const remaining = () => {
      const ms = 120_000 - (performance.now() - started);
      if (ms <= 0) throw new Error('Recovery complete-journey deadline exceeded');
      return Math.ceil(ms);
    };
    const measuredCalls: Array<{ tool: string; args: unknown; elapsedMs: number }> = [];
    const setupTimings: Array<{ phase: string; elapsedMs: number }> = [];
    const measureSetup = async <T>(phase: string, run: () => Promise<T>): Promise<T> => {
      const before = performance.now();
      try {
        return await run();
      } finally {
        setupTimings.push({ phase, elapsedMs: performance.now() - before });
      }
    };
    const health = async () => {
      const response = await fetch(new URL('/api/health', selected.url), { signal: AbortSignal.timeout(remaining()) });
      expect(response.ok).toBe(true);
      const body = await response.json() as { ok?: boolean; sha?: string };
      expect(body.ok).toBe(true);
      expect(body.sha).toMatch(/^[a-f0-9]{7,64}$/);
      return body.sha!;
    };
    const buildSha = await measureSetup('health-before', health);
    const { client } = await measureSetup('mcp-connect', () => connectAgentMcp({
      url: buildMcpUrl(selected.url, { workspace: process.env.PAPERCUSP_TEST_RUN_WORKSPACE,
        harness: 'papercusp', client: process.env.PAPERCUSP_SID, contextTier: 'full' }).href,
      headers: { Authorization: `Bearer ${bearer}` }, timeoutMs: remaining(),
      name: 'session-recovery-acceptance',
    })).catch(error => {
      process.stdout.write('SESSION_RECOVERY_CONNECTION_FAILURE ' + JSON.stringify({
        url: selected.url, buildSha, diagnostic: error.diagnostic ?? { category: 'unknown' },
        setupTimings, elapsedMs: performance.now() - started,
      }) + '\n');
      throw error;
    });
    try {
      const catalog = await measureSetup('tools-list', () =>
        listAllTools(client, { timeoutMs: remaining(), totalTimeoutMs: remaining() }));
      const call = async (tool: string, args: Record<string, unknown>): Promise<any> => {
        const entry = catalog.find((row: { name: string }) => row.name === tool);
        expect(entry, `${tool} unavailable in selected runtime`).toBeTruthy();
        const before = performance.now();
        const wire = await callToolWithPressureRetry(client, buildCallToolParams(tool,
          { ...args, payloadTier: 'full' }, { outputSchema: entry.outputSchema,
            servingGeneration: requireServingGeneration(entry) }), {
              maxAttempts: 3, timeoutMs: remaining(), totalTimeoutMs: remaining(),
            })
          .finally(() => measuredCalls.push({ tool, args, elapsedMs: performance.now() - before }));
        CallToolResultSchema.parse(wire);
        expect(wire.isError, `${tool} returned an MCP error`).not.toBe(true);
        const payload = JSON.parse(resultToText(wire, { raw: true }));
        const decoded = await unwrapOutputEnvelope(payload, {
          readReference: (args: Record<string, unknown>) => call('capability:read', args),
        });
        expect(decoded?.schemaVersion, `${tool} result remained an unreadable output envelope`)
          .not.toBe('papercusp.output-envelope/v1');
        return decoded;
      };
      const query = 'what were agents working on before their accounts hit usage limits?';
      const discovery = await call('tools:find', { query, limit: 3 });
      expect(Array.isArray(discovery.hits), `discovery response: ${JSON.stringify(discovery)}`).toBe(true);
      expect(discovery.hits.slice(0, 3).map((hit: { tool: string }) => hit.tool)).toContain('sessions:digest');
      const inputs = { since: '2026-10-30T00:00:00.000Z', until: '2026-10-31T23:59:59.000Z',
        // Five rows keep the measured response below the result cap while
        // avoiding redundant round trips within the unchanged journey budget.
        stopKinds: ['quota', 'authentication', 'billing', 'rate_limit'], taskMode: 'as-of', limit: 5 };
      // Keep the full recovery evidence through the supported projection;
      // bootstrap and closing display fields repeat data and need no spill.
      const projection = { pick: ['ok', 'hasMore', 'nextCursor', 'coverage',
        'digests[].stopRef', 'digests[].stopKind', 'digests[].stopEvidence', 'digests[].taskMode',
        'digests[].kickoff', 'digests[].kickoffRef', 'digests[].kickoffProvenance',
        'digests[].checkpoint', 'digests[].checkpointRef', 'digests[].checkpointProvenance'] };
      const incidents: any[] = [];
      const pages: any[] = [];
      let cursor: string | undefined;
      let snapshotAt: string | undefined;
      for (let page = 0; page < 168; page++) {
        const result = await call('sessions:digest', { ...inputs, projection, ...(cursor ? { cursor } : {}) });
        expect(result.ok, `digest failure: ${JSON.stringify(result)}`).toBe(true);
        expect(Array.isArray(result.digests)).toBe(true);
        expect(result.coverage, 'unknown indexed coverage').toBeTruthy();
        snapshotAt ??= result.coverage.snapshotAt;
        expect(result.coverage.snapshotAt).toBe(snapshotAt);
        expect(result.coverage.hostOnlyOwners).toBe('not-covered');
        incidents.push(...result.digests);
        pages.push({ coverage: result.coverage, refs: result.digests.map((d: any) => d.stopRef) });
        if (!result.nextCursor) {
          expect(result.hasMore).toBe(false);
          expect(result.coverage.status).toBe('complete-for-indexed-transcript-window');
          break;
        }
        cursor = result.nextCursor;
        // Empty filtered pages still have a valid continuation.
        expect(result.coverage.status).toBe('more-pages');
      }
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.at(-1).coverage.status).toBe('complete-for-indexed-transcript-window');
      expect(incidents.map(row => row.stopRef).sort(), 'retained history differs from the frozen population').toEqual(expected);
      expect(new Set(incidents.map(row => row.stopRef)).size).toBe(incidents.length);
      const references = new Map<string, { text: string; ts: string | null }>();
      const refs = [...new Set(incidents.flatMap(row => [row.stopRef, row.kickoffRef, row.checkpointRef].filter(Boolean)))] as string[];
      // Resolve exact references through the supported reader, in bounded batches.
      for (let offset = 0; offset < refs.length; offset += 6) {
        await Promise.all(refs.slice(offset, offset + 6).map(async ref => {
          const result = await call('sessions:read', { ref, text_limit: 1500 });
          expect(result.ok).toBe(true);
          expect(result.turns).toHaveLength(1);
          expect(result.turns[0].ref).toBe(ref);
          expect(result.turns[0].text).toBeTruthy();
          references.set(ref, result.turns[0]);
        }));
      }
      for (const row of incidents) {
        expect(row.stopKind).toBe('rate_limit');
        expect(row.taskMode).toBe('as-of');
        const stop = references.get(row.stopRef)!;
        expect(stop.text.replace(/\s+/g, ' ')).toContain(row.stopEvidence.replace(/…$/, ''));
        for (const [ref, text, provenance] of [[row.kickoffRef, row.kickoff, row.kickoffProvenance],
          [row.checkpointRef, row.checkpoint, row.checkpointProvenance]]) {
          if (!ref) { expect(provenance).toBe('unknown'); continue; }
          const source = references.get(ref)!;
          expect(source.text.replace(/\s+/g, ' ')).toContain(text.replace(/…$/, ''));
          expect(new Date(source.ts!).getTime()).toBeLessThanOrEqual(new Date(stop.ts!).getTime());
        }
      }
      expect(await measureSetup('health-after', health)).toBe(buildSha);
      const elapsedMs = performance.now() - started;
      expect(elapsedMs).toBeLessThan(120_000);
      process.stdout.write('SESSION_RECOVERY_JOURNEY ' + JSON.stringify({
        url: selected.url, buildSha, runtime: selected.runtime, inputs,
        discovery: { query, hits: discovery.hits.map((hit: any) => hit.tool), servingGeneration: discovery.servingGeneration },
        pages, resolvedReferences: refs, setupTimings, measuredCalls, elapsedMs,
      }) + '\n');
    } finally {
      process.stdout.write('SESSION_RECOVERY_CALL_TIMINGS ' + JSON.stringify({
        url: selected.url, elapsedMs: performance.now() - started, setupTimings, measuredCalls,
      }) + '\n');
      await client.close();
    }
  }, 130_000);
});
