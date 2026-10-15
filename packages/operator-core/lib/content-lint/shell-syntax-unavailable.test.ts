import { afterEach, describe, expect, it, vi } from 'vitest';

// WI-10008204: a `bash -n` that produced NO verdict (timeout, spawn failure,
// kill) must throw, never come back as a syntax error. Gate run c943459c read
// `scripts/pc-heavy.sh:?  spawnSync bash ETIMEDOUT` as a BROKEN script under load.
// execFileSync is stubbed so each failure shape is reproduced deterministically;
// a real timeout would make this guard as load-sensitive as the bug it pins.
const h = vi.hoisted(() => ({
  impl: null as null | ((file: string, args: readonly string[], opts: Record<string, unknown>) => unknown),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    execFileSync: ((file: string, args: readonly string[], opts: Record<string, unknown>) =>
      h.impl ? h.impl(file, args, opts) : real.execFileSync(file, args, opts)) as typeof real.execFileSync,
  };
});

import {
  BASH_SYNTAX_CHECK_TIMEOUT_MS,
  findShellSyntaxError,
  ShellSyntaxCheckUnavailableError,
} from './shell-syntax';

/** The error shape Node's execFileSync throws, built field-for-field. */
function execError(fields: { code?: string; status: number | null; signal: string | null; stderr?: string }) {
  return Object.assign(new Error(fields.code ? `spawnSync bash ${fields.code}` : 'Command failed: bash -n'), {
    ...fields,
    stderr: Buffer.from(fields.stderr ?? ''),
  });
}

afterEach(() => {
  h.impl = null;
});

describe('findShellSyntaxError: no verdict is not a syntax error (WI-10008204)', () => {
  it('throws on a timeout (the measured gate failure shape)', () => {
    h.impl = () => {
      throw execError({ code: 'ETIMEDOUT', status: null, signal: 'SIGTERM' });
    };
    expect(() => findShellSyntaxError('echo hi\n')).toThrow(ShellSyntaxCheckUnavailableError);
    try {
      findShellSyntaxError('echo hi\n');
    } catch (err) {
      expect((err as ShellSyntaxCheckUnavailableError).code).toBe('ETIMEDOUT');
    }
  });

  it('throws when bash cannot be spawned', () => {
    h.impl = () => {
      throw execError({ code: 'ENOENT', status: null, signal: null });
    };
    expect(() => findShellSyntaxError('echo hi\n')).toThrow(ShellSyntaxCheckUnavailableError);
  });

  it('throws when bash is killed by a signal without a spawn code', () => {
    h.impl = () => {
      throw execError({ status: null, signal: 'SIGKILL' });
    };
    expect(() => findShellSyntaxError('echo hi\n')).toThrow(ShellSyntaxCheckUnavailableError);
  });

  it('still returns the parsed verdict when bash ran and exited non-zero', () => {
    h.impl = () => {
      throw execError({ status: 2, signal: null, stderr: 'bash: line 3: syntax error: unexpected end of file\n' });
    };
    expect(findShellSyntaxError('if true; then\n')).toEqual({ line: 3, reason: 'syntax error: unexpected end of file' });
  });

  it('passes the caller timeout through, defaulting to the git-sync tick bound', () => {
    const seen: unknown[] = [];
    h.impl = (_file, _args, opts) => {
      seen.push(opts.timeout);
      return Buffer.from('');
    };
    expect(findShellSyntaxError('echo hi\n')).toBeNull();
    expect(findShellSyntaxError('echo hi\n', { timeoutMs: 20_000 })).toBeNull();
    expect(seen).toEqual([BASH_SYNTAX_CHECK_TIMEOUT_MS, 20_000]);
  });
});
