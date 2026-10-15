import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ProjectedTool } from '@papercusp/tooldef';
import { deriveRecipeAuthority } from '../../recipe-authority-derive';
import logsReadTool from '../logs/read';
import { validateRecipeScriptAgainstCatalog } from './recipe-schema-validation';

const script = readFileSync(new URL('./fixtures/scan-spawner-sidecar-fault-tags.recipe.txt', import.meta.url), 'utf8');
const now = 1_791_350_000;
const checkpoint = (since = '@1791343281') => ({
  ok: true,
  results: [{
    id: 'WI-10005443', ok: true,
    resume: {
      checkpoint: { status: 'available', contentHash: 'current-checkpoint' },
      nextAction: { status: 'available', text: `Scan the exact five tags from ${since} to a fresh explicit UTC endpoint.` },
    },
  }],
});

function run(inputs: Record<string, unknown> = {}, read = checkpoint(), journal: Record<string, unknown> = {}) {
  const logs = vi.fn(async (_args: unknown) => ({ entries: [], journalAvailable: true, truncated: false, ...journal }));
  const context = vm.createContext({
    inputs: { workItemId: 'WI-10005443', checkpoint: read, ...inputs },
    tools: { logs: { read: logs } },
    Date: { now: () => now * 1000 },
  });
  return { result: vm.runInContext(`(async () => { ${script}\n })()`, context) as Promise<Record<string, unknown>>, logs };
}

describe('saved spawner fault scan recipe', () => {
  it('uses the supplied current continuation and a fresh explicit clock endpoint on every run', async () => {
    const first = run();
    expect(await first.result).toMatchObject({
      checkpointBoundary: '@1791343281', checkpointContentHash: 'current-checkpoint',
      window: { since: '@1791343281', until: '@1791350000' }, complete: true,
    });
    const second = run({}, checkpoint('@1791349990'));
    expect(await second.result).toMatchObject({ window: { since: '@1791349990', until: '@1791350000' } });
    expect(second.logs.mock.calls[0]?.[0]).toMatchObject({ since: '@1791349990', until: '@1791350000' });
  });

  it('prefers the current next-scan boundary over historical scan-window epochs', async () => {
    const read = checkpoint();
    read.results[0]!.resume.nextAction.text =
      'Previous scan from @1791200000 to @1791300000; another scan from @1791300000 to @1791343281. Next scan starts at @1791343281.';
    const scan = run({}, read);
    await expect(scan.result).resolves.toMatchObject({ checkpointBoundary: '@1791343281' });
    expect(scan.logs.mock.calls[0]?.[0]).toMatchObject({ since: '@1791343281', until: '@1791350000' });
  });

  it('rejects multiple current next-scan markers before scanning', async () => {
    const read = checkpoint();
    read.results[0]!.resume.nextAction.text =
      'Next scan starts at @1791343281. Next scan starts at @1791349990.';
    const scan = run({}, read);
    await expect(scan.result).rejects.toThrow('exactly one current next-scan marker');
    expect(scan.logs).not.toHaveBeenCalled();
  });

  it('remains runnable under the saved recipe authority rules', async () => {
    expect(await deriveRecipeAuthority(script)).toMatchObject({ unresolved: false, bound: false });
  });

  it('uses exactly the five current spawner fault markers', () => {
    const tagList = script.match(/^const tags = (\[[^\n]+\]);$/m);
    expect(tagList?.[1]).toBeDefined();
    expect(JSON.parse(tagList?.[1] ?? '[]')).toEqual([
      'spawner-socket-error',
      'spawner-socket-peer-eof',
      'spawner-ipc-client-fault',
      'spawner-process-exec-fault',
      'spawner-process-drain',
    ]);
  });

  it('passes saved-recipe preflight against the registered log reader schema', async () => {
    const reader: ProjectedTool = {
      pluginName: 'test', description: 'registered log reader', capabilities: [],
      inputSchema: z.toJSONSchema(logsReadTool.args),
      outputJsonSchema: z.toJSONSchema(logsReadTool.result as z.ZodType),
      expose: { mcp: { name: 'logs:read' } },
      fn: (async () => ({ content: [] })) as never,
    };
    expect(await validateRecipeScriptAgainstCatalog(script, [reader])).toMatchObject({ ok: true, issues: [] });
  });

  it('rejects a continuation from another work item before scanning', async () => {
    const scan = run({ workItemId: 'WI-OTHER' });
    await expect(scan.result).rejects.toThrow('boundary unavailable');
    expect(scan.logs).not.toHaveBeenCalled();
  });

  it('rejects a stale caller boundary before scanning the journal', async () => {
    const scan = run({ since: '@1791294405' });
    await expect(scan.result).rejects.toThrow('does not match the current checkpoint');
    expect(scan.logs).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unknown'])('rejects an %s checkpoint next action', async status => {
    const read = checkpoint();
    read.results[0]!.resume.nextAction.status = status;
    const scan = run({}, read);
    await expect(scan.result).rejects.toThrow('boundary unavailable');
    expect(scan.logs).not.toHaveBeenCalled();
  });

  it.each(['No scan boundary', 'Scan from @1791343281 or since @1791349990'])('rejects missing or ambiguous boundaries: %s', async text => {
    const read = checkpoint();
    read.results[0]!.resume.nextAction.text = text;
    const scan = run({}, read);
    await expect(scan.result).rejects.toThrow('exactly one explicit');
    expect(scan.logs).not.toHaveBeenCalled();
  });

  it.each(['@1791343281', '@1791343000', '@1791350001', '2026-10-07 04:40'])('rejects an invalid endpoint %s before scanning', async until => {
    const scan = run({ until });
    await expect(scan.result).rejects.toThrow();
    expect(scan.logs).not.toHaveBeenCalled();
  });

  it('matches exact bracketed tags, counts collapsed repeats, and identifies active process:exec EOF', async () => {
    const scan = run({}, checkpoint(), {
      entries: [
        { message: '[spawner-socket-error] broken', repeat: 3 },
        { message: '[spawner-socket-peer-eof] {"method":"process:exec"}', ts: 'now', unit: 'bg-host' },
        { message: '[spawner-socket-peer-eof] {"method":"spawn:cancel"}' },
      ],
    });
    const result = await scan.result;
    expect(result.tagCounts).toMatchObject({ 'spawner-socket-error': 3, 'spawner-socket-peer-eof': 2 });
    expect(result.peerExec).toHaveLength(1);
    const pattern = scan.logs.mock.calls[0]?.[0] as { grep: string };
    expect(new RegExp(pattern.grep).test('[spawner-process-drain]')).toBe(true);
    expect(new RegExp(pattern.grep).test('spawner-process-drain')).toBe(false);
    expect(new RegExp(pattern.grep).test('[spawner-server-error]')).toBe(false);
  });

  it.each([
    { truncated: true }, { journalError: 'timed out' }, { journalAvailable: false },
    { entries: null }, { unitsUnknown: ['missing.service'] }, { windowOutsideJournal: { aheadByMs: 1 } },
  ])('marks incomplete journal evidence without claiming a clean scan: %j', async journal => {
    expect(await run({}, checkpoint(), journal).result).toMatchObject({ complete: false });
  });
});
