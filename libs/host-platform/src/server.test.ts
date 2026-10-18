import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serverHostPlatform } from './server';

describe('serverHostPlatform', () => {
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    envSnapshot.HARNESS_ADMIN_DATABASE_URL = process.env.HARNESS_ADMIN_DATABASE_URL;
    envSnapshot.DATABASE_URL = process.env.DATABASE_URL;
    envSnapshot.PAPERCUSP_PG_URL = process.env.PAPERCUSP_PG_URL;
    delete process.env.HARNESS_ADMIN_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.PAPERCUSP_PG_URL;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('readTextFileSync throws with the path in the message', () => {
    expect(() => serverHostPlatform.readTextFileSync('/etc/passwd')).toThrow(
      /readTextFileSync\('\/etc\/passwd'\)/,
    );
  });

  it('fileExistsSync throws', () => {
    expect(() => serverHostPlatform.fileExistsSync('/anything')).toThrow(
      /not available on the server host/,
    );
  });

  it('homedir throws', () => {
    expect(() => serverHostPlatform.homedir()).toThrow(/not available/);
  });

  it('papercuspHome throws', () => {
    expect(() => serverHostPlatform.papercuspHome()).toThrow(/not available/);
  });

  it('getHarnessAdminUrl reads env', () => {
    process.env.HARNESS_ADMIN_DATABASE_URL = 'postgresql://server/db';
    expect(serverHostPlatform.getHarnessAdminUrl()).toBe('postgresql://server/db');
  });

  it('getHarnessAdminUrl throws when env is absent (no fallback)', () => {
    expect(() => serverHostPlatform.getHarnessAdminUrl()).toThrow(
      /HARNESS_ADMIN_DATABASE_URL/,
    );
  });
});
