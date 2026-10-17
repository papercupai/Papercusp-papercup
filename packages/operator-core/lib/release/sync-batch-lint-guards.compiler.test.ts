import { it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { preflightSyncLintPrivateCompiler } from '../../test/sync-lint-private-compiler';

// Phase-only preflight: same compiler, argv wrapper and diagnostic parser as
// the private PG journey. No PG, source census, filing, wake or runtime boot.
it('P037 compiler preflight measures the seeded error and its repair without private PG', async () => {
  const receipt = await preflightSyncLintPrivateCompiler(resolve(import.meta.dirname, '../../../..'));
  expect(receipt).toMatchObject({ red: { outcome: 'nonzero-exit', exitCode: 2 },
    green: { outcome: 'completed', exitCode: 0 }, privatePgAllocated: false });
  expect(receipt.invocations.map(row => [row.phase, row.pendingStage, row.timeoutMs]))
    .toEqual([['red', 'exit', 10_000], ['green', 'exit', 10_000]]);
  console.info('SYNC_LINT_COMPILER_PREFLIGHT ' + JSON.stringify(receipt));
}, 30_000);

it('retains compiler timeout output and its pending stage before removing the fixture', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => {});
  let fixture: string | undefined;
  try {
    await expect(preflightSyncLintPrivateCompiler(resolve(import.meta.dirname, '../../../..'), {
      exec: async (_cmd, _args, opts) => {
        fixture = opts.cwd;
        return { status: null, durationMs: 10_001, failureKind: 'timeout', stdout: 'partial compiler output',
          stderr: 'SYNC_LINT_COMPILER_STAGE {"stage":"compiler-import"}\n' };
      },
    })).rejects.toThrow();
    const line = output.mock.calls.map(args => args[0]).find(value =>
      typeof value === 'string' && value.startsWith('SYNC_LINT_COMPILER_PREFLIGHT_FAILURE '));
    expect(line).toBeTruthy();
    const receipt = JSON.parse((line as string).slice('SYNC_LINT_COMPILER_PREFLIGHT_FAILURE '.length));
    expect(receipt).toMatchObject({ privatePgAllocated: false, invocations: [{ phase: 'red',
      timeoutMs: 10_000, pendingStage: 'compiler-import', result: { failureKind: 'timeout',
        stdout: 'partial compiler output', stderr: expect.stringContaining('compiler-import') } }] });
    expect(fixture).toBeTruthy();
    expect(existsSync(fixture!)).toBe(false);
  } finally { output.mockRestore(); }
});
