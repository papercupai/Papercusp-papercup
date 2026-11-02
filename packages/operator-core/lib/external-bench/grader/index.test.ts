import { expect, it } from 'vitest';
import { liveProcExec } from './index';

// These tiny programs import no repository code. Inheriting the outer test
// runner's Node bootstrap would measure that bootstrap instead of the child.
const childEnv = { NODE_OPTIONS: '' };

it('kills a subprocess that ignores SIGTERM at its declared deadline', async () => {
  const result = await liveProcExec(process.execPath, ['-e',
    'process.on("SIGTERM",()=>{}); process.stdout.write(String(process.pid)); setInterval(()=>{},1000)'],
  { timeoutMs: 2_000, env: childEnv });
  expect(result.code).toBe(124);
  expect(result.stderr).toContain('timed out after 2000ms');
  const pid = Number(result.stdout);
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
}, 10_000);

it('preserves stdout, stderr and a normal nonzero exit within the deadline', async () => {
  const result = await liveProcExec(process.execPath, ['-e',
    'process.stdout.write("out"); process.stderr.write("err"); process.exitCode=19'],
    { timeoutMs: 5_000, env: childEnv });
  expect(result).toMatchObject({ stdout: 'out', code: 19 });
  expect(result.stderr).toContain('err');
  expect(result.stderr).not.toContain('timed out');
});

it('refuses an already aborted subprocess without running its program', async () => {
  const result = await liveProcExec(process.execPath, ['-e', 'process.stdout.write("ran")'],
    { signal: AbortSignal.abort(), timeoutMs: 5_000, env: childEnv });
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(/abort/i);
});
