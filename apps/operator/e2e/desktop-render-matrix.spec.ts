import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ViteDevServer } from 'vite';
import { expect, test } from './_egress';
import {
  evaluateRenderMatrix, type RenderMatrixContract, type RenderMatrixObservation,
} from '../../../packages/operator-core/lib/design-compare/render-matrix';

test.describe.configure({ mode: 'serial' });
const root = path.resolve(import.meta.dirname, '../../..');
const output = process.env.DESKTOP_MATRIX_OUTPUT_DIR;
const referencePath = 'docs/evidence/visual-desktop-mockups-2026-09-07/b-workspace.png';
const states = ['ready', 'empty', 'loading', 'disconnected', 'error'] as const;
const sizes = { desktop: { width: 1440, height: 900 }, narrow: { width: 390, height: 844 } };
const themes = ['light', 'dark'] as const;
const observations: RenderMatrixObservation[] = [];
const cases: RenderMatrixContract['cases'] = [];
let server: ViteDevServer;
let origin: string;
let build: string;
let referenceHash: string;

test.beforeAll(async () => {
  const { createServer } = await import('vite');
  referenceHash = createHash('sha256').update(await readFile(path.join(root, referencePath))).digest('hex');
  // A fixture build identity includes source bytes, not just mutable HEAD.
  const sourceFiles = [
    'apps/operator/app/cloud-workspaces/HostedDesktopWorkspace.tsx',
    'apps/operator/app/cloud-workspaces/hosted-workspace-session.module.css',
    'apps/operator/app/harness/Button.tsx',
    'apps/operator/e2e/__fixtures__/desktop-render-matrix.tsx',
    'apps/operator/app/cloud-workspaces/HostedDesktopViewer.tsx',
    'apps/operator/app/cloud-workspaces/hosted-desktop-viewer-protocol.ts',
    'apps/operator/app/cloud-workspaces/hosted-workspace-session-protocol.ts',
    'apps/operator/e2e/__fixtures__/desktop-render-rfb.ts',
    'apps/operator/e2e/desktop-render-matrix.spec.ts',
  ];
  const sourceHash = createHash('sha256');
  for (const file of sourceFiles) sourceHash.update(file).update(await readFile(path.join(root, file)));
  build = `fixture:${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()}:${sourceHash.digest('hex')}`;
  server = await createServer({
    configFile: false, root, logLevel: 'error',
    esbuild: { jsx: 'automatic' },
    css: { postcss: { plugins: [] } },
    resolve: { alias: { '@': path.join(root, 'apps/operator') } },
    // A repository-wide HTML crawl includes projected docs and unrelated apps.
    // This isolated fixture has exactly one entry and a closed dependency set.
    optimizeDeps: { entries: ['apps/operator/e2e/__fixtures__/desktop-render-matrix.tsx'],
      noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react', '@radix-ui/react-slot'] },
    plugins: [{
      name: 'desktop-controlled-state-fixture',
      enforce: 'pre',
      resolveId(id, importer) {
        if (id === '@novnc/novnc' && importer?.endsWith('/HostedDesktopViewer.tsx')) {
          return path.join(root, 'apps/operator/e2e/__fixtures__/desktop-render-rfb.ts');
        }
      },
      configureServer(instance) {
        instance.middlewares.use((req, res, next) => {
          if (new URL(req.url ?? '/', 'http://fixture').pathname !== '/') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
            <style>:root{--fg:#17202c;--fg-dim:#384454;--fg-mute:#5d6878;--border:#d3dbe5;--bg-deeper:#f1f4f8;--good:#167044;background:#fff;color:var(--fg);font:14px system-ui}
            :root[data-theme=dark]{--fg:#ecf0f5;--fg-dim:#c8d0dc;--fg-mute:#aab5c4;--border:#394655;--bg-deeper:#131c28;--good:#78d6a5;background:#101720}
            *{box-sizing:border-box}body{margin:0}main{padding:24px;min-width:0}button{font:inherit;color:inherit;cursor:pointer}.pc-btn{padding:6px 10px;border:1px solid var(--border);background:transparent;border-radius:6px}button:disabled{opacity:.45;cursor:default}</style>
            </head><body><div id="root"></div><script type="module" src="/apps/operator/e2e/__fixtures__/desktop-render-matrix.tsx"></script></body></html>`);
        });
      },
    }],
    // No HMR / watcher: root is the shared tree the fleet edits, so a watched change can
    // full-reload the page mid-test (see e2e/_desktop-grid-fixture-server.ts).
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null },
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
});

test.afterAll(async () => {
  await server?.close();
  if (output && observations.length) {
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'matrix.json'), JSON.stringify({
      contract: contract(), observations, referencePath,
      disclosure: 'Controlled component states and viewer fixture. No shell entry, real video, remote input, cloud provisioning or connectivity proof. Visual reviews are absent until an actual reviewer inspects the captures.',
    }, null, 2));
  }
});

function contract(): RenderMatrixContract {
  return { schemaVersion: 1, reference: { schemaVersion: 1,
    featureId: 'desktop-design-fidelity-repair-2026-09-08', referenceId: 'desktop-option-b',
    revision: 1, contentSha256: referenceHash }, cases };
}

for (const state of states) for (const [size, viewport] of Object.entries(sizes)) for (const theme of themes) {
  test(`[desktop.state.${state}][desktop.viewport.${size}] ${theme} renders truthful controls and option B geometry`, async ({ page }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`${origin}/?state=${state}&theme=${theme}`, { waitUntil: 'domcontentloaded' });
    const destination = page.getByRole('region', { name: 'Desktops for Design acceptance fixture', exact: true });
    await expect(destination).toBeVisible().catch(error => {
      throw new Error(`${String(error)}\nBrowser errors: ${pageErrors.join(' | ')}`);
    });
    await expect(page.getByRole('note')).toHaveText(`Controlled ${state} fixture · no real service connection`);
    const labels = { ready: 'connected · watch-only', empty: 'No desktops are available yet', loading: 'Finding your desktops…', disconnected: 'Connect your workspace', error: 'Desktops could not be loaded' };
    await expect(destination.getByText(labels[state], { exact: true })).toBeVisible();
    if (state === 'error') await expect(destination.getByRole('alert')).toContainText('Controlled roster error');
    const primary = destination.locator('[class*="desktopWorkspaceMain"]');
    const secondary = destination.getByRole('complementary', { name: 'Workspace desktops and activity' });
    const refresh = secondary.getByRole('button', { name: 'Refresh desktop roster' });
    const enabled = state !== 'loading' && state !== 'disconnected';
    if (enabled) await expect(refresh).toBeEnabled(); else await expect(refresh).toBeDisabled();
    if (state === 'ready') {
      await expect(destination.getByRole('button', { name: 'Watch Display 1' })).toBeEnabled();
      await expect(destination.getByRole('button', { name: 'Take control', exact: true })).toBeEnabled();
      // Exercise real viewer mode chrome with local transport only.
      await destination.getByRole('button', { name: 'Take control', exact: true }).click();
      await expect(destination.getByRole('button', { name: 'Release control', exact: true })).toBeEnabled();
      await page.keyboard.press('Escape');
      await expect(destination.getByRole('button', { name: 'Take control', exact: true })).toBeEnabled();
      await expect(destination.getByText('connected · watch-only', { exact: true })).toBeVisible();
    } else await expect(destination.getByRole('button', { name: 'Take control', exact: true })).toHaveCount(0);
    const caseId = `${state}-${size}-${theme}`;
    const capturePath = output ? path.join(output, `${caseId}.png`) : testInfo.outputPath(`${caseId}.png`);
    if (output) await mkdir(output, { recursive: true });
    const bytes = await page.screenshot({ path: capturePath, fullPage: true, animations: 'disabled' });
    const container = await destination.evaluate(element => {
      const b = element.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    });
    const observation: RenderMatrixObservation = {
      caseId, environment: { viewport: page.viewportSize()!, deviceScaleFactor: 1, browser: 'chromium', theme: await page.locator('html').getAttribute('data-theme') as string, fontSet: 'system', fixture: 'desktop-controlled-v1', state },
      target: { targetId: 'HostedDesktopWorkspace', targetKind: 'component', implementationRevision: build },
      evidenceKind: 'fixture', capture: { path: path.relative(root, capturePath), sha256: createHash('sha256').update(bytes).digest('hex') },
      geometry: { container, primary: (await primary.boundingBox())!, secondary: (await secondary.boundingBox())! },
      controls: [{ name: 'Refresh desktop roster', visible: await refresh.isVisible(), enabled: await refresh.isEnabled() }],
      readyContentVisible: await destination.locator('[data-ready-fixture]').isVisible(),
      placeholderVisible: await destination.locator('[class*="desktopWorkspaceEmpty"], [class*="desktopPlaceholder"]').isVisible(), connectivity: 'not-exercised',
    };
    if (state === 'ready') for (const name of ['Watch Display 1', 'Take control']) {
      const control = destination.getByRole('button', { name, exact: true });
      observation.controls.push({ name, visible: await control.isVisible(), enabled: await control.isEnabled() });
    }
    const required = {
      caseId, environment: { ...observation.environment, viewport, theme, state }, target: observation.target,
      evidenceKind: 'fixture' as const, layout: size === 'desktop' ? 'side-by-side' as const : 'stacked' as const,
      controls: [{ name: 'Refresh desktop roster', enabled }, ...(state === 'ready' ? [{ name: 'Watch Display 1', enabled: true }, { name: 'Take control', enabled: true }] : [])], readyContentRequired: state === 'ready',
    };
    cases.push(required); observations.push(observation);
    // Human review is deliberately still missing. This assertion checks every
    // machine-observed field without inventing a reviewed screenshot.
    expect(evaluateRenderMatrix({ ...contract(), cases: [required] }, [observation]).failures)
      .toEqual([{ caseId, reason: 'missing-side-by-side-review' }]);
  });
}

test('missing state, narrow capture and fixture connectivity cannot satisfy the matrix', () => {
  expect(observations).toHaveLength(states.length * Object.keys(sizes).length * themes.length);
  const withoutReviewFailure = (rows: RenderMatrixObservation[]) => evaluateRenderMatrix(contract(), rows).failures.filter(f => f.reason !== 'missing-side-by-side-review');
  expect(withoutReviewFailure(observations)).toEqual([]);
  expect(withoutReviewFailure(observations.filter(row => row.environment.state !== 'error'))).toContainEqual({ caseId: 'error-desktop-light', reason: 'missing-case-evidence' });
  expect(withoutReviewFailure(observations.filter(row => row.caseId !== 'ready-narrow-light'))).toEqual([{ caseId: 'ready-narrow-light', reason: 'missing-case-evidence' }]);
  const inventedConnection = observations.map(row => ({ ...row, connectivity: 'connected' as const, connectivityEvidence: 'fixture-is-not-a-service' }));
  expect(withoutReviewFailure(inventedConnection).every(f => f.reason === 'fixture-connectivity-claim')).toBe(true);
  expect(withoutReviewFailure(inventedConnection)).toHaveLength(observations.length);
});

for (const state of states) test(`[desktop.state.${state}] omission control rejects this state independently`, () => {
  const required = contract().cases.filter(row => row.environment.state === state);
  expect(required).toHaveLength(4);
  const failures = evaluateRenderMatrix(contract(), observations.filter(row => row.environment.state !== state)).failures;
  expect(failures.filter(row => row.reason === 'missing-case-evidence').map(row => row.caseId).sort())
    .toEqual(required.map(row => row.caseId).sort());
});

for (const [size, viewport] of Object.entries(sizes)) test(`[desktop.viewport.${size}] omission control rejects this viewport independently`, () => {
  const required = contract().cases.filter(row => row.environment.viewport.width === viewport.width);
  expect(required).toHaveLength(10);
  const failures = evaluateRenderMatrix(contract(), observations.filter(row => row.environment.viewport.width !== viewport.width)).failures;
  expect(failures.filter(row => row.reason === 'missing-case-evidence').map(row => row.caseId).sort())
    .toEqual(required.map(row => row.caseId).sort());
});

test('ready placeholder and wrong destination remain blocking even with a complete matrix', () => {
  const ready = observations.find(row => row.caseId === 'ready-desktop-light')!;
  const replace = (row: RenderMatrixObservation) => observations.map(value => value.caseId === row.caseId ? row : value);
  expect(evaluateRenderMatrix(contract(), replace({ ...ready, readyContentVisible: false, placeholderVisible: true })).failures)
    .toContainEqual({ caseId: ready.caseId, reason: 'placeholder-is-not-ready' });
  expect(evaluateRenderMatrix(contract(), replace({ ...ready, target: { ...ready.target, targetId: 'CloudWorkspaces' } })).failures)
    .toContainEqual({ caseId: ready.caseId, reason: 'wrong-target' });
});
