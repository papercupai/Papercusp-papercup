import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
// @ts-ignore -- exercise the same native ESM bootstrap as the maintained HTTP proof.
import { KEY, CANONICAL, PUBLICATION, spawnBlogPostHttpHost } from './blog-post-http-host.mjs';
import { privateBundleRuntimeEnv } from './private-http-workspace-preflight';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function runBundle(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'blog-native-host-')); dirs.push(dir);
  const bundle = join(dir, 'built-host.mjs');
  const guard = join(dir, 'source-guard.mjs');
  writeFileSync(bundle, source);
  writeFileSync(guard, 'process.env.BLOG_SOURCE_GUARD = "active";');
  const env = privateBundleRuntimeEnv({ ...process.env, BLOG_POST_EVIDENCE_DIR: dir,
    NODE_OPTIONS: `--import=tsx --import=${JSON.stringify(guard)} --max-old-space-size=128` });
  const child = spawnBlogPostHttpHost(bundle, { cwd: dir, env }) as ChildProcess;
  let output = '';
  child.stdout!.on('data', (chunk: Buffer) => { output += chunk; });
  child.stderr!.on('data', (chunk: Buffer) => { output += chunk; });
  const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('native host did not exit')); }, 10_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  return { ...result, output, dir };
}

it('loads a built ESM host natively while preserving its source guard, limit, local fetch and vendor assertions', async () => {
  const result = await runBundle(`
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    import { getHeapStatistics } from 'node:v8';
    assert.equal(process.env.BLOG_SOURCE_GUARD, 'active');
    assert.ok(!process.execArgv.some(value => value.includes('tsx')));
    // V8's total includes young space in addition to the 128 MiB old-space cap.
    assert.ok(getHeapStatistics().heap_size_limit < 1024 * 1024 * 1024);
    const server = createServer((_request, response) => response.end('local'));
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    try {
      const local = await fetch('http://127.0.0.1:' + server.address().port);
      assert.equal(await local.text(), 'local');
    } finally { await new Promise(done => server.close(done)); }
    const devto = await fetch('https://dev.to/api/articles', { method: 'POST',
      headers: { 'api-key': ${JSON.stringify(KEY)} }, body: JSON.stringify({ article: {
        title: 'Request proof', body_markdown: '# Synthetic content', published: false,
        canonical_url: ${JSON.stringify(CANONICAL)} } }) });
    assert.equal(devto.status, 201);
    const hashnode = await fetch('https://gql.hashnode.com/', { method: 'POST',
      headers: { authorization: ${JSON.stringify(`Bearer ${KEY}`)} }, body: JSON.stringify({
        query: 'mutation CreateDraft($input: CreateDraftInput!) { createDraft(input: $input) { draft { id } } }',
        variables: { input: { publicationId: ${JSON.stringify(PUBLICATION)}, title: 'Request proof',
          contentMarkdown: '# Synthetic content', originalArticleURL: ${JSON.stringify(CANONICAL)} } } }) });
    assert.equal((await hashnode.json()).data.createDraft.draft.id, 'synthetic-draft');
    console.log('native-host-verified');
  `);
  expect(result, result.output).toMatchObject({ code: 0, signal: null });
  expect(result.output).toContain('native-host-verified');
  const rows = readFileSync(join(result.dir, 'vendor-requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(rows.map(row => row.provider)).toEqual(['devto', 'hashnode']);
  expect(JSON.stringify(rows)).not.toContain(KEY);
});

it.each([
  ['unexpected vendor', `await fetch('https://example.com/')`, 'unexpected external fetch refused'],
  ['wrong credential', `await fetch('https://dev.to/api/articles', { method: 'POST', headers: { 'api-key': 'wrong' } })`, 'AssertionError'],
])('refuses %s before any external request', async (_name, source, failure) => {
  const result = await runBundle(source);
  expect(result, result.output).toMatchObject({ code: 1, signal: null });
  expect(result.output).toContain(failure);
});
