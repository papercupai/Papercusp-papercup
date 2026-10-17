import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { pcHeavyFixtureOptions } from './testing/pc-heavy-fixture';

const SCRIPT = resolve(__dirname, '../../../scripts/pc-heavy.sh');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pc-heavy non-Git coalescing guard', () => {
  it('skips the pre-admission tree scan and still runs the command', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-heavy-non-git-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const slots = join(root, 'slots');
    const scratch = join(root, 'scratch');
    const trace = join(root, 'find-called');
    mkdirSync(bin, { recursive: true });
    mkdirSync(slots, { recursive: true });
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(root, 'input.txt'), 'fixture\n');
    writeFileSync(join(bin, 'find'), [
      '#!/usr/bin/env bash',
      'for arg in "$@"; do [ "$arg" = -xdev ] && printf called > "$TRACE"; done',
      'exec /usr/bin/find "$@"',
      '',
    ].join('\n'), { mode: 0o755 });

    const cleanEnv: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!/^_?PC_HEAVY_/.test(key)) cleanEnv[key] = value;
    }
    const fixture = pcHeavyFixtureOptions(root, { PC_HEAVY_DIR: slots });
    const result = spawnSync('bash', [SCRIPT, 'sh', '-c', 'printf child-ran'], {
      cwd: fixture.cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...cleanEnv,
        ...fixture.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        TRACE: trace,
        TMPDIR: scratch,
        PC_HEAVY_COALESCE: '1',
        PC_HEAVY_DIR: slots,
        PC_HEAVY_SLOTS: '1',
        PC_HEAVY_MEM_CLAMP: '0',
        PC_HEAVY_GATE_RESERVE: '0',
        PC_HEAVY_PSI_ADMISSION: '0',
        PC_HEAVY_PREEMPTIBLE: '0',
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('child-ran');
    expect(result.stderr).toContain('coalescing disabled for non-Git cwd');
    expect(result.stderr).toContain('slot acquired — starting real work');
    expect(existsSync(trace), 'non-Git coalescing must not enumerate the cwd before admission').toBe(false);
  });
});
