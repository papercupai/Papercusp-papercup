/**
 * WI-6554700010015388 regression guard.
 *
 * hono-host.ts is the bundle the :3070 / :3170 / bg-host deployments re-exec for
 * EVERY sidecar they spawn (the *_MODE divert). serve.ts main() arms the
 * parent-death watch before its own divert; hono-host.ts, documented as
 * "Mirrors serve.ts main() exactly", did not. So the WI-6554700010011963
 * off-desktop arming never reached hono-host sidecars: on 2026-10-15 six LSP
 * daemons outlived their :3170 generation, each pinning a superseded staging
 * checkout, until the root disk filled and the gate stopped producing verdicts.
 *
 * Source-order guard, the same shape as serve.test.ts's packaged-sidecar
 * ordering test: importing hono-host boots the whole host, so the arming cannot
 * be exercised behaviourally from a unit test. The watch's own behaviour is
 * covered in serve.test.ts ("off-desktop sidecars").
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const honoSrc = readFileSync(join(here, 'hono-host.ts'), 'utf8');
const serveSrc = readFileSync(join(here, 'serve.ts'), 'utf8');

function sidecarModeVars(src: string, from: number, to: number): Set<string> {
  const matches = src.slice(from, to).matchAll(/process\.env\.(PAPERCUSP_[A-Z_]+_MODE) === ['"]1['"]/g);
  return new Set([...matches].map((m) => m[1]!));
}

describe('hono-host sidecar divert arms the parent-death watch (WI-6554700010015388)', () => {
  const decl = honoSrc.indexOf('const sidecarMode');
  const watchStatement = honoSrc.match(/if \(([^;\n]+)\) startSidecarParentDeathWatch\(\);/);
  const arm = watchStatement?.index ?? -1;
  const firstDivert = honoSrc.indexOf("if (sidecarMode === '", decl);

  it('arms the watch for host-bound sidecars before the first sidecar divert', () => {
    expect(decl).toBeGreaterThan(-1);
    expect(arm).toBeGreaterThan(decl);
    expect(firstDivert).toBeGreaterThan(arm);
  });

  it.each([
    ['substrate', true],
    ['spawner', true],
    ['gateway', true],
    ['embed', true],
    ['resource-health', true],
    ['lsp', true],
    ['repair-precheck', false],
    [null, false],
  ] as const)('applies parent supervision to %s: %s', (mode, expected) => {
    expect(watchStatement).not.toBeNull();
    // Execute the actual guard without importing the host and booting services.
    const runGuard = new Function('sidecarMode', 'startSidecarParentDeathWatch', watchStatement![0]);
    let armed = false;
    runGuard(mode, () => { armed = true; });
    expect(armed).toBe(expected);
  });

  it('diverts every packaged sidecar mode that serve.ts arms the watch for', () => {
    const serveStart = serveSrc.indexOf('const packagedSidecarMode');
    const serveEnd = serveSrc.indexOf('startSidecarParentDeathWatch();', serveStart);
    expect(serveStart).toBeGreaterThan(-1);
    expect(serveEnd).toBeGreaterThan(serveStart);
    const servedModes = sidecarModeVars(serveSrc, serveStart, serveEnd);
    const honoModes = sidecarModeVars(honoSrc, decl, arm);
    expect(servedModes.size).toBeGreaterThan(0);
    for (const modeVar of servedModes) {
      expect(honoModes.has(modeVar), `${modeVar} is armed by serve.ts but not covered by hono-host.ts`).toBe(true);
    }
  });
});
