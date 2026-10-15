/** Read-only R5 proof on the current operator. The maintained e2e reporter
 * records execution-time runtime witnesses from the live-profile selectors.
 * Source navigation and the historical Research tab remain separate claims. */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadBlueprintFromFile } from '@papercusp/orchestrator/blueprint';
import { beforeAll, describe, expect, it } from 'vitest';
import { prepareRuntimeReader } from '../../vitest.e2e.config';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const profilePath = process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE;

describe.skipIf(!profilePath)('Morning AI Research substrate in the live read-only catalog', () => {
  let origin: string;

  beforeAll(async () => {
    const profile = JSON.parse(readFileSync(resolve(root, profilePath!), 'utf8'));
    // This acceptance route is intentionally local staging, with no deployment,
    // worker dispatch, publication, permissions or scheduler mutation.
    expect(profile.origin).toBe('http://127.0.0.1:3170');
    expect(profile.runtimeUnits).toEqual(['hono-host:3170']);
    origin = profile.origin;
    const readRuntime = await prepareRuntimeReader();
    const witness = await readRuntime!();
    expect(witness, 'The actual execution runtime must be independently measurable').not.toBeNull();
    expect(witness?.units).toEqual(['hono-host:3170']);
  });

  async function read(script: string) {
    const { stdout } = await execute('ptool', ['code:run', '--url', origin,
      '--harness', 'papercusp', '--raw', '--json', JSON.stringify({ script })],
    { cwd: root, timeout: 45_000, maxBuffer: 256_000 });
    const result = JSON.parse(stdout);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.partial).not.toBe(true);
    expect(result.childFailures ?? []).toEqual([]);
    expect(result.summary).toBeDefined();
    return result.summary;
  }

  it('serves the existing repo-less research parent and AI child from canonical blueprint source', async () => {
    const observed = await read(`
      const catalog = await tools.blueprint.catalog({ tier: 'builtin' });
      if (!Array.isArray(catalog.blueprints)) throw new Error('Catalog entries unavailable');
      return { blueprints: catalog.blueprints.filter(entry =>
        entry.id === 'research' || entry.id === 'morning-ai-intelligence') };
    `);
    expect(observed.blueprints).toHaveLength(2);
    for (const id of ['research', 'morning-ai-intelligence']) {
      const source = loadBlueprintFromFile(resolve(root,
        `libs/papercusp/packages/harness/blueprints/${id}/blueprint.yaml`)).blueprint;
      const actual = observed.blueprints.find((entry: { id: string }) => entry.id === id);
      expect(actual).toMatchObject({ id, tier: 'builtin', version: source.version,
        workItemKind: 'task', decider: 'research-director', requiresRepo: false });
      expect(actual.error).toBeUndefined();
      expect(source.workItem.kind).toBe('task');
      expect(source.knobs.requiresRepo).toBe(false);
    }
  }, 60_000);

  it('retains the cited substrate history, separate Reports owner and unresolved dedicated-tab provenance', async () => {
    const observed = await read(`
      const record = await tools.conversations.get({ id: 'thread-post:1170339' });
      const post = record.results?.find(entry => entry.id === 'thread-post:1170339')?.post;
      if (!post || typeof post.body !== 'string') throw new Error('Original R5 dossier unavailable');
      return { postId: post.id,
        references: ['harness-blueprint-orchestration-2026-06-03', 'P-017', 'D-016',
          'WI-2874', 'reports-library-2026-09-15'].filter(ref => post.body.includes(ref)),
        unresolved: post.body.includes('old dedicated-tab provenance stays explicitly unresolved'),
        navigationScope: post.body.includes('source evidence, not a native rendered-viewer test'),
        reused: post.body.includes('No parallel engine/store/Research hub was introduced') };
    `);
    expect(observed).toEqual({ postId: 1170339,
      references: ['harness-blueprint-orchestration-2026-06-03', 'P-017', 'D-016',
        'WI-2874', 'reports-library-2026-09-15'],
      unresolved: true, navigationScope: true, reused: true });
  }, 60_000);
});
