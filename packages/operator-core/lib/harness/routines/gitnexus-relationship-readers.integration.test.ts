import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { analyzeCliPath, gitnexusMetaPath } from './gitnexus-reindex-action';

// EI-24827431110263906: File nodes stayed visible while CodeRelation binding
// intermittently failed. Exercise both syntaxes and independent MCP readers;
// an aggregate File count alone cannot establish relationship visibility.
// By default this owns a disposable index. An explicitly supplied root + repo
// selects an existing index for a bounded, read-only investigation, never analyze.
it('keeps relationship visibility consistent across concurrent readers of one pinned index', async () => {
  const existingRoot = process.env.GITNEXUS_RELATIONSHIP_ROOT;
  const existingRepo = process.env.GITNEXUS_RELATIONSHIP_REPO;
  if (Boolean(existingRoot) !== Boolean(existingRepo)) {
    throw new Error('Supply both GITNEXUS_RELATIONSHIP_ROOT and GITNEXUS_RELATIONSHIP_REPO');
  }
  const root = existingRoot ? resolve(existingRoot) : mkdtempSync(join(tmpdir(), 'gitnexus-rel-readers-'));
  const repo = existingRepo ?? `relationship-readers-${process.pid}`;
  const cli = analyzeCliPath();
  const backendPath = join(dirname(cli), '..', 'mcp', 'local', 'local-backend.js');
  const poolPath = join(dirname(cli), '..', 'core', 'lbug', 'pool-adapter.js');
  const sourceHashes = Object.fromEntries([cli, backendPath, poolPath].map(path =>
    [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
  const startedAt = new Date().toISOString();
  const env = Object.fromEntries(Object.entries({
    ...process.env,
    ...(!existingRoot ? { GITNEXUS_REGISTRY_PATH: join(root, 'registry.json') } : {}),
  }).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const readers: Array<{ client: Client; transport: StdioClientTransport }> = [];
  const typed = "MATCH (a:File)-[r:CodeRelation]->(b:File) WHERE r.type = 'IMPORTS' RETURN count(r) AS n";
  const typeless = "MATCH (a:File)-[r]->(b:File) WHERE r.type = 'IMPORTS' RETURN count(r) AS n";
  const fileQuery = 'MATCH (f:File) RETURN count(f) AS n';
  const observations: Array<{ pid: number | null; statement: string; count: number }> = [];
  const count = async (reader: typeof readers[number], statement: string): Promise<number> => {
    const result = await reader.client.callTool({ name: 'cypher', arguments: { repo, statement } });
    const body = (result.content as Array<{ type: string; text?: string }>)
      .filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
    if (result.isError) throw new Error(`Reader ${reader.transport.pid}: ${statement}: ${body}`);
    const cell = /\|\s*(\d+)\s*\|/.exec(body);
    if (!cell) throw new Error(`Reader ${reader.transport.pid} returned no count: ${body.slice(-1000)}`);
    const value = Number(cell[1]);
    observations.push({ pid: reader.transport.pid, statement, count: value });
    return value;
  };
  try {
    if (!existingRoot) {
      execFileSync('git', ['init', '-q', root], { timeout: 10_000 });
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'dependency.ts'), 'export function dependency() { return 1; }\n');
      writeFileSync(join(root, 'src', 'caller.ts'),
        "import { dependency } from './dependency';\nexport function caller() { return dependency(); }\n");
      execFileSync(process.execPath, [cli, 'analyze', root, '--skip-agents-md', '--name', repo, '--force'],
        { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    }
    const metaPath = gitnexusMetaPath(root);
    const metaBefore = readFileSync(metaPath, 'utf8');
    const meta = JSON.parse(metaBefore);
    expect(meta.indexedAt).toEqual(expect.any(String));
    for (let i = 0; i < 2; i++) {
      const transport = new StdioClientTransport({
        command: process.execPath, args: [cli, 'mcp'], cwd: root, env, stderr: 'pipe',
      });
      const client = new Client({ name: `gitnexus-relationship-reader-${i}`, version: '1.0.0' });
      const reader = { client, transport };
      readers.push(reader);
      await client.connect(transport);
      const listed = await client.callTool({ name: 'list_repos', arguments: { limit: 200 } });
      const listing = (listed.content as Array<{ type: string; text?: string }>)
        .filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
      if (listed.isError) throw new Error(`Reader registry error: ${listing}`);
      // Same JSON/guidance boundary used by gen-graph-dependency-snapshot.mjs.
      const registered = JSON.parse(listing.split('\n\n---\n')[0]).repositories
        .find((entry: { name: string }) => entry.name === repo);
      expect(registered).toMatchObject({ path: root, indexedAt: meta.indexedAt });
      expect(registered.lastCommit ?? null).toBe(meta.lastCommit ?? null);
    }
    expect(readers[0].transport.pid).not.toBeNull();
    expect(readers[1].transport.pid).not.toBeNull();
    expect(readers[0].transport.pid).not.toBe(readers[1].transport.pid);
    const fileCounts = await Promise.all(readers.map(reader => count(reader, fileQuery)));
    expect(fileCounts[0]).toBeGreaterThan(0);
    expect(fileCounts[1]).toBe(fileCounts[0]);
    const expectedImports = await count(readers[0], typed);
    if (existingRoot) expect(expectedImports).toBeGreaterThan(0);
    else expect(expectedImports).toBe(1);
    // Eight simultaneous calls per process target the current eight-connection
    // pool. This bounds the sample; success is not a universal intermittency verdict.
    const batch = await Promise.all(readers.flatMap(reader =>
      Array.from({ length: 8 }, (_, i) => count(reader, i % 2 ? typeless : typed))));
    expect(batch).toEqual(Array(16).fill(expectedImports));
    expect(await count(readers[1], typed.replace("'IMPORTS'", "'NO_SUCH_RELATIONSHIP_CONTROL'"))).toBe(0);
    expect(await Promise.all(readers.map(reader => count(reader, fileQuery)))).toEqual(fileCounts);
    expect(readFileSync(metaPath, 'utf8')).toBe(metaBefore);
    console.log('GITNEXUS_RELATIONSHIP_WITNESS', JSON.stringify({
      root, repo, startedAt, finishedAt: new Date().toISOString(),
      indexedAt: meta.indexedAt, lastCommit: meta.lastCommit ?? null, sourceHashes,
      metaSha256: createHash('sha256').update(metaBefore).digest('hex'),
      cli, readerPids: readers.map(reader => reader.transport.pid), observations,
    }));
  } finally {
    await Promise.all(readers.map(reader => reader.client.close().catch(() => undefined)));
    if (!existingRoot) rmSync(root, { recursive: true, force: true });
  }
}, 300_000);
