/** P017/R13: canonical compiler links joined to the real migrated invocation ledger. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { contractFixture, cleanupContractFixtures } from './scoped-contracts.fixture';
import { corroborateRuntimeRegistryBuild, readRuntimeCodeEvidence, runtimeEvidenceForContracts, runtimeRegistrySnapshot,
  type RuntimeLedgerRetention, type RuntimeRegistrySnapshot } from './runtime-code-evidence';
import graphQuery from '../agent-tools/gitnexus/query';

const WS = `test-runtime-code-${process.pid}`;
const START = '2026-10-01T00:00:00.000Z', END = '2026-10-08T00:00:00.000Z';
const BUILD = 'a'.repeat(10);
const complete: RuntimeLedgerRetention = { status: 'complete', start: START, end: END,
  evidenceRef: 'fixture:fully-seeded-window' };
let db: OrgTestDb | undefined;
let snapshot: RuntimeRegistrySnapshot;
let interfaces: Parameters<typeof runtimeRegistrySnapshot>[0];

beforeAll(async () => {
  db = await createOrgTestDb();
  const fixture = contractFixture();
  writeFileSync(join(fixture.service, 'routes.ts'), 'import { defineTool } from "@papercusp/agent-mcp";\n'
    + 'import { readApi } from "./api";\n'
    + 'export const main = defineTool({ name: "service:read", handler: readApi });\n'
    + 'export const alias = defineTool({ name: "service:alias", handler: readApi });\n'
    + 'export function cold() { return 0; }\n'
    + 'export const quiet = defineTool({ name: "service:quiet", handler: cold });\n');
  const report = await fixture.query();
  expect(report.error).toBeNull();
  const repository = report.repositories.find(row => row.harness === 'service')!;
  interfaces = { ...repository, version: repository.sourceFingerprint, pluginName: 'papercusp', buildSha: BUILD };
  snapshot = runtimeRegistrySnapshot(interfaces);
  expect(snapshot.complete).toBe(true);
  const sql = db.adminSql;
  const rows = [
    ['service:read', START, 'ok', WS, 'papercusp', BUILD],
    ['service:alias', '2026-10-03T00:00:00Z', 'ok', WS, 'papercusp', BUILD],
    ['service:read', '2026-10-04T00:00:00Z', 'ok', WS, 'papercusp', BUILD],
    ['service:read', '2026-10-04T01:00:00Z', 'ok', WS, 'papercusp', 'b'.repeat(10)],
    ['service:read', '2026-10-04T02:00:00Z', 'ok', WS, 'papercusp', null],
    ['service:quiet', '2026-10-04T00:00:00Z', 'replayed', WS, 'papercusp', BUILD],
    ['service:quiet', '2026-10-04T00:00:00Z', 'refused', WS, 'papercusp', BUILD],
    ['service:quiet', '2026-10-04T00:00:00Z', 'error', WS, 'papercusp', BUILD],
    ['service:quiet', '2026-10-04T00:00:00Z', 'timeout', WS, 'papercusp', BUILD],
    ['service:quiet', '2026-10-04T00:00:00Z', 'invalid-input', WS, 'papercusp', BUILD],
    ['service:quiet', END, 'ok', WS, 'papercusp', BUILD],
    ['service:quiet', '2026-09-30T23:59:59Z', 'ok', WS, 'papercusp', BUILD],
    ['service:quiet', START, 'ok', `${WS}-other`, 'papercusp', BUILD],
    ['service:quiet', START, 'ok', WS, 'other-plugin', BUILD],
    ['unregistered:tool', START, 'ok', WS, 'papercusp', BUILD],
  ].map(([tool, at, status, workspace, plugin, sha]) => ({ workspace_id: workspace, harness_slug: 'papercusp',
    tool_name: tool, plugin_name: plugin, role: 'operator', spawn_id: 'runtime-code-fixture', window_key: 'fixture', status,
    invoked_at: new Date(at!), serving_build_sha: sha }));
  await sql`INSERT INTO harness_shared.tool_invocations ${sql(rows)}`;
}, 120_000);
afterAll(async () => { vi.restoreAllMocks(); cleanupContractFixtures(); await db?.cleanup(); }, 30_000);

const read = (registry = snapshot, retention: RuntimeLedgerRetention | undefined = complete) =>
  readRuntimeCodeEvidence({ workspaceId: WS, registry, retention, windowEnd: END }, db!.adminSql);
const executed = (report: Awaited<ReturnType<typeof read>>) => report.implementations.find(row => row.tools.includes('service:read'))!;
const quiet = (report: Awaited<ReturnType<typeof read>>) => report.implementations.find(row => row.tools.includes('service:quiet'))!;

describe('runtime-code-evidence canonical registry/invocation join', () => {
  it('marks the compiler-linked handler executed and aggregates aliases once per successful dispatch', async () => {
    const report = await read(), row = executed(report);
    expect(report.error).toBeNull();
    expect(report.window).toEqual({ start: START, end: END, boundary: '[start,end)' });
    expect(report.population).toMatchObject({ workspaceId: WS, registryVersion: snapshot.version,
      buildSha: BUILD, unit: 'successful dispatches per linked implementation' });
    expect(row).toMatchObject({ state: 'executed', tools: ['service:alias', 'service:read'], successfulDispatches: 3,
      otherBuildDispatches: 2, implementation: { path: 'api.ts', line1: 2 }, firstObserved: START,
      lastObserved: '2026-10-04T00:00:00.000Z' });
    expect(report.implementations).toHaveLength(2);
  });

  it('excludes end-boundary, pre-window, failed, replayed, foreign-workspace and foreign-plugin observations', async () => {
    const report = await read();
    expect(quiet(report)).toMatchObject({ state: 'not-observed-in-window', successfulDispatches: 0,
      firstObserved: null, lastObserved: null });
    expect(report.completeness.absenceKnown).toBe(true);
    expect(report.limitations.join(' ')).toContain('never proof of never-executed or dead code');
  });

  it.each(['partial', 'unknown'] as const)('does not turn %s ledger retention into absence', async status => {
    const report = await read(snapshot, { ...complete, status });
    expect(executed(report).state).toBe('executed');
    expect(quiet(report).state).toBe('unknown'); expect(report.completeness.absenceKnown).toBe(false);
  });

  it('defaults absent retention evidence to unknown, never inferring it from surviving rows', async () => {
    const report = await readRuntimeCodeEvidence({ workspaceId: WS, registry: snapshot, windowEnd: END }, db!.adminSql);
    expect(report.completeness.retention.status).toBe('unknown'); expect(quiet(report).state).toBe('unknown');
  });

  it.each([
    { ...complete, start: '2026-10-02T00:00:00Z' },
    { ...complete, end: '2026-10-07T00:00:00Z' },
    { ...complete, evidenceRef: null },
  ])('requires retained coverage and evidence for the whole declared window', async retention => {
    expect(quiet(await read(snapshot, retention)).state).toBe('unknown');
  });

  it('preserves missing, dynamic and truncated registration evidence as unknown', async () => {
    const registration = interfaces.interfaces.registrations[0]!;
    for (const changed of [
      { ...interfaces.interfaces, truncated: true },
      { ...interfaces.interfaces, status: 'unknown' as const },
      { ...interfaces.interfaces, registrations: [...interfaces.interfaces.registrations, { ...registration, name: null }] },
      { ...interfaces.interfaces, registrations: [...interfaces.interfaces.registrations, { ...registration, implementation: null }] },
      { ...interfaces.interfaces, registrations: [...interfaces.interfaces.registrations, { ...registration, factoryAuthority: 'unverified' as const }] },
    ]) {
      const registry = runtimeRegistrySnapshot({ ...interfaces, interfaces: changed });
      expect(registry.complete).toBe(false);
      expect((await read(registry)).implementations.every(row => row.state === 'unknown')).toBe(true);
    }
  });

  it('refuses stale fingerprints and does not assign a known call to an unknown loaded source version', async () => {
    expect(runtimeRegistrySnapshot({ ...interfaces, version: 'f'.repeat(64) }).complete).toBe(false);
    const report = await read({ ...snapshot, buildSha: null });
    expect(executed(report)).toMatchObject({ state: 'unknown', successfulDispatches: 0, otherBuildDispatches: 5 });
    expect(quiet(report).state).toBe('unknown');
  });

  it('does not attribute a same-name registry collision to either implementation', async () => {
    const other = snapshot.links.find(row => row.tool === 'service:quiet')!;
    const report = await read({ ...snapshot, links: [...snapshot.links, { ...other, tool: 'service:read' }] });
    expect(report.implementations.every(row => row.state === 'unknown')).toBe(true);
    expect(executed(report).reason).toContain('multiple implementations');
  });

  it('returns explicit unknown rows on ledger read failure and rejects invalid window/scope', async () => {
    const failing = { begin: async () => { throw new Error('fixture unavailable'); } } as unknown as OrgTestDb['adminSql'];
    const report = await readRuntimeCodeEvidence({ workspaceId: WS, registry: snapshot, windowEnd: END }, failing);
    expect(report.error).toBe('fixture unavailable'); expect(report.implementations.every(row => row.state === 'unknown')).toBe(true);
    await expect(readRuntimeCodeEvidence({ workspaceId: '', registry: snapshot }, db!.adminSql)).rejects.toThrow('workspace');
    await expect(readRuntimeCodeEvidence({ workspaceId: WS, registry: snapshot, windowEnd: 'invalid' }, db!.adminSql)).rejects.toThrow('windowEnd');
  });

  it('bounds the registry population instead of silently returning a partial census', async () => {
    const report = await read({ ...snapshot, links: Array.from({ length: 501 }, (_, i) => ({ ...snapshot.links[0]!, tool: `service:${i}` })) });
    expect(report.error).toContain('500-tool'); expect(report.completeness.query).toBe(false);
    expect(report.implementations.every(row => row.state === 'unknown')).toBe(true);
  });

  it('corroborates actual committed source bytes against a loaded build and refuses missing/mismatched versions', async () => {
    const run = promisify(execFile);
    const { stdout: sha } = await run('git', ['rev-parse', 'HEAD']);
    const { stdout: source } = await run('git', ['show', `${sha.trim()}:package.json`]);
    const files = [{ path: 'package.json', contentHash: createHash('sha256').update(source).digest('hex'),
      language: 'json', representation: 'full-source' as const }];
    expect(await corroborateRuntimeRegistryBuild(process.cwd(), files, sha.trim())).toBe(sha.trim());
    expect(await corroborateRuntimeRegistryBuild(process.cwd(), [{ ...files[0]!, contentHash: 'f'.repeat(64) }], sha.trim())).toBeNull();
    expect(await corroborateRuntimeRegistryBuild(process.cwd(), files, null)).toBeNull();
  });

  it('keeps opt-in public contract evidence authorized and unrelated repository traffic explicitly unknown', async () => {
    const fixture = contractFixture();
    const args = graphQuery.args.parse({ op: 'contracts', harnesses: ['service'], runtime_evidence: true });
    const denied = await graphQuery.handler(args, { ...fixture.ctx, workspaceId: 'foreign' } as never) as { data: { error: string } };
    expect(denied.data.error).toContain('workspace');
    const report = await fixture.query();
    const evidence = await runtimeEvidenceForContracts(report, fixture.service);
    expect(evidence.repositories).toEqual([]);
    expect(evidence.unknownRepositories).toHaveLength(2);
    expect(evidence.unknownRepositories[0]!.reason).toContain('association is unmeasured');
  }, 60_000);
});
