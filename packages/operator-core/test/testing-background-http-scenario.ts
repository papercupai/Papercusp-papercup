/** Real private HTTP/PG journey for one directly detached dirty test. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadHarnessRegistry, saveHarnessRegistry } from '../lib/harness-registry';

type Options = { workspace: string; harness: string; base: string;
  headers: Record<string, string>; evidenceDir: string; root: string };

export async function measureTestingBackgroundScenario(o: Options) {
  assert.match(o.workspace, /^test-runtime-/);
  const corpus = join(o.evidenceDir, 'dirty-corpus');
  await mkdir(corpus);
  await mkdir(join(corpus, '.git'));
  await symlink(join(o.root, 'node_modules'), join(corpus, 'node_modules'), 'dir');
  await writeFile(join(corpus, 'package.json'), JSON.stringify({ private: true, type: 'module', workspaces: [] }));
  await writeFile(join(corpus, 'vitest.config.ts'), 'export default { test: { maxWorkers: 1 } };\n');
  const marker = join(corpus, 'executions.txt');
  const source = "import { it, expect } from 'vitest';\nimport { appendFileSync } from 'node:fs';\n" +
    "it('dirty fixture', () => { appendFileSync(" + JSON.stringify(marker) + ", 'once\\n'); expect(41 + 1).toBe(42); });\n";
  const file = 'dirty.integration.test.ts';
  await writeFile(join(corpus, file), source);
  const rootHarnessSlug = o.workspace + '-background';
  const registry = await loadHarnessRegistry(o.workspace, { fresh: true });
  await saveHarnessRegistry({ ...registry, projects: [...registry.projects,
    { slug: rootHarnessSlug, path: corpus, hive_slug: o.workspace }] }, o.workspace);
  let index = 0;
  const call = async (name: string, args: object) => {
    const response = await fetch(o.base + '/api/agent-mcp/run-tool', {
      method: 'POST', headers: o.headers, signal: AbortSignal.timeout(50_000),
      body: JSON.stringify({ name, harness: o.harness, args,
        callerSid: 'private-background-' + o.workspace, confirmed: true }),
    });
    const envelope = await response.json() as any;
    await writeFile(join(o.evidenceDir, `background-request-${index++}.json`), JSON.stringify({ name, args,
      status: response.status, envelope }));
    assert.equal(response.status, 200);
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    assert.notEqual(envelope.result?.isError, true, JSON.stringify(envelope));
    if (envelope.result?.structuredContent) return envelope.result.structuredContent;
    const text = envelope.result?.content?.filter((part: any) => part.type === 'text' && part.text.trim().startsWith('{'));
    assert.equal(text?.length, 1, JSON.stringify(envelope));
    return JSON.parse(text[0].text);
  };
  const accepted = await call('testing:run', { harness: o.harness, rootHarnessSlug, files: [file],
    background: true, cleanupReserveMs: 10_000, testNamePattern: 'dirty fixture' });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.mode, 'background');
  assert.equal(accepted.status, 'pending');
  assert.equal(typeof accepted.detachedRunId, 'string');
  assert.equal(accepted.detachedDurable, true);
  assert.equal(accepted.passed, undefined, 'launch acceptance must not report a test verdict');
  let terminal: any;
  // The product's ordinary task budget includes the detached core's startup.
  // Derive observation from that anchored deadline rather than a second clock.
  const end = accepted.deadline.taskDeadlineAtMs + 15_000;
  while (Date.now() < end) {
    const status = await call('testing:run-status', { runId: accepted.detachedRunId });
    if (status.snapshot && status.snapshot.status !== 'running') { terminal = status.snapshot; break; }
    await delay(500);
  }
  await writeFile(join(o.evidenceDir, 'background-terminal.json'), JSON.stringify(terminal ?? null));
  const result = (terminal?.output ?? '').split('\n').map((line: string) => {
    try { return JSON.parse(line); } catch { return null; }
  }).find((value: any) => value?.artifacts?.directory);
  if (result?.artifacts?.directory) {
    // The private runtime removes its HOME even when an assertion fails. Keep
    // original router logs and phase receipts before that cleanup can erase them.
    await cp(result.artifacts.directory, join(o.evidenceDir, 'background-core-artifacts'), { recursive: true });
  }
  assert.equal(terminal?.status, 'pass', JSON.stringify(terminal));
  assert.deepEqual((await readFile(marker, 'utf8')).trim().split('\n'), ['once'], 'one request must execute exactly once');
  assert.equal(result?.ok, true, terminal.output);
  const sourcePacket = JSON.parse(await readFile(join(result.artifacts.directory, 'source.json'), 'utf8'));
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  assert.ok(sourcePacket.inputs.some((input: any) => input.path === file && input.sha256 === sourceSha256));
  const manifest = JSON.parse(await readFile(result.artifacts.manifest, 'utf8'));
  assert.equal(manifest.childState, 'closed');
  assert.equal(manifest.cleanup.complete, true);
  assert.equal(manifest.deadline.taskDeadlineAtMs, accepted.deadline.taskDeadlineAtMs);
  const receipt = { accepted, terminal: { runId: terminal.runId, status: terminal.status, taskId: terminal.taskId },
    executions: 1, sourceSha256, artifactDirectory: result.artifacts.directory, cleanupComplete: true };
  await writeFile(join(o.evidenceDir, 'background-http-receipt.json'), JSON.stringify(receipt));
  return receipt;
}
