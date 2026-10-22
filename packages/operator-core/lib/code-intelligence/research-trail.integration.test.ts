import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { harnessRoot } from '@papercusp/harness/paths';
import { setupPlanPgFixture, type PlanPgFixture } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import { codeIntelPushText, CODE_INTEL_PUSH_TURN_CHARS, type PushChannelDeps, type PushInput } from './push-channel';
import type { PushSnapshot } from './push-snapshot';
import { mergeResearchSubjects, persistResearchBatch, readResearchTrail, researchSubjects, RESEARCH_TRAIL_LIMIT, RESEARCH_TRAIL_RETENTION_MS } from './research-trail';
// Exercise the real JavaScript hook adapter through its mid-turn digest contract.
const { parse: parseCodex } = await import(new URL(
  '../../../../apps/operator/scripts/hooks/inject/adapters/codex.mjs', import.meta.url,
).href) as { parse(port: 'mid-turn', event: Record<string, unknown>): { toolCalls: PushInput['calls'] } | null };

let fx: PlanPgFixture;
let root: string;
let snapshot: PushSnapshot;
const harness = 'zzz-research-trail';
const owner = 'zzz-research-owner';
const text = 'export function researched() { return 1; }\n';
const hash = createHash('sha256').update(text).digest('hex');
const input = (patch: Partial<PushInput> = {}): PushInput => ({
  owner, workspace: fx.workspaceId, harness, root, client: 'claude', calls: [], ...patch,
});
beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  const path = join(harnessRoot(), '../../libs/db/sql/1561-code-intel-research-trail.sql');
  const ddl = await readFile(path, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return readFile(path + '.DRAFT', 'utf8');
    throw error;
  });
  await fx.admin.unsafe(ddl);
  root = await mkdtemp(join(tmpdir(), 'research-trail-'));
  await writeFile(join(root, 'code.ts'), text);
  snapshot = { commit: 'fixture', generatedAt: new Date().toISOString(), generatedMs: Date.now(),
    importers: new Map(), hashes: new Map([['code.ts', hash]]), symbols: new Map([['researched', [{ id: 'fixture:researched', name: 'researched',
      path: 'code.ts', line: 1, column: 17, sha256: hash, signature: 'researched()', aliases: [], callers: [] }]]]) };
}, 180_000);
afterAll(async () => { await fx?.dispose(); if (root) await rm(root, { recursive: true, force: true }); });

