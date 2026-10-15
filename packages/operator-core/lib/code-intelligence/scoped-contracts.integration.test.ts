/** Real public graph handler, registry admission and compiler worker over two repositories. */
import { createHash } from 'node:crypto';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scopedContractQuery, type ScopedContractReport } from './scoped-contracts';
import { firstPartyCallersOffthread } from './first-party-callers-offthread';
import { cleanupContractFixtures, contractFixture } from './scoped-contracts.fixture';
import graphQuery from '../agent-tools/gitnexus/query';

afterEach(() => { vi.restoreAllMocks(); cleanupContractFixtures(); });

describe('native P019 registered cross-repository interface evidence', () => {
  it('joins HTTP, RPC and event candidates with both source versions while preserving runtime and bus uncertainty', async () => {
    const fixture = contractFixture(), report = await fixture.query();
    expect(report.error).toBeNull(); expect(report.status).toBe('measured');
    expect(fixture.registrySpy).toHaveBeenCalledWith('workspace-a', { fresh: true });
    expect(report.relationships.map(row => row.protocol).sort()).toEqual(['event', 'http', 'rpc']);
    for (const row of report.relationships) {
      expect(row).toMatchObject({ producer: { harness: 'service' }, consumer: { harness: 'client' },
        knowledge: 'static-possible', runtimeExecution: 'unknown', middleware: 'unknown' });
      expect(row.producer.contentHash).toMatch(/^[a-f0-9]{64}$/); expect(row.consumer.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(report.relationships.find(row => row.protocol === 'event')?.ambiguous).toBe(true);
    expect(report.repositories.map(row => row.harness)).toEqual(['service', 'client']);
    for (const repo of report.repositories) for (const source of repo.sources) {
      const root = repo.harness === 'service' ? fixture.service : fixture.client;
      expect(source.contentHash).toBe(createHash('sha256').update(readFileSync(join(root, source.path))).digest('hex'));
    }
    expect(JSON.stringify(report)).not.toContain('PRIVATE_CONTRACT_MARKER');
    expect(report.repositories.every(row => row.repositoryId.startsWith('registry:workspace-a:'))).toBe(true);
    expect(report.repositories[0]!.interfaces.registrations[0]?.responseFields).toEqual([{ name: 'value', type: 'string', optional: false }]);
  }, 60_000);

  it('rejects workspace and harness expansion through the actual public handler before registry reads', async () => {
    const fixture = contractFixture();
    const args = graphQuery.args.parse({ op: 'contracts', harnesses: ['service', 'client'] });
    for (const ctx of [{ ...fixture.ctx, workspaceId: 'workspace-b' }, { ...fixture.ctx, harnessSlug: 'client' }]) {
      const result = await graphQuery.handler(args, ctx as never) as { data: ScopedContractReport };
      expect(result.data.error).toBeTruthy(); expect(result.data.relationships).toEqual([]);
    }
    expect(fixture.registrySpy).not.toHaveBeenCalled();
  });

  it('identifies the known consumer after its response field changes and changes the producer source version', async () => {
    const fixture = contractFixture(), before = await fixture.query();
    expect(before.mismatchedConsumers.some(row => row.code === 2339)).toBe(false);
    writeFileSync(join(fixture.service, 'api.ts'), 'export interface Response { label: string; }\nexport function readApi(): Response { return { label: "ok" }; }\n');
    const after = await fixture.query();
    expect(after.error).toBeNull();
    expect(after.mismatchedConsumers).toContainEqual(expect.objectContaining({ harness: 'client', code: 2339,
      site: expect.objectContaining({ path: 'client.ts', line1: 2 }), message: expect.stringContaining("'value'") }));
    expect(after.repositories[0]!.sourceFingerprint).not.toBe(before.repositories[0]!.sourceFingerprint);
  }, 60_000);

  it('does not read an imported or symlinked unadmitted repository', async () => {
    const fixture = contractFixture();
    symlinkSync(join(fixture.secret, 'secret.ts'), join(fixture.client, 'escaped.ts'));
    writeFileSync(join(fixture.client, 'attempt.ts'), 'import { PRIVATE_CONTRACT_MARKER } from "../secret/secret";\nexport const attempt = PRIVATE_CONTRACT_MARKER;\n');
    const worker = vi.fn(firstPartyCallersOffthread);
    const report = await scopedContractQuery({ harnesses: ['service', 'client'] }, fixture.ctx as never,
      { registry: async () => ({ projects: fixture.projects }), worker });
    expect(report.error).toBeNull();
    expect(worker).toHaveBeenCalledTimes(2);
    for (const [job] of worker.mock.calls) expect(job.authorizedReadRoots).toEqual([fixture.service, fixture.client]);
    expect(report.repositories.flatMap(repo => repo.sources).map(source => source.path)).not.toContain('escaped.ts');
    expect(report.mismatchedConsumers).toContainEqual(expect.objectContaining({ harness: 'client', code: 2307,
      site: expect.objectContaining({ path: 'attempt.ts' }) }));
    expect(report.repositories.some(repo => repo.harness === 'secret')).toBe(false);
  }, 60_000);

  it('keeps dynamic names and methods unknown and cannot join another service origin or a local same-name fetch', async () => {
    const fixture = contractFixture();
    writeFileSync(join(fixture.client, 'client.ts'), 'declare const ctx: { dispatchTool(name: string): void }; declare const key: string; ctx.dispatchTool(key);\nfetch("http://127.0.0.1:9999/read");\nconst options = { method: "POST" }; fetch("http://127.0.0.1:8123/read", { ...options });\n');
    writeFileSync(join(fixture.client, 'fake.ts'), 'export function fetch(_url: string) {}\nfetch("http://127.0.0.1:8123/read");\n');
    const report = await fixture.query();
    expect(report.error).toBeNull(); expect(report.relationships).toEqual([]);
    expect(report.candidates).toContainEqual(expect.objectContaining({ protocol: 'rpc', key: null }));
    expect(report.candidates).toContainEqual(expect.objectContaining({ protocol: 'http', method: null }));
    expect(report.candidates).toContainEqual(expect.objectContaining({ protocol: 'http', authority: 'syntax' }));
  }, 60_000);

  it.each(['api.ts', 'tsconfig.json'])('refuses the entire joined snapshot when source or compiler config %s changes between workers', async file => {
    const fixture = contractFixture(); let calls = 0;
    const report = await scopedContractQuery({ harnesses: ['service', 'client'] }, fixture.ctx as never,
      { registry: async () => ({ projects: fixture.projects }), worker: async job => {
        const answer = await firstPartyCallersOffthread(job);
        if (++calls === 2) writeFileSync(join(fixture.service, file), file.endsWith('.json')
          ? '{"compilerOptions":{"strict":false}}' : 'export const changed = true;\n');
        return answer;
      } });
    expect(report.error).toContain('changed'); expect(report.repositories).toEqual([]); expect(report.relationships).toEqual([]);
  }, 60_000);
});
