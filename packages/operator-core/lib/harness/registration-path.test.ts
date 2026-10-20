import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRegistrationPath, retiredSlugRefusal, type RegistrationPathDeps } from './registration-path';
import { RETIRED_HARNESS_SLUG_ALIASES } from './operator-home-harness';

describe('retiredSlugRefusal (WI-6554700010018316 fix 2)', () => {
  it('refuses every retired alias and names the slug the registry reads it as', () => {
    const entries = Object.entries(RETIRED_HARNESS_SLUG_ALIASES);
    expect(entries.length).toBeGreaterThan(0);
    for (const [retired, canonical] of entries) {
      const r = retiredSlugRefusal(retired);
      expect(r).toMatchObject({ status: 400, code: 'retired_slug', canonicalSlug: canonical });
      expect(r?.error).toContain(`'${retired}'`);
      expect(r?.error).toContain(`'${canonical}'`);
    }
  });

  it('accepts the canonical slug and ordinary names', () => {
    expect(retiredSlugRefusal('papercusp')).toBeNull();
    expect(retiredSlugRefusal('my-project')).toBeNull();
  });

  it('does not mistake inherited Object properties for retired slugs', () => {
    expect(retiredSlugRefusal('constructor')).toBeNull();
    expect(retiredSlugRefusal('tostring')).toBeNull();
    expect(retiredSlugRefusal('__proto__')).toBeNull();
  });
});

function fsError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

function deps(over: Partial<RegistrationPathDeps>): RegistrationPathDeps {
  return {
    stat: () => ({}),
    operatorUser: () => 'papercusp',
    hostedWorkspaceRoot: () => null,
    ...over,
  };
}

describe('checkRegistrationPath (WI-6554700010018316 fix 1)', () => {
  it('accepts a path the operator can stat', () => {
    expect(checkRegistrationPath('/srv/papercusp/workspaces/papercup', deps({}))).toEqual({ ok: true });
  });

  it('reports a permission denial as not-accessible (403), never as "does not exist"', () => {
    const v = checkRegistrationPath(
      '/home/papercusp-workspace/papercup',
      deps({
        stat: () => {
          throw fsError('EACCES');
        },
        hostedWorkspaceRoot: () => '/srv/papercusp/workspaces',
      }),
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.status).toBe(403);
    expect(v.code).toBe('path_not_accessible');
    expect(v.error).not.toMatch(/does not exist/);
    expect(v.error).toContain('papercusp');
    expect(v.error).toContain('/srv/papercusp/workspaces');
    expect(v.hint).toContain('/srv/papercusp/workspaces');
  });

  it('keeps the missing-path answer for ENOENT and names the hosted root when there is one', () => {
    const v = checkRegistrationPath(
      '/srv/papercusp/workspaces/nope',
      deps({
        stat: () => {
          throw fsError('ENOENT');
        },
        hostedWorkspaceRoot: () => '/srv/papercusp/workspaces',
      }),
    );
    expect(v).toMatchObject({ ok: false, status: 400, code: 'path_missing', error: 'path does not exist' });
    if (!v.ok) expect(v.hint).toContain('/srv/papercusp/workspaces');
  });

  it('omits the hosted hint on a host without the hosted workspace root', () => {
    const v = checkRegistrationPath(
      '/tmp/x',
      deps({
        stat: () => {
          throw fsError('EPERM');
        },
      }),
    );
    expect(v).toMatchObject({ ok: false, status: 403, code: 'path_not_accessible' });
    if (!v.ok) expect(v.hint).toBeUndefined();
  });

  it('surfaces any other stat failure with its code instead of claiming absence', () => {
    const v = checkRegistrationPath(
      '/x',
      deps({
        stat: () => {
          throw fsError('ELOOP');
        },
      }),
    );
    expect(v).toMatchObject({ ok: false, status: 400, code: 'path_unreadable' });
    if (!v.ok) expect(v.error).toContain('ELOOP');
  });

  describe('against the real filesystem', () => {
    let dir: string | null = null;
    afterEach(() => {
      if (dir) {
        chmodSync(dir, 0o700);
        rmSync(dir, { recursive: true, force: true });
        dir = null;
      }
    });

    it('distinguishes an unreadable parent from a missing child', () => {
      dir = mkdtempSync(join(tmpdir(), 'regpath-'));
      const inner = join(dir, 'repo');
      mkdirSync(inner);
      expect(checkRegistrationPath(inner)).toEqual({ ok: true });
      expect(checkRegistrationPath(join(dir, 'missing'))).toMatchObject({ code: 'path_missing' });
      // Root bypasses directory permissions, so the denial half only runs unprivileged.
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        chmodSync(dir, 0o000);
        expect(checkRegistrationPath(inner)).toMatchObject({ ok: false, code: 'path_not_accessible', status: 403 });
      }
    });
  });
});
