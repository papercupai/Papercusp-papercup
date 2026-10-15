/**
 * The production host graph must load under Node's CommonJS loader (tsx) —
 * the loader the installed-PUI restart acceptance uses for its operator child.
 *
 * WI-10004247: `operator-process.mts` forks `apps/operator/bin/host-app` with
 * `--import tsx`, which evaluates the module graph in a different order from
 * Vitest's module runner. `work-items-events.ts` read `CLAIM_STATES_ALLOWLIST`
 * at module-eval time through `work-items.ts`'s re-export while sitting inside
 * that module's import cycle, so the getter ran before `work-items.ts` had
 * required the leaf: the child exited 1 before "ready" on every real-engine
 * restart journey. Nothing in-process could see it — every other test loads the
 * same graph through Vitest's runner, where the order happens to work.
 *
 * This forks the SAME entry with the SAME loader and deliberately omits the
 * isolated workspace env. A graph that loads reaches the fixture's own env
 * guard and exits with that exact message; any other exit is a load failure.
 */
import { fork } from 'node:child_process';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { createTextCollector } from '../child-output';
import { observeAttachResponse, attachOutcomeForSession } from './attach-observation';

const ENV_GUARD = 'The PUI operator fixture requires IPC and an explicitly isolated workspace/database';
const REPO_ROOT = path.resolve(__dirname, '../../../..');

/**
 * Vitest source-maps every `at file:line:col` line of a failing error's stack,
 * message included, and a child frame into a file with a malformed inline map
 * crashes its reporter — which then drops this test's verdict entirely. Keep the
 * child's text readable but no longer shaped like a stack frame.
 */
function asInertText(text: string): string {
  return text.replace(/^(\s*)at /gm, '$1| at ');
}

function loadOperatorFixtureWithoutWorkspace(): Promise<{ code: number | null; signal: string | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'operator-process.mts'), [], {
      cwd: REPO_ROOT,
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        PUI_OPERATOR_FIXTURE_WORKSPACE: '',
        // A test-runner preload must not change the loader under test.
        NODE_OPTIONS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const output = createTextCollector(child.stdout, { maxChars: 16_000 });
    output.attach(child.stderr);
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, output: output.text() }));
  });
}

describe('PUI operator fixture child', () => {
  test('attach precondition ignores stream headers and other sessions but preserves terminal refusals', () => {
    const diagnostics = [
      { args: ['PUI_OPERATOR_ATTACH_RESULT', { requestedAdvSessionId: 7, httpStatus: 200 }] },
      { args: ['PUI_OPERATOR_ATTACH_RESULT', { requestedAdvSessionId: 8, status: 'ok' }] },
    ];
    expect(attachOutcomeForSession(diagnostics, 7)).toBeUndefined();
    const refused = { requestedAdvSessionId: 7, status: 'error', httpStatus: 503, code: 'attached_engine_start_failed' };
    diagnostics.push({ args: ['PUI_OPERATOR_ATTACH_RESULT', refused] });
    expect(attachOutcomeForSession(diagnostics, 7)).toEqual(refused);
  });
  test('observes a streamed terminal refusal while preserving the client response', async () => {
    const wire = 'event: progress\ndata: {"stage":"resume"}\n\n'
      + 'event: launch-result\ndata: {"httpStatus":503,"body":{"status":"error","code":"attached_engine_start_failed"}}\n\n';
    const response = new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
    const results: unknown[] = [];
    await observeAttachResponse(response, (body, status) => results.push({ body, status }));
    expect(results).toEqual([{ status: 503, body: { status: 'error', code: 'attached_engine_start_failed' } }]);
    expect(await response.text()).toBe(wire);
  });

  test('preserves exact resume evidence in a JSON attach response', async () => {
    const body = { status: 'ok', resumed: true, ready: false, advSessionId: 7 };
    const response = Response.json(body);
    const results: unknown[] = [];
    await observeAttachResponse(response, (value, status) => results.push({ body: value, status }));
    expect(results).toEqual([{ body, status: 200 }]);
    expect(await response.json()).toEqual(body);
  });

  test('asInertText keeps the text but stops it parsing as a stack frame', () => {
    const frame = '    at Object.<anonymous> (/repo/lib/work-items-events.ts:211:55)';
    const v8Frame = /^\s*at .*(?:\S:\d+|\(native\))/m;
    expect(v8Frame.test(frame)).toBe(true);
    expect(v8Frame.test(asInertText(frame))).toBe(false);
    expect(asInertText(frame)).toContain('work-items-events.ts:211:55');
  });

  test('loads the whole production host graph under the CommonJS loader', async () => {
    const result = await loadOperatorFixtureWithoutWorkspace();
    expect(asInertText(result.output), 'the child must reach its own env guard, not die while loading').toContain(
      ENV_GUARD,
    );
    expect(result).toMatchObject({ code: 1, signal: null });
  }, 240_000);
});
