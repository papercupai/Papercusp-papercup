import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { papercuspHome, papercuspPath, papercuspPtyPath } from './home.mjs';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('host-home helpers', () => {
  it('uses the OS home when no isolation pin is present', () => {
    vi.stubEnv('HOME', '/tmp/host-home-test');
    delete process.env.PAPERCUSP_HOME;
    expect(papercuspHome()).toBe('/tmp/host-home-test/.papercusp');
  });

  it('honors a trimmed PAPERCUSP_HOME pin', () => {
    vi.stubEnv('PAPERCUSP_HOME', '  /tmp/scoped-home  ');
    expect(papercuspHome()).toBe('/tmp/scoped-home');
    expect(papercuspPath('state', 'turns')).toBe(join('/tmp/scoped-home', 'state', 'turns'));
  });

  it('accepts an explicit environment map for deterministic callers', () => {
    expect(papercuspHome({ PAPERCUSP_HOME: '/tmp/explicit-home' })).toBe('/tmp/explicit-home');
  });

  it('keeps PTY discovery host-wide when a session carries workspace-scoped state', () => {
    expect(papercuspPtyPath({ PAPERCUSP_HOME: '/tmp/workspaces/ws-a/.papercusp' }, '/home/tester'))
      .toBe('/home/tester/.papercusp/psu-pty');
    expect(papercuspPtyPath({
      PAPERCUSP_HOME: '/tmp/workspaces/ws-a/.papercusp',
      PAPERCUSP_PSU_PTY_DIR: ' /tmp/isolated/pty ',
    }, '/home/tester')).toBe('/tmp/isolated/pty');
  });
});
