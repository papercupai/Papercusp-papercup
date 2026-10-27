/**
 * The mid-turn digest must classify the call a `tools:invoke` wrapper dispatched
 * (code-intel-delivery-and-outcomes-2026-10-26#P-002). Measured 2026-10-27: 392 of
 * 772 `testing:run` calls in 36h arrived as `mcp__papercusp-su__tools_invoke`, and
 * the client built no `incidentResult` for any of them, so the server's incident
 * leg never saw an observed failure from that half. The server's own
 * normalizePushCall cannot recover it: by then the input and response are clamped
 * to 400 chars and the JSON no longer parses.
 *
 * Lives beside core.mjs on purpose: test selection is by workspace, so a test in
 * another package would not run when this hook changes.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const core = await import(path.join(HERE, '..', 'core.mjs'));
const omp = await import(path.join(HERE, '..', 'adapters', 'omp.mjs'));

const FAILED_FILE = 'packages/operator-core/lib/code-intelligence/push-channel.test.ts';
const PASSED_FILE = 'packages/operator-core/lib/code-intelligence/code-intel-canary.test.ts';

/** A testing:run result body large enough that the 400-char clamp truncates it. */
const runBody = (failing: boolean) => ({
  ok: !failing,
  mode: 'run',
  byFile: {
    [FAILED_FILE]: failing ? { status: 'fail', failed: 2, passed: 30, runId: 4242 } : { status: 'pass', failed: 0, passed: 32 },
    [PASSED_FILE]: { status: 'pass', failed: 0, passed: 9 },
  },
  summary: 'x'.repeat(600),
});

const contentBlocks = (body: unknown) => [
  { type: 'text', text: JSON.stringify(body) },
  { type: 'text', text: 'See also: testing:runs (read the ledger)' },
];

const wrappedInput = { name: 'testing:run', args: { files: [FAILED_FILE, PASSED_FILE] } };

describe('unwrapInvokedCall', () => {
  it('returns the inner call for the mangled and colon wrapper names, object or JSON input', () => {
    for (const tool of ['mcp__papercusp-su__tools_invoke', 'tools:invoke', 'tools_invoke']) {
      expect(core.unwrapInvokedCall(tool, wrappedInput)).toEqual({ tool: 'testing:run', toolInput: wrappedInput.args });
      expect(core.unwrapInvokedCall(tool, JSON.stringify(wrappedInput)))
        .toEqual({ tool: 'testing:run', toolInput: wrappedInput.args });
    }
  });

  it('leaves non-wrapper calls and unusable wrapper inputs unchanged', () => {
    expect(core.unwrapInvokedCall('mcp__papercusp-su__testing_run', wrappedInput.args))
      .toEqual({ tool: 'mcp__papercusp-su__testing_run', toolInput: wrappedInput.args });
    expect(core.unwrapInvokedCall('mcp__x__mytools_invoke_log', wrappedInput))
      .toEqual({ tool: 'mcp__x__mytools_invoke_log', toolInput: wrappedInput });
    for (const input of [{ args: {} }, { name: '' }, '{"name":', null, ['testing:run']]) {
      expect(core.unwrapInvokedCall('tools:invoke', input)).toEqual({ tool: 'tools:invoke', toolInput: input });
    }
  });

  it('unwraps one level only', () => {
    const nested = { name: 'tools:invoke', args: wrappedInput };
    expect(core.unwrapInvokedCall('tools:invoke', nested)).toEqual({ tool: 'tools:invoke', toolInput: wrappedInput });
  });
});

describe('incidentResultFor', () => {
  it('reads a top-level content-block array the same as { content }', () => {
    const expected = { byFile: { [FAILED_FILE]: { status: 'fail', failed: 1, runId: 4242 } } };
    expect(core.incidentResultFor('testing:run', contentBlocks(runBody(true)))).toEqual(expected);
    expect(core.incidentResultFor('testing:run', { content: contentBlocks(runBody(true)) })).toEqual(expected);
  });

  it('never reports a passing run or a non-test tool', () => {
    expect(core.incidentResultFor('testing:run', contentBlocks(runBody(false)))).toBeNull();
    expect(core.incidentResultFor('capability:bash', contentBlocks(runBody(true)))).toBeNull();
  });
});

describe('buildDigest: wrapped calls', () => {
  it('derives incidentResult from a wrapped testing:run and ships the inner tool name', () => {
    const [entry] = core.buildDigest([{
      tool: 'mcp__papercusp-su__tools_invoke',
      toolInput: wrappedInput,
      toolResponse: contentBlocks(runBody(true)),
    }]);
    expect(entry.tool).toBe('testing:run');
    expect(entry.incidentResult).toEqual({ byFile: { [FAILED_FILE]: { status: 'fail', failed: 1, runId: 4242 } } });
    // The clamped toolInput now carries the inner args, not the wrapper.
    expect(JSON.parse(entry.toolInput)).toEqual(wrappedInput.args);
    // The clamped response alone is unparseable: incidentResult is the only carrier.
    expect(entry.toolResponse.length).toBe(400);
    expect(() => JSON.parse(entry.toolResponse)).toThrow();
  });

  it('keeps the same digest for a direct call (no behaviour change)', () => {
    const [entry] = core.buildDigest([{
      tool: 'mcp__papercusp-su__testing_run',
      toolInput: wrappedInput.args,
      toolResponse: { content: contentBlocks(runBody(true)) },
    }]);
    expect(entry.tool).toBe('mcp__papercusp-su__testing_run');
    expect(entry.incidentResult?.byFile?.[FAILED_FILE]?.status).toBe('fail');
  });

  it('recovers the edited path of a wrapped capability:edit', () => {
    const [entry] = core.buildDigest([{
      tool: 'mcp__papercusp-su__tools_invoke',
      toolInput: { name: 'capability:edit', args: { file_path: 'apps/x.ts', old_string: 'a', new_string: 'b' } },
      toolResponse: 'ok',
    }]);
    expect(entry.tool).toBe('capability:edit');
    expect(entry.editedPaths).toEqual(['apps/x.ts']);
    expect(entry.editedPath).toBe('apps/x.ts');
  });

  it('builds no incidentResult for a wrapped passing run', () => {
    const [entry] = core.buildDigest([{
      tool: 'tools:invoke', toolInput: wrappedInput, toolResponse: contentBlocks(runBody(false)),
    }]);
    expect(entry.tool).toBe('testing:run');
    expect(entry).not.toHaveProperty('incidentResult');
  });
});

describe('omp adapter: wrapped calls', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.PAPERCUSP_SID; process.env.PAPERCUSP_SID = 'su-test-owner'; });
  afterEach(() => {
    if (saved === undefined) delete process.env.PAPERCUSP_SID;
    else process.env.PAPERCUSP_SID = saved;
  });

  it('classifies the inner testing:run and carries its incidentResult', () => {
    const parsed = omp.parse('mid-turn', {
      message: { content: [{ type: 'toolCall', id: 'c1', name: 'tools_invoke', arguments: wrappedInput }] },
      toolResults: [{ toolCallId: 'c1', toolName: 'tools_invoke', content: contentBlocks(runBody(true)) }],
    }) as { toolCalls: Array<Record<string, any>> };
    const [entry] = parsed.toolCalls;
    expect(entry.tool).toBe('testing:run');
    expect(entry.incidentResult).toEqual({ byFile: { [FAILED_FILE]: { status: 'fail', failed: 1, runId: 4242 } } });
    expect(JSON.parse(entry.toolInput)).toEqual(wrappedInput.args);
  });
});
