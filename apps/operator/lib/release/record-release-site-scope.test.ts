import { describe, expect, it } from 'vitest';
import { FULL_SITE_SCOPE, SITE_SURFACES, parseSiteScope, releasesToRender } from './record-release-cli';

// WI-10003694 / owner #821: `--only` is the generic, agent-judged force for a regenerate. It must
// be explicit (named surfaces), justified (--reason, written to the audit log), and never the
// default — a bare regenerate still renders every surface.

describe('parseSiteScope', () => {
  it('defaults to the FULL site, unforced', () => {
    const scope = parseSiteScope(['--regenerate']);
    expect(scope).toBe(FULL_SITE_SCOPE);
    expect([...FULL_SITE_SCOPE.surfaces].sort()).toEqual([...SITE_SURFACES].sort());
    expect(FULL_SITE_SCOPE.forced).toBe(false);
  });

  it('accepts named surfaces with a reason, as a forced scope', () => {
    const scope = parseSiteScope(['--regenerate', '--only', 'index,changes', '--reason', 'instructions text only']);
    expect('error' in scope).toBe(false);
    if ('error' in scope) return;
    expect([...scope.surfaces].sort()).toEqual(['changes', 'index']);
    expect(scope.forced).toBe(true);
    expect(scope.reason).toBe('instructions text only');
  });

  it('refuses --only without a meaningful --reason', () => {
    expect(parseSiteScope(['--only', 'index'])).toHaveProperty('error');
    expect(parseSiteScope(['--only', 'index', '--reason', 'x'])).toHaveProperty('error');
  });

  it('refuses unknown or missing surfaces', () => {
    expect(parseSiteScope(['--only', 'index,everything', '--reason', 'long enough'])).toHaveProperty('error');
    expect(parseSiteScope(['--only', '--reason', 'long enough'])).toHaveProperty('error');
  });
});

describe('releasesToRender (--exclude-unpublished)', () => {
  // Measured 2026-10-06: 0.0.26 was recorded (published_at NULL) but never uploaded, so a
  // re-render of the live 0.0.25 page made the dead 0.0.26 card the newest one.
  // 0.0.17 shipped publicly before the finalize step existed, so its published_at is NULL too.
  const rows = [
    { version: '0.0.26', cutAt: new Date('2026-09-30T17:27:43Z'), publishedAt: null },
    { version: '0.0.25', cutAt: new Date('2026-09-29T17:55:29Z'), publishedAt: new Date('2026-09-30T01:18:31Z') },
    { version: '0.0.24', cutAt: new Date('2026-09-28T21:19:59Z'), publishedAt: new Date('2026-09-28T21:53:00Z') },
    { version: '0.0.17', cutAt: new Date('2026-08-15T12:00:00Z'), publishedAt: null },
  ];

  it('keeps every row by default, so the normal record-then-publish flow still renders the new cut', () => {
    expect(releasesToRender(rows, FULL_SITE_SCOPE).map((r) => r.version)).toEqual(['0.0.26', '0.0.25', '0.0.24', '0.0.17']);
  });

  it('drops only the unpublished cuts recorded after the newest published release', () => {
    const kept = releasesToRender(rows, { ...FULL_SITE_SCOPE, excludeUnpublished: true });
    expect(kept.map((r) => r.version)).toEqual(['0.0.25', '0.0.24', '0.0.17']);
  });

  it('keeps everything when no row has ever been finalized', () => {
    const legacy = rows.map((row) => ({ ...row, publishedAt: null }));
    expect(releasesToRender(legacy, { excludeUnpublished: true })).toHaveLength(4);
  });

  it('does not mutate the input rows', () => {
    releasesToRender(rows, { excludeUnpublished: true });
    expect(rows).toHaveLength(4);
  });
});
