import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hermeticSpawnEnv, RUNNER_TASK_CONTEXT_VARS } from './hermetic-spawn-env';

// Recurrence guard for WI-6554700010030899 / WI-6554700010030901.
const LIB_DIR = fileURLToPath(new URL('..', import.meta.url));
// Built by concatenation so this file's own source never matches it.
const RAW_SPREAD = new RegExp('\\.\\.\\.process' + '\\.env\\b');

describe('verify-tauri-headless test spawn env', () => {
  it('drops the runner task-context vars and keeps everything else', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      PAPERCUSP_SID: 'keep-me',
      PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '1793172600000',
      PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: 'task-123',
    };
    const env = hermeticSpawnEnv(source);
    for (const key of RUNNER_TASK_CONTEXT_VARS) expect(env).not.toHaveProperty(key);
    expect(env).toMatchObject({ PATH: '/usr/bin', PAPERCUSP_SID: 'keep-me' });
    // The source is copied, never mutated.
    expect(source.PAPERCUSP_TASK_DEADLINE_EPOCH_MS).toBe('1793172600000');
  });

  it('lets an explicit override after the spread win', () => {
    const env = { ...hermeticSpawnEnv({ PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '1' }), PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '2' };
    expect(env.PAPERCUSP_TASK_DEADLINE_EPOCH_MS).toBe('2');
  });

  it('no verify-tauri-headless-*.test.ts spawns with a raw process.env spread', () => {
    const suites = readdirSync(LIB_DIR).filter((name) => /^verify-tauri-headless-.*\.test\.ts$/.test(name));
    // Positive control: the glob must actually see the suites it guards.
    expect(suites.length).toBeGreaterThan(20);
    const offenders = suites.filter((name) => RAW_SPREAD.test(readFileSync(join(LIB_DIR, name), 'utf8')));
    expect(offenders, 'use hermeticSpawnEnv() from ./__tests__/hermetic-spawn-env instead').toEqual([]);
  });
});
