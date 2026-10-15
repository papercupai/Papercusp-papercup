/** Public graph → real compiler → actual HTTP producer and incompatible client. */
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupContractFixtures, contractFixture } from './scoped-contracts.fixture';

afterEach(() => { vi.restoreAllMocks(); cleanupContractFixtures(); });
describe('native P019 actual cross-repository response field change', () => {
  it('exposes the incompatible known consumer through the public interface report before its next HTTP call fails', async () => {
    let readApi = () => ({ value: 'ok' } as Record<string, string>);
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(readApi()));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    try {
      const fixture = contractFixture(port);
      writeFileSync(join(fixture.client, 'client.ts'), `import type { Response } from "../service/api.ts";\nexport async function client() { const response: Response = await (await fetch("http://127.0.0.1:${port}/read")).json(); return response.value.length; }\n`);
      const beforeApi = await import(/* @vite-ignore */ pathToFileURL(join(fixture.service, 'api.ts')).href + '?before');
      readApi = beforeApi.readApi;
      const client = await import(/* @vite-ignore */ pathToFileURL(join(fixture.client, 'client.ts')).href);
      expect(await client.client()).toBe(2);
      const before = await fixture.query(); expect(before.error).toBeNull();
      expect(before.relationships).toContainEqual(expect.objectContaining({ protocol: 'http',
        producer: expect.objectContaining({ harness: 'service' }), consumer: expect.objectContaining({ harness: 'client' }) }));
      expect(before.mismatchedConsumers.some(row => row.code === 2339)).toBe(false);
      writeFileSync(join(fixture.service, 'api.ts'), 'export interface Response { label: string; }\nexport function readApi(): Response { return { label: "ok" }; }\n');
      const afterApi = await import(/* @vite-ignore */ pathToFileURL(join(fixture.service, 'api.ts')).href + '?after');
      readApi = afterApi.readApi;
      const report = await fixture.query(); expect(report.error).toBeNull();
      expect(report.mismatchedConsumers).toContainEqual(expect.objectContaining({ harness: 'client', code: 2339,
        site: expect.objectContaining({ path: 'client.ts' }), message: expect.stringContaining("'value'") }));
      expect(report.repositories[0]!.sourceFingerprint).not.toBe(before.repositories[0]!.sourceFingerprint);
      await expect(client.client()).rejects.toThrow();
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 60_000);
});
