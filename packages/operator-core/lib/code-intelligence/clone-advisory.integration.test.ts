import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupPlanPgFixture, type PlanPgFixture } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import { cloneAdvisoryLookup, snapshotCloneLeg } from './clone-advisory';
import { codeIntelPushText, commitPushFacts, type PushCall } from './push-channel';
import { collectCloneEdits, editedPathsFor, postInjection } from '../../../../apps/operator/scripts/hooks/inject/core.mjs';

import { cloneAdvisoryFixture as fixture } from './__fixtures__/clone-advisory-fixture';

const input = (calls: PushCall[]) => ({ owner: 'clone-agent', workspace: 'test-workspace', calls });

describe('P006 native hook to issued PG ledger', () => {
  let fx: PlanPgFixture, root: string;
  const prepared = fixture();
  beforeAll(async () => {
    fx = await setupPlanPgFixture({ isolated: true });
    root = await mkdtemp(join(tmpdir(), 'clone-native-'));
    await Promise.all(Object.entries(prepared.sources).map(([path, text]) => writeFile(join(root, path), text)));
    // Connect the app pool before the existing channel's 250ms wall starts.
    await commitPushFacts({ owner: 'clone-warmup', workspace: fx.workspaceId, calls: [] }, prepared.snapshot,
      [], 1500, new AbortController().signal);
  }, 180_000);
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); await fx?.dispose(); });

  it.each(['Edit', 'Write', 'MultiEdit', 'apply_patch'])('delivers %s once and records its exact issued identity', async tool => {
    const owner = `clone-native-${tool}`;
    const replay = async (path: string) => {
      const toolInput = tool === 'apply_patch' ? `*** Begin Patch\n*** Update File: ${path}\n@@\n*** End Patch` : { file_path: path };
      const call = { tool, toolInput: typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput),
        toolResponse: '', editedPaths: editedPathsFor(tool, toolInput) };
      // The native digest collector reads the real edited bytes; no clone parser is invoked here.
      await collectCloneEdits({ cwd: root, toolCalls: [call] });
      return postInjection('mid-turn', { owner, cwd: root, workspace: fx.workspaceId,
        harness: 'papercusp', client: 'codex', toolCalls: [call] }, {
        env: { PAPERCUSP_MID_TURN_CONTEXT: 'on' },
        fetchImpl: (async (_url: unknown, init: RequestInit) => {
          const request = JSON.parse(init.body as string);
          const text = await codeIntelPushText({ owner, workspace: fx.workspaceId, root, calls: request.toolCalls }, {
            snapshot: async () => prepared.snapshot, enabled: async () => true,
            legs: () => new Map([['clone', snapshotCloneLeg]]), commit: commitPushFacts,
          });
          return { ok: true, json: async () => ({ text }) };
        }) as typeof fetch,
      });
    };
    const delivered = await replay('b.ts');
    expect(delivered?.text).toContain('2 copies; reuse original (a.ts:1)');
    expect(delivered!.text.split('\n').length).toBeLessThanOrEqual(3);
    expect(await replay('b.ts')).toBeNull();
    expect(await replay('none.ts')).toBeNull();
    const rows = await fx.admin`SELECT leg, subject, cited_paths, chars FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${fx.workspaceId} AND owner_id = ${owner}`;
    const digest = prepared.files.find(file => file.path === 'b.ts')!.sha256;
    const expected = cloneAdvisoryLookup(input([{ tool, cloneEdits: [{ path: 'b.ts', sha256: digest }] }]), prepared.snapshot).facts[0]!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ leg: 'clone', subject: expected.subject, cited_paths: expected.citedPaths,
      chars: delivered!.text.length });
  });

  it('suppresses a prepared note when its referenced source has changed', async () => {
    await writeFile(join(root, 'a.ts'), '// changed after indexing');
    const digest = prepared.files.find(file => file.path === 'b.ts')!.sha256;
    const calls = [{ tool: 'Edit', cloneEdits: [{ path: 'b.ts', sha256: digest }] }];
    expect(await codeIntelPushText({ owner: 'clone-stale', workspace: fx.workspaceId, root, calls }, {
      snapshot: async () => prepared.snapshot, enabled: async () => true,
      legs: () => new Map([['clone', snapshotCloneLeg]]), commit: commitPushFacts,
    })).toBe('');
    expect(await fx.admin`SELECT id FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${fx.workspaceId} AND owner_id = 'clone-stale'`).toHaveLength(0);
  });
});
