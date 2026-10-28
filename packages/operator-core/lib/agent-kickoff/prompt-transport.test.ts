import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { controlPlaneTempCandidates } from '../control-plane-temp.mjs';
import { consumeKickoffPromptFile, INLINE_KICKOFF_MAX_BYTES, KICKOFF_PROMPT_FILE_ENV, prepareKickoffEnvironment } from './prompt-transport.mjs';

const large = "Review every outcome verbatim: '$(`never execute`) — ☎\n".repeat(6000);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

describe('free-form kickoff file transport', () => {
  it('preserves small prompts and other environment fields', () => {
    const env = { PAPERCUSP_KICKOFF_PROMPT: 'small first turn', OTHER: 'kept' };
    expect(prepareKickoffEnvironment(env)).toBe(env);
  });

  it('uses UTF-8 bytes rather than character count at the inline boundary', () => {
    const next = prepareKickoffEnvironment({ PAPERCUSP_KICKOFF_PROMPT: '☎'.repeat(INLINE_KICKOFF_MAX_BYTES / 2) });
    expect(next.PAPERCUSP_KICKOFF_PROMPT).toBeUndefined();
    expect(consumeKickoffPromptFile(next[KICKOFF_PROMPT_FILE_ENV])).toBe('☎'.repeat(INLINE_KICKOFF_MAX_BYTES / 2));
  });

  it('retains the complete prompt in a private single-use file', () => {
    const next = prepareKickoffEnvironment({ PAPERCUSP_KICKOFF_PROMPT: large, OTHER: 'kept' });
    const path = next[KICKOFF_PROMPT_FILE_ENV];
    expect(next.PAPERCUSP_KICKOFF_PROMPT).toBeUndefined();
    expect(next.OTHER).toBe('kept');
    expect(readFileSync(path, 'utf8')).toBe(large);
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(statSync(dirname(path)).mode & 0o077).toBe(0);
    expect(controlPlaneTempCandidates('payload').map((root) => realpathSync(root)))
      .toContain(realpathSync(dirname(dirname(path))));
    expect(consumeKickoffPromptFile(path)).toBe(large);
    expect(existsSync(path)).toBe(false);
    expect(() => consumeKickoffPromptFile(path)).toThrow();
  });

  it('clears the fallback cleanup timer when the prompt is consumed', () => {
    vi.useFakeTimers();
    try {
      const next = prepareKickoffEnvironment({ PAPERCUSP_KICKOFF_PROMPT: large });
      expect(vi.getTimerCount()).toBe(1);
      expect(consumeKickoffPromptFile(next[KICKOFF_PROMPT_FILE_ENV])).toBe(large);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform !== 'linux')('crosses the kernel exec boundary without an oversized argv or environment entry', () => {
    const legacy = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
      env: { ...process.env, PAPERCUSP_KICKOFF_PROMPT: large },
    });
    expect((legacy.error as NodeJS.ErrnoException)?.code).toBe('E2BIG');
    const env = prepareKickoffEnvironment({ ...process.env, PAPERCUSP_KICKOFF_PROMPT: large });
    const modulePath = fileURLToPath(new URL('./prompt-transport.mjs', import.meta.url));
    const program = `import { consumeKickoffPromptFile, KICKOFF_PROMPT_FILE_ENV } from ${JSON.stringify(modulePath)}; import { createHash } from 'node:crypto'; process.stdout.write(createHash('sha256').update(consumeKickoffPromptFile(process.env[KICKOFF_PROMPT_FILE_ENV])).digest('hex'));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { env, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(digest(large));
  });

  it('refuses arbitrary files and symlink substitutions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kickoff-untrusted-'));
    const arbitrary = join(directory, 'prompt.txt');
    writeFileSync(arbitrary, 'not a transport envelope', { mode: 0o600 });
    expect(() => consumeKickoffPromptFile(arbitrary)).toThrow('Invalid private');
    const env = prepareKickoffEnvironment({ PAPERCUSP_KICKOFF_PROMPT: large });
    const path = env[KICKOFF_PROMPT_FILE_ENV];
    rmSync(path);
    symlinkSync(arbitrary, path);
    expect(() => consumeKickoffPromptFile(path)).toThrow('Invalid private');
    rmSync(dirname(path), { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  });

  it('refuses a transport made readable to other accounts', () => {
    const env = prepareKickoffEnvironment({ PAPERCUSP_KICKOFF_PROMPT: large });
    const path = env[KICKOFF_PROMPT_FILE_ENV];
    chmodSync(path, 0o644);
    expect(() => consumeKickoffPromptFile(path)).toThrow('Invalid private');
    rmSync(dirname(path), { recursive: true, force: true });
  });
});
