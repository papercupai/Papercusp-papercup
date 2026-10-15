/**
 * bash-code-mode-shape.test.ts — EI-20066912585022608.
 *
 * capability:bash renders a human-readable text result (a header line + combined
 * output). That is right for a MODEL reading the result and wrong for a `code:run`
 * script, which receives whatever `unwrapToolResult` can make of it: no JSON to
 * parse ⇒ a raw STRING ⇒ every `result.<field>` access resolves to `undefined`,
 * silently, and an `?? ''` fallback launders that into a real-looking empty output.
 * The reported case read as "the codebase does not contain this" for two greps that
 * both matched.
 *
 * The sharp edge is that the tool DISAGREED WITH ITSELF: the background branch
 * returns JSON (a real object), the foreground branch returns text — so the same
 * call expression changed shape depending on an argument.
 *
 * Runs the real shell (no mocks), mirroring bash-desktop-env.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Same rationale as bash-desktop-env.test.ts: pin the exec-sandbox flag OFF so the
// suite is hermetic on a host with no bubblewrap (the console.warn would otherwise
// be turned into a failure by vitest-fail-on-console).
vi.mock('./exec-sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-sandbox')>()),
  capabilityExecSandboxEnabled: vi.fn(async () => false),
}));

import bashTool from './bash';
import { __resetBashJobs, getJob, waitForJobResponse } from './bash-jobs';
import { generateToolFacadeTypes, lookupByMcpName } from '@papercusp/agent-mcp';
import { unwrapToolResult } from '@papercusp/tooldef';
import * as enrollSync from '../../task-manager/enroll-sync';

type ToolResultish = {
  content: Array<{ text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};
type Tool = { handler: (a: unknown, c: unknown) => Promise<ToolResultish> };
type BashArgsSchema = {
  safeParse: (value: unknown) => {
    success: boolean;
    error?: { issues: Array<{ message: string }> };
  };
};
const bash = bashTool as unknown as Tool;
const STATE = mkdtempSync(join(tmpdir(), 'cap-bash-shape-'));

function makeCtx(opts: { codeMode?: boolean; requestedStructured?: boolean } = {}) {
  return {
    projectDir: STATE,
    stateDir: STATE,
    signal: new AbortController().signal,
    emit: () => {},
    role: 'cup',
    ...(opts.codeMode ? { codeMode: true } : {}),
    ...(opts.requestedStructured ? { transport: 'mcp', requestedStructured: true } : {}),
  } as never;
}

afterEach(() => {
  __resetBashJobs();
});

describe('capability:bash — result shape for a code:run script (EI-20066912585022608)', () => {
  it.each([false, true])('required task confinement returns a no-fork refusal (background=%s)', async (background) => {
    const wrap = vi.fn((binary: string, argv: string[]) => ({ binary, argv }));
    const begin = vi.spyOn(enrollSync, 'beginSyncEnrolment').mockReturnValue({
      taskId: 'required-public-confinement-refused', enrolled: true, confined: false,
      unconfinedReason: 'probe-pending', unitKind: 'service', scopeUnit: null,
      registrationReady: null, wrap, releaseEnvironmentTransport: () => {},
    });
    try {
      const args = (bashTool as unknown as { args: BashArgsSchema }).args;
      expect(args.safeParse({ command: 'echo should-not-run', require_task_confinement: true }).success).toBe(true);
      const result = await bash.handler({
        command: 'echo should-not-run', require_task_confinement: true, run_in_background: background,
      }, makeCtx({ codeMode: true }));
      expect(result.isError).toBe(true);
      expect(unwrapToolResult(result as never)).toMatchObject({
        ok: false, reason: 'task_confinement_unavailable', unconfined_reason: 'probe-pending', command_started: false,
      });
      expect(wrap).not.toHaveBeenCalled();
    } finally { begin.mockRestore(); }
  });

  it('advertises the code-mode result fields in the generated tools facade', () => {
    const registered = lookupByMcpName('capability:bash');
    expect(registered).toBeDefined();

    const facade = generateToolFacadeTypes([registered!]);
    expect(facade).not.toMatch(/bash\([^)]*\): Promise<unknown>;/);
    expect(facade).toContain('ok: boolean');
    expect(facade).toContain('output?: string');
    // Numeric schema bounds are intentionally rendered as a comment beside the
    // TypeScript primitive, so the contract remains `number | null` while the
    // generated signature also teaches the model the validator's integer range.
    expect(facade).toMatch(/exit_code\?: number(?: \/\* integer\([^*]+\) \*\/)? \| null/);
  });

  it('rejects sub-second public timeouts with explicit millisecond guidance', () => {
    const args = (bashTool as unknown as { args: BashArgsSchema }).args;
    const tooShort = args.safeParse({ command: 'true', timeout: 20 });
    const tooShortMessages = tooShort.error?.issues.map((issue) => issue.message).join(' ') ?? '';

    // `timeout: 20` is the reported live shape: a caller means 20 seconds, while
    // the child runner receives 20ms and expires before it can do useful work.
    expect(tooShort.success).toBe(false);
    expect(tooShortMessages).toContain('milliseconds');
    expect(tooShortMessages).toContain('20 seconds');
    expect(tooShortMessages).toContain('20000');
    expect(args.safeParse({ command: 'true', timeout: 999 }).success).toBe(false);
    expect(args.safeParse({ command: 'true', timeout: 1000 }).success).toBe(true);
    expect(args.safeParse({ command: 'true', timeout: 20000 }).success).toBe(true);
  });

  // This test pins the SUBSTANCE of the guidance, not its wording. `capability:bash`
  // sits against a hard 1500-unit prompt-weight cap (tool-guidance-budget.ts), so this
  // prose gets legitimately re-compressed to stay under it — 897b933647 rewrote
  // "strips database credential environment variables" to "strips DB credential env
  // vars" and "fails before either search tool runs" to "fails before either tool runs",
  // changing nothing semantic and reddening every exact-phrase assertion here.
  // Asserting whole sentences made this file fail for editorial compression, which
  // teaches the next editor to pad the guidance back over budget to appease a test.
  // So match the load-bearing TOKENS (and tolerate the abbreviations a budget squeeze
  // reaches for) — a real regression is the claim GOING AWAY, not being said shorter.
  it('routes operator database reads away from psql because shell credentials are scrubbed', () => {
    const guidance = (bashTool as unknown as { guidance?: { when?: string; notWhen?: string } }).guidance;
    expect(guidance?.notWhen).toContain('dev:pg_query');
    // The claim that earns the redirect: the shell cannot see DB credentials.
    expect(guidance?.notWhen).toMatch(/strips (?:database|DB) credential env(?:ironment)? var(?:iable)?s/);
    expect(guidance?.when).toContain('Fixed strings');
    expect(guidance?.when).toContain('`rg -F`');
    expect(guidance?.when).toContain('`grep -F`');
    expect(guidance?.when).toContain('quote backticks before shell use');
    expect(guidance?.when).toContain('Apostrophes break single-quoted regexes');
    expect(guidance?.when).toContain('`-e`');
    expect(guidance?.when).toContain('quoted input');
    expect(guidance?.when).toContain('do not shell-background child');
    expect(guidance?.when).toContain('without `wait`');
    expect(guidance?.when).toContain('For `systemd-run`');
    expect(guidance?.when).toContain('`-- executable argv` after options');
    expect(guidance?.when).toContain('`&&` starts another command');
  });

  it('documents that truncated shell output is a preview and points to the full log', () => {
    const fields = (bashTool as unknown as {
      result?: { shape?: Record<string, { description?: string }> };
    }).result?.shape;
    expect(fields?.truncated?.description).toContain('bounded head/tail preview');
    expect(fields?.truncated?.description).toContain('do not parse it');
    expect(fields?.truncated?.description).toContain('read log_path');
    expect(fields?.log_path?.description).toContain('complete command output');
  });

  it('gives a code-mode caller an OBJECT whose output field carries the real output', async () => {
    const r = await bash.handler({ command: 'echo HELLO-SHAPE-PROBE' }, makeCtx({ codeMode: true }));

    // What the script actually receives — through the REAL unwrap seam, not a
    // hand-asserted shape. This is the assertion the defect would have failed:
    // before the fix `unwrap` returned a string and `.output` was undefined.
    const seen = unwrapToolResult(r as never) as Record<string, unknown>;
    expect(typeof seen).toBe('object');
    expect(String(seen.output)).toContain('HELLO-SHAPE-PROBE');
    expect(seen.ok).toBe(true);
    expect(seen.exit_code).toBe(0);
    expect(seen.cwd).toBe(STATE);
    expect(typeof seen.duration_ms).toBe('number');
  });

  it('leaves a DIRECT caller byte-identical — no duplicated output on the wire', async () => {
    const r = await bash.handler({ command: 'echo HELLO-SHAPE-PROBE' }, makeCtx());

    // The cost control: capability:bash is one of the most-called tools here, so
    // attaching the machine-readable copy unconditionally would double the payload
    // for every caller that only ever reads the text.
    expect(r.structuredContent).toBeUndefined();
    expect(r.content[0].text).toContain('HELLO-SHAPE-PROBE');
    // And the raw-string fallback is still what such a result unwraps to — this is
    // the behaviour being deliberately confined to non-code-mode, not removed.
    expect(typeof unwrapToolResult(r as never)).toBe('string');
  });

  it('provides the declared structured result to an MCP caller that requests it', async () => {
    const r = await bash.handler(
      { command: 'echo HELLO-SHAPE-PROBE' },
      makeCtx({ requestedStructured: true }),
    );

    expect(r.structuredContent).toMatchObject({
      ok: true,
      status: 'completed',
      exit_code: 0,
      output: expect.stringContaining('HELLO-SHAPE-PROBE'),
      cwd: STATE,
    });
    expect(typeof unwrapToolResult(r as never)).toBe('object');
  });

  it('reports a FAILING command as ok:false with the real exit code, not a bare empty', async () => {
    const r = await bash.handler(
      { command: 'echo OOPS >&2; exit 3' },
      makeCtx({ codeMode: true }),
    );
    const seen = unwrapToolResult(r as never) as Record<string, unknown>;

    // exit_code must survive as a NUMBER: a script branching on `exit_code !== 0`
    // is the whole reason to hand back structure instead of a rendered header line.
    expect(seen.exit_code).toBe(3);
    // The load-bearing one: `ok` must track the COMMAND, not the shell. Defining it
    // as `!isError` would report ok:true here, because isError is reserved for a
    // command that never produced an exit code at all.
    expect(seen.ok).toBe(false);
    expect(seen.status).toBe('failed');
    // stderr is folded into the same buffer by bash-jobs, which is exactly why the
    // field is named `output` and not `stdout`.
    expect(String(seen.output)).toContain('OOPS');
  });

  it('does not name the combined buffer `stdout` — the name would read true and be false', async () => {
    const r = await bash.handler({ command: 'echo X >&2' }, makeCtx({ codeMode: true }));
    const seen = unwrapToolResult(r as never) as Record<string, unknown>;

    // A script that guesses `.stdout` now gets `undefined` from an OBJECT, which the
    // code:run field-miss tracker reports with the real key list. That is a loud
    // correction; the pre-fix `.stdout` on a STRING was silent and unreportable.
    expect(seen.stdout).toBeUndefined();
    expect(Object.keys(seen)).toContain('output');
    expect(String(seen.output)).toContain('X');
  });

  it('agrees with its own background branch: both shapes are objects', async () => {
    // The asymmetry WITHIN this tool is what made `.stdout` the natural thing to
    // write — an agent who used the background form first learned "it is an object".
    const bg = await bash.handler(
      { command: 'echo BG', run_in_background: true },
      makeCtx({ codeMode: true }),
    );
    const bgSeen = unwrapToolResult(bg as never) as Record<string, unknown>;
    // EI-23534775644576082: this test checks the two result shapes, not
    // concurrent sandboxes. Separate launches in the same writable cwd race in
    // SRT while it creates and removes mandatory-deny mount placeholders.
    // Wait for the actual background process to close before starting FG.
    const bgJob = getJob(String(bgSeen.bash_id));
    expect(bgJob).toBeDefined();
    expect(await waitForJobResponse(bgJob!, new AbortController().signal, 30_000)).toBe('terminal');
    expect(bgJob!.status).toBe('completed');

    const fg = await bash.handler({ command: 'echo FG' }, makeCtx({ codeMode: true }));
    const fgSeen = unwrapToolResult(fg as never) as Record<string, unknown>;
    expect(typeof bgSeen).toBe('object');
    expect(typeof fgSeen).toBe('object');
    // Both carry the launch/run facts under the same names.
    expect(bgSeen.ok).toBe(true);
    expect(typeof bgSeen.task_id).toBe('string');
    // EI-23534775644576082 recurred in a full lane run after a focused pass.
    // Keep the job outcome visible when the real shell fails intermittently;
    // a bare `false` hid whether it failed, timed out, or lost its task scope.
    expect(fgSeen.ok, JSON.stringify({
      status: fgSeen.status,
      exit_code: fgSeen.exit_code,
      output: fgSeen.output,
      log_path: fgSeen.log_path,
      task_id: fgSeen.task_id,
    })).toBe(true);
    expect(bgSeen.cwd).toBe(STATE);
    expect(fgSeen.cwd).toBe(STATE);
  });

  it('refuses an untracked shell-backgrounded child before creating a task', async () => {
    const r = await bash.handler(
      {
        command: 'nohup sleep 30 >/tmp/capability-bash-untracked.log 2>&1 & echo launched; sleep 1',
        run_in_background: true,
      },
      makeCtx({ codeMode: true }),
    );
    expect(r.isError).toBe(true);
    const seen = JSON.parse(r.content[0].text) as Record<string, unknown>;
    expect(seen).toMatchObject({ ok: false, reason: 'untracked_shell_background' });
    expect(String(seen.message)).toContain('reaped when the shell finishes');
    expect(String(seen.message)).toContain('foreground payload');
    expect(seen.task_id).toBeUndefined();
  });
});
