// @vitest-environment node
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';

const fixtureRoot = join(tmpdir(), 'pty-fixture-source');

describe('PTY fixture environment isolation', () => {
  it.each(['0', '1'])('isolates a Codex fixture from inherited compactor switches set to %s', (value) => {
    const env = hermeticEnv({ PAPERCUSP_AGENT: 'codex' }, {
      PAPERCUSP_PSU_PTY_DIR: fixtureRoot,
      DISABLE_AUTO_COMPACT: value,
      DISABLE_COMPACT: value,
      KEEP_FIXTURE_VALUE: 'preserved',
    });

    expect(env).not.toHaveProperty('DISABLE_AUTO_COMPACT');
    expect(env).not.toHaveProperty('DISABLE_COMPACT');
    expect(env).toMatchObject({
      PAPERCUSP_AGENT: 'codex',
      PAPERCUSP_PSU_PTY_DIR: fixtureRoot,
      CODEX_HOME: join(fixtureRoot, 'codex-home'),
      CLAUDE_CONFIG_DIR: join(fixtureRoot, 'claude-home'),
      KEEP_FIXTURE_VALUE: 'preserved',
    });
  });

  it('preserves explicitly requested Claude compactor switches', () => {
    const env = hermeticEnv({
      PAPERCUSP_AGENT: 'claude',
      DISABLE_AUTO_COMPACT: '1',
      DISABLE_COMPACT: '1',
    }, { PAPERCUSP_PSU_PTY_DIR: fixtureRoot });

    expect(env).toMatchObject({
      PAPERCUSP_AGENT: 'claude',
      DISABLE_AUTO_COMPACT: '1',
      DISABLE_COMPACT: '1',
      PAPERCUSP_PSU_PTY_DIR: fixtureRoot,
    });
  });
});
