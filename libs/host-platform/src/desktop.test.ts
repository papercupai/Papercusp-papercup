import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetDesktopHostPlatformCacheForTests,
  desktopHostPlatform,
} from './desktop';

describe('desktopHostPlatform', () => {
  let tmp: string;
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'host-platform-desktop-'));
    envSnapshot.HARNESS_ADMIN_DATABASE_URL = process.env.HARNESS_ADMIN_DATABASE_URL;
    envSnapshot.DATABASE_URL = process.env.DATABASE_URL;
    envSnapshot.PAPERCUSP_PG_URL = process.env.PAPERCUSP_PG_URL;
    envSnapshot.HOME = process.env.HOME;
    envSnapshot.USERPROFILE = process.env.USERPROFILE;
    envSnapshot.PAPERCUSP_HOME = process.env.PAPERCUSP_HOME;
    delete process.env.HARNESS_ADMIN_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.PAPERCUSP_PG_URL;
    // EI-13917: the discovery-file lookup now honors PAPERCUSP_HOME (the
    // established isolation escape hatch) BEFORE os.homedir() — clear it here
    // too, or these tests silently read whatever PAPERCUSP_HOME the CALLING
    // process happens to have exported (e.g. a psu/fleet session's per-
    // workspace state dir) instead of the isolated tmp home below.
    delete process.env.PAPERCUSP_HOME;
    // os.homedir() honors $HOME on POSIX / %USERPROFILE% on Windows, so this
    // repoints the ~/.papercusp/embedded-pg.json discovery lookup at an empty
    // tmp home. Without it these tests read the REAL home dir and go red on any
    // machine where the desktop app has run (it writes a live embedded-PG port
    // there) — which is every packaged install.
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    _resetDesktopHostPlatformCacheForTests();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetDesktopHostPlatformCacheForTests();
  });

  /** Write the embedded-PG discovery file into the tmp home. */
  const writeDiscoveryFile = (contents: string): void => {
    mkdirSync(join(tmp, '.papercusp'), { recursive: true });
    writeFileSync(join(tmp, '.papercusp', 'embedded-pg.json'), contents, 'utf8');
  };

  describe('readTextFileSync', () => {
    it('returns file contents when present', () => {
      const p = join(tmp, 'hello.txt');
      writeFileSync(p, 'hello world', 'utf8');
      expect(desktopHostPlatform.readTextFileSync(p)).toBe('hello world');
    });

    it('returns null when the file is missing (does not throw)', () => {
      expect(desktopHostPlatform.readTextFileSync(join(tmp, 'nope.txt'))).toBeNull();
    });

    it('returns null when path is a directory (read failure)', () => {
      mkdirSync(join(tmp, 'dir'));
      expect(desktopHostPlatform.readTextFileSync(join(tmp, 'dir'))).toBeNull();
    });
  });

  describe('fileExistsSync', () => {
    it('true for an existing file', () => {
      const p = join(tmp, 'a.txt');
      writeFileSync(p, '', 'utf8');
      expect(desktopHostPlatform.fileExistsSync(p)).toBe(true);
    });

    it('false for a missing file', () => {
      expect(desktopHostPlatform.fileExistsSync(join(tmp, 'nope'))).toBe(false);
    });

    it('false for a directory (matches "is a file?")', () => {
      mkdirSync(join(tmp, 'd'));
      expect(desktopHostPlatform.fileExistsSync(join(tmp, 'd'))).toBe(false);
    });
  });

  describe('homedir', () => {
    it('returns a non-empty string', () => {
      const h = desktopHostPlatform.homedir();
      expect(typeof h).toBe('string');
      expect(h.length).toBeGreaterThan(0);
    });
  });

  describe('papercuspHome', () => {
    it('resolves under the host home by default', () => {
      expect(desktopHostPlatform.papercuspHome()).toBe(join(tmp, '.papercusp'));
    });

    it('honors PAPERCUSP_HOME as the isolation pin', () => {
      const scoped = join(tmp, 'scoped', '.papercusp');
      process.env.PAPERCUSP_HOME = scoped;
      expect(desktopHostPlatform.papercuspHome()).toBe(scoped);
    });
  });

  describe('getHarnessAdminUrl', () => {
    it('prefers HARNESS_ADMIN_DATABASE_URL when set', () => {
      process.env.HARNESS_ADMIN_DATABASE_URL = 'postgresql://primary/x';
      process.env.DATABASE_URL = 'postgresql://secondary/x';
      expect(desktopHostPlatform.getHarnessAdminUrl()).toBe('postgresql://primary/x');
    });

    it('falls back to DATABASE_URL when primary is absent', () => {
      process.env.DATABASE_URL = 'postgresql://secondary/x';
      expect(desktopHostPlatform.getHarnessAdminUrl()).toBe('postgresql://secondary/x');
    });

    it('falls back to PAPERCUSP_PG_URL when both primary and DATABASE_URL absent', () => {
      process.env.PAPERCUSP_PG_URL = 'postgresql://tertiary/x';
      expect(desktopHostPlatform.getHarnessAdminUrl()).toBe('postgresql://tertiary/x');
    });

    it('returns the native fallback when no env + no discovery file', () => {
      const url = desktopHostPlatform.getHarnessAdminUrl();
      expect(url).toContain('harness_admin');
      expect(url).toContain('localhost:5432');
    });

    it('reads the embedded-pg discovery file when no env is set', () => {
      // The path every packaged desktop install actually takes: embedded PG
      // picks a free port at boot and records it in ~/.papercusp/embedded-pg.json.
      writeDiscoveryFile(
        JSON.stringify({ url: 'postgresql://harness_admin:pwd@localhost:19790/papercusp', port: 19790 }),
      );
      expect(desktopHostPlatform.getHarnessAdminUrl()).toBe(
        'postgresql://harness_admin:pwd@localhost:19790/papercusp',
      );
    });

    it('prefers env over the discovery file', () => {
      writeDiscoveryFile(JSON.stringify({ url: 'postgresql://from-discovery/x', port: 19790 }));
      process.env.HARNESS_ADMIN_DATABASE_URL = 'postgresql://from-env/x';
      expect(desktopHostPlatform.getHarnessAdminUrl()).toBe('postgresql://from-env/x');
    });

    it('falls back to native when the discovery file is unparseable', () => {
      writeDiscoveryFile('{ not json');
      expect(desktopHostPlatform.getHarnessAdminUrl()).toContain('localhost:5432');
    });

    it('falls back to native when the discovery file carries no url', () => {
      writeDiscoveryFile(JSON.stringify({ port: 19790 }));
      expect(desktopHostPlatform.getHarnessAdminUrl()).toContain('localhost:5432');
    });

    it('caches the resolved URL', () => {
      process.env.PAPERCUSP_PG_URL = 'postgresql://a/x';
      expect(desktopHostPlatform.getHarnessAdminUrl()).toBe('postgresql://a/x');
      process.env.PAPERCUSP_PG_URL = 'postgresql://b/x';
      // Still the cached value, even though env changed.
      expect(desktopHostPlatform.getHarnessAdminUrl()).toBe('postgresql://a/x');
    });
  });
});
