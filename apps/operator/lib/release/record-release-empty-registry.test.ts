import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateSite, type SiteScope } from './record-release-cli';

const scope = { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' };
const siteScope: SiteScope = {
  surfaces: new Set(['index']),
  forced: false,
  reason: null,
};
const emptyRegistrySql = async () => [];

function useSafeReleaseRenderEnvironment(): () => void {
  const previousInterface = process.env.PAPERCUSP_DESKTOP_INTERFACE;
  const previousOwnerName = process.env.PAPERCUSP_RELEASE_OWNER_NAME;
  process.env.PAPERCUSP_DESKTOP_INTERFACE = 'legacy';
  process.env.PAPERCUSP_RELEASE_OWNER_NAME = 'Fixture Owner';
  return () => {
    if (previousInterface === undefined) delete process.env.PAPERCUSP_DESKTOP_INTERFACE;
    else process.env.PAPERCUSP_DESKTOP_INTERFACE = previousInterface;
    if (previousOwnerName === undefined) delete process.env.PAPERCUSP_RELEASE_OWNER_NAME;
    else process.env.PAPERCUSP_RELEASE_OWNER_NAME = previousOwnerName;
  };
}

describe('release regeneration with an empty registry', () => {
  it('preserves existing published history and reports the resolved database source', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-empty-registry-'));
    const history = JSON.stringify({
      generated_at: '2026-10-12T00:00:00.000Z',
      releases: [{ tag: 'desktop-v0.0.9' }],
    });
    const index = '<html>previous published release</html>';
    fs.writeFileSync(path.join(outDir, 'history.json'), history);
    fs.writeFileSync(path.join(outDir, 'index.html'), index);
    const restoreEnvironment = useSafeReleaseRenderEnvironment();

    try {
      await expect(
        generateSite(emptyRegistrySql as never, scope as never, outDir, siteScope, 'discovery-file'),
      ).rejects.toThrow(
        /REFUSING TO REPLACE existing release history: registry source=discovery-file returned no release rows/,
      );
      expect(fs.readFileSync(path.join(outDir, 'history.json'), 'utf8')).toBe(history);
      expect(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8')).toBe(index);
    } finally {
      restoreEnvironment();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('allows a first empty render when there is no published history to erase', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-empty-first-render-'));
    const restoreEnvironment = useSafeReleaseRenderEnvironment();

    try {
      await generateSite(emptyRegistrySql as never, scope as never, outDir, siteScope, 'native-fallback');
      const history = JSON.parse(fs.readFileSync(path.join(outDir, 'history.json'), 'utf8'));
      expect(history.releases).toEqual([]);
      expect(fs.existsSync(path.join(outDir, 'index.html'))).toBe(true);
    } finally {
      restoreEnvironment();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