describe('caller-session research replay through the push boundary', () => {
  it('captures Read and resolved Grep subjects even when no push fits, with stable owner isolation', async () => {
    const batch = input({ calls: [{ tool: 'Read', toolInput: { file_path: join(root, 'code.ts') } },
      { tool: 'Grep', toolInput: { pattern: 'researched' } }] });
    let capture: Promise<void> | undefined;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps: PushChannelDeps = { research: i => {
      capture = researchSubjects(i, snapshot).then(subjects => persistResearchBatch(i, subjects));
      return capture;
    },
      snapshot: async () => null, enabled: async () => false, legs: () => new Map(), commit: async () => '' };
    try {
      expect(await codeIntelPushText(batch, CODE_INTEL_PUSH_TURN_CHARS, deps)).toBe('');
      // The response deadline is not a persistence receipt. Await the actual
      // write, including a cold pool, before asserting the durable projection.
      expect(capture).toBeDefined();
      await capture;
      expect(warning.mock.calls.every(([message]) => String(message).includes('code-intel-research-trail'))).toBe(true);
    } finally { warning.mockRestore(); }
    expect((await readResearchTrail(fx.workspaceId, owner, harness)).subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'path', requested: 'code.ts' }),
      expect.objectContaining({ kind: 'symbol', requested: 'researched', path: 'code.ts', symbolId: 'fixture:researched' }),
    ]));
    for (const [ws, who, hive] of [[fx.workspaceId, 'another-owner', harness],
      ['another-workspace', owner, harness], [fx.workspaceId, owner, 'another-harness']]) {
      expect(await readResearchTrail(ws!, who!, hive!)).toEqual({ subjects: [], reason: 'trail not captured for this client' });
    }
  });
  it('bounds a slow capture without cancelling its eventual persistence operation', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let finish!: () => void;
    const capture = new Promise<void>(resolve => { finish = resolve; });
    const deps: PushChannelDeps = { research: () => capture, snapshot: async () => null,
      enabled: async () => false, legs: () => new Map(), commit: async () => '' };
    try {
      const response = codeIntelPushText(input({ calls: [{ tool: 'Read', toolInput: { file_path: 'code.ts' } }] }), 0, deps);
      await vi.advanceTimersByTimeAsync(101);
      expect(await response).toBe('');
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('code-intel-research-trail'));
      finish();
      await capture;
    } finally { finish(); warning.mockRestore(); vi.useRealTimers(); }
  });
  it('uses the actual Codex per-call adapter and distinguishes empty capture from no capture', async () => {
    const parsed = parseCodex('mid-turn', { tool_name: 'exec_command', tool_input: { cmd: 'cat code.ts', cwd: root },
      tool_response: text, cwd: root });
    expect(parsed).not.toBeNull();
    const batch = input({ owner: 'zzz-codex-owner', client: 'codex', calls: parsed!.toolCalls });
    await persistResearchBatch(batch, await researchSubjects(batch, null));
    expect((await readResearchTrail(fx.workspaceId, batch.owner, harness)).subjects)
      .toEqual([expect.objectContaining({ kind: 'path', requested: 'code.ts' })]);
    await persistResearchBatch(input({ owner: 'zzz-empty-owner', client: 'codex' }), []);
    expect(await readResearchTrail(fx.workspaceId, 'zzz-empty-owner', harness))
      .toEqual({ subjects: [], reason: 'nothing recorded' });
  });
  it('retains both concurrent batches for the same stable owner across carries', async () => {
    const batch = input({ owner: 'zzz-concurrent-owner' });
    await Promise.all(['a.ts', 'b.ts'].map(path => persistResearchBatch(batch,
      [{ kind: 'path', requested: path, path, seenAt: Date.now() }])));
    expect((await readResearchTrail(fx.workspaceId, batch.owner, harness)).subjects.map(s => s.path).sort())
      .toEqual(['a.ts', 'b.ts']);
  });
  it('caps stored subjects, expires old subjects and hides expired capture markers', async () => {
    const now = Date.now();
    const subjects = Array.from({ length: RESEARCH_TRAIL_LIMIT + 2 }, (_, i) =>
      ({ kind: 'path' as const, requested: `${i}.ts`, path: `${i}.ts`, seenAt: now - i }));
    expect(mergeResearchSubjects([{ ...subjects[0]!, seenAt: now - RESEARCH_TRAIL_RETENTION_MS }], [], now)).toEqual([]);
    const batch = input({ owner: 'zzz-bounded-owner' });
    await persistResearchBatch(batch, subjects);
    expect((await readResearchTrail(fx.workspaceId, batch.owner, harness)).subjects).toHaveLength(RESEARCH_TRAIL_LIMIT);
    const [stored] = await fx.admin`SELECT jsonb_array_length(subjects) AS n FROM harness_shared.code_intel_research_trails
      WHERE workspace_id=${fx.workspaceId} AND owner_id=${batch.owner} AND harness_slug=${harness}`;
    expect(stored!.n).toBe(RESEARCH_TRAIL_LIMIT);
    await fx.admin`UPDATE harness_shared.code_intel_research_trails SET captured_at=now()-interval '8 days'
      WHERE workspace_id=${fx.workspaceId} AND owner_id=${batch.owner} AND harness_slug=${harness}`;
    expect(await readResearchTrail(fx.workspaceId, batch.owner, harness))
      .toEqual({ subjects: [], reason: 'trail not captured for this client' });
  });
  it('does not treat edits, ambiguous regexes or stale symbol metadata as research identities', async () => {
    expect(await researchSubjects(input({ calls: [{ tool: 'Edit', toolInput: { file_path: 'code.ts' } },
      { tool: 'Grep', toolInput: { pattern: 'researched|other' } }] }), snapshot)).toEqual([]);
    await writeFile(join(root, 'code.ts'), 'export const changed = true;\n');
    expect(await researchSubjects(input({ calls: [{ tool: 'Grep', toolInput: { pattern: 'researched' } }] }), snapshot)).toEqual([]);
  });
});
