/** Cheap guard for the context API used by the expensive private-worker fixture. */
import { expect, it, vi } from 'vitest';
import { ChildProcess, execFileSync, fork, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { build } from 'esbuild';
import { captureIsolatedWorker, isolatedIntegrationCases, isolatedIntegrationDiagnosticArtifacts, isolatedIntegrationProofSourcePaths, isolatedIntegrationSourceFiles, isolatedTestFileWorkerOptions, isolatedWorkerFailureDetail, retainIsolatedLifecycleBeforeSourceCheck } from '../test/isolated-integration-proof';
import { pruneRuns, runHarness } from '@papercusp/verification-harness';
import { createPrivateHealthSnapshot, portalBrowserPackagesPlugin, preparePortalBrowserSource, preparePrivateDocsBrowserDocuments, preparePrivateHttpWorkspaces, preparePrivateRosterSocketRoot, preparePrivateOperatorApiBundle, resolvePreparedPrivateApiBundle } from '../test/private-http-workspace-preflight';
import { PANEL_ORDER } from './system-health/types';
import { verifyPrivateCoordReceipt, verifyPrivateHistoryStreams, verifyPrivateStopReceipt, verifyPrivateStopCleanup, verifyPrivateInsightsDenialCoverage } from '../test/private-coord-receipt';
import { buildSessionStreamUrl, sessionTargetFromRoster } from '../../../apps/operator/app/_components/chat/use-owner-session-chat';
import { Hono } from 'hono';
import { chromium } from 'playwright-core';
import { workspaceContextMiddleware } from './workspace-context-middleware';
import { activeWorkspaceId } from './workspace-registry';
import { preflightPrivateStats } from '../test/portal-stats-fixture';
import { privateDocsNavButton, retainPortalBrowserFailure, verifyPrivateProfileOriginControl, verifyPrivateHudReadPolicy, verifyPrivateHudHostDenial, verifyPrivateHudCapturedRoster, verifyPrivateHudCapturePreflight, verifyPrivateHostHeaderTransport, verifyPrivateTestingReadScopes } from '../test/portal-roster-browser-fixture';

const testingPots = { selected: 'testing-selected', neighbor: 'testing-neighbor', foreign: 'testing-foreign' };

it.each([false, true])('retains cleanup across the final source verdict and count pruning (sourceChanged=%s)', async sourceChanged => {
  const root = mkdtempSync(join(tmpdir(), 'isolated-source-verdict-retention-'));
  const runId = '20261012T000004Z-4';
  const lifecycle = { schemaVersion: 1, runId, worker: { pid: 123 } };
  const ended = { code: 0, runtimeRemoved: true, pgDataRemoved: true };
  let sourceChecked = false;
  try {
    const result = await runHarness({
      contract: { name: 'isolated-source-verdict-retention', phases: [{ id: 'execute' }] },
      evidenceRoot: root, runId, retainedArtifacts: ['phases/execute/lifecycle.json'], guardRails: [],
      runPhase: async ({ evidenceDir }) => {
        await retainIsolatedLifecycleBeforeSourceCheck(evidenceDir, lifecycle, ended, () => {
          sourceChecked = true;
          if (sourceChanged) throw new Error('original source integrity rejection');
        });
        return { ok: true };
      },
    });
    expect(sourceChecked).toBe(true);
    expect(result.verdict).toBe(sourceChanged ? 'fail' : 'pass');
    if (sourceChanged) expect(result.phases[0].detail).toContain('original source integrity rejection');
    expect(JSON.parse(readFileSync(join(result.evidenceDir, 'phases/execute/lifecycle.json'), 'utf8')))
      .toEqual({ ...lifecycle, ended });
    await runHarness({
      contract: { name: 'isolated-source-verdict-retention', phases: [{ id: 'execute' }] },
      evidenceRoot: root, runId: '20261012T000005Z-5', guardRails: [], runPhase: async () => ({ ok: true }),
    });
    expect(await pruneRuns(root, 1, Date.now(), {
      measureDisk: async () => ({ totalBytes: 1_000, availableBytes: 500 }), reserveBytes: () => 400,
    })).toContain(runId);
    expect(JSON.parse(readFileSync(join(root, 'retained', runId, 'phases/execute/lifecycle.json'), 'utf8')))
      .toEqual({ ...lifecycle, ended });
    expect(JSON.parse(readFileSync(join(root, 'retained', runId, 'result.json'), 'utf8')).verdict)
      .toBe(sourceChanged ? 'fail' : 'pass');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('retains exact original private worker browser and selected persistence receipts after count pruning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isolated-receipt-retention-'));
  const originals = new Map([
    ['phases/prepare/source.json', '{"source":"original"}\n'],
    ['phases/prepare/operator-api-preflight.json', '{"api":"original input"}\n'],
    ['phases/execute/lifecycle.json', '{"ended":true}\n'],
    ['phases/execute/worker.log', 'worker output before timeout\n'],
    ['phases/execute/worker-result.json', '{"code":0,"output":"original worker"}\n'],
    ['phases/execute/roster-stop-cleanup.jsonl', '{"stage":"native-exit","status":"failed","elapsedMs":29571}\n'],
    ['phases/execute/roster-stop-resources.json', '{"activeResources":[]}\n'],
    ['phases/execute/roster-stop-native.jsonl', '{"stage":"host-exit","sessions":[{"pid":123,"exitedAt":"original","closed":false}]}\n'],
    ['phases/execute/portal-browser-source.json', '{"bundle":"original browser"}\n'],
    ['phases/execute/portal-browser-receipt.json', '{"keyboardSave":true}\n'],
    ['phases/execute/portal-settings-persistence.json', '{"marker":"preserved"}\n'],
  ]);
  const retainedArtifacts = ['phases/prepare/source.json', 'phases/execute/lifecycle.json',
    'phases/execute/portal-settings-persistence.json'];
  try {
    const result = await runHarness({
      contract: { name: 'isolated-receipt-retention', phases: [{ id: 'prepare' }, { id: 'execute' }, { id: 'teardown' }] },
      evidenceRoot: root, runId: '20261012T000001Z-1', retainedArtifacts, guardRails: [],
      runPhase: async ({ phase, evidenceDir }) => {
        for (const [path, bytes] of originals) if (path.startsWith(`phases/${phase}/`))
          writeFileSync(join(evidenceDir, path.split('/').at(-1)!), bytes);
        if (phase === 'teardown') retainedArtifacts.push(...isolatedIntegrationDiagnosticArtifacts(join(evidenceDir, '../..')));
        return { ok: true };
      },
    });
    expect(result.verdict).toBe('pass');
    await runHarness({
      contract: { name: 'isolated-receipt-retention', phases: [{ id: 'execute' }] },
      evidenceRoot: root, runId: '20261012T000002Z-2', guardRails: [], runPhase: async () => ({ ok: true }),
    });
    expect(await pruneRuns(root, 1, Date.now(), {
      measureDisk: async () => ({ totalBytes: 1_000, availableBytes: 500 }), reserveBytes: () => 400,
    })).toContain(result.runId);
    expect(() => readFileSync(join(result.evidenceDir, 'result.json'))).toThrow();
    for (const [path, bytes] of originals)
      expect(readFileSync(join(root, 'retained', result.runId, path), 'utf8')).toBe(bytes);
    expect(JSON.parse(readFileSync(join(root, 'retained', result.runId, 'result.json'), 'utf8'))).toEqual(result);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('allows modes without browser receipts but refuses a missing explicitly required selected receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isolated-receipt-requirement-'));
  try {
    expect(isolatedIntegrationDiagnosticArtifacts(root)).toEqual([]);
    const withoutBrowser = await runHarness({
      contract: { name: 'isolated-receipt-requirement', phases: [{ id: 'execute' }] },
      evidenceRoot: root, runId: '20261012T000002Z-2',
      retainedArtifacts: isolatedIntegrationDiagnosticArtifacts(root), guardRails: [],
      runPhase: async () => ({ ok: true }),
    });
    expect(withoutBrowser.verdict).toBe('pass');
    const runId = '20261012T000003Z-3';
    await expect(runHarness({
      contract: { name: 'isolated-receipt-requirement', phases: [{ id: 'execute' }] },
      evidenceRoot: root, runId, retainedArtifacts: ['phases/execute/portal-settings-persistence.json'], guardRails: [],
      runPhase: async () => ({ ok: true }),
    })).rejects.toThrow();
    expect(() => readFileSync(join(root, 'retained', runId, 'result.json'))).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('preflights Stats workspace selection through real middleware with a cookie-only negative control', async () => {
  const evidence = mkdtempSync(join(tmpdir(), 'stats-request-contract-'));
  const workspace = 'test-runtime-stats-contract';
  const previousRoot = process.env.PAPERCUSP_WORKSPACES_ROOT;
  const previousPin = process.env.PAPERCUSP_WORKSPACE_ID;
  writeFileSync(join(evidence, 'registry.json'), JSON.stringify({ current: workspace, workspaces: [
    { id: workspace, name: 'Own', createdAt: 1 },
    { id: workspace + '-foreign', name: 'Foreign', createdAt: 2 },
  ] }));
  process.env.PAPERCUSP_WORKSPACES_ROOT = evidence;
  process.env.PAPERCUSP_WORKSPACE_ID = workspace;
  const readonlyRepo = resolve(import.meta.dirname, '../../..');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: readonlyRepo, encoding: 'utf8' }).trim();
  const requests: Array<{ slug: string; workspace: string; cookie: string | undefined; header: string | undefined }> = [];
  const app = new Hono();
  app.use('*', workspaceContextMiddleware);
  app.get('/api/harness/:slug/git/stats', c => {
    const slug = c.req.param('slug');
    const scope = activeWorkspaceId();
    requests.push({ slug, workspace: scope, cookie: c.req.header('cookie'), header: c.req.header('x-papercusp-workspace') });
    if (slug === 'foreign' && scope !== workspace + '-foreign') return c.json({ error: 'unknown project' }, 404);
    return c.json(slug === 'neighbor' ? { notAGitRepo: true, stats: null }
      : { stats: { repository: { head }, footprint: { trackedFiles: 1 } } });
  });
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => app.request(String(url), init));
  try {
    await preflightPrivateStats({ workspace, selected: 'selected', neighbor: 'neighbor', foreign: 'foreign', readonlyRepo },
      'http://127.0.0.1', 'own-cookie', 'foreign-cookie', evidence);
    expect(requests.filter(request => request.slug === 'foreign')).toEqual([
      { slug: 'foreign', workspace, cookie: 'own-cookie', header: undefined },
      { slug: 'foreign', workspace: workspace + '-foreign', cookie: 'foreign-cookie', header: workspace + '-foreign' },
      { slug: 'foreign', workspace, cookie: 'foreign-cookie', header: undefined },
    ]);
  } finally {
    fetch.mockRestore();
    if (previousRoot === undefined) delete process.env.PAPERCUSP_WORKSPACES_ROOT;
    else process.env.PAPERCUSP_WORKSPACES_ROOT = previousRoot;
    if (previousPin === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
    else process.env.PAPERCUSP_WORKSPACE_ID = previousPin;
    rmSync(evidence, { recursive: true, force: true });
  }
});

function testingScopeReads() {
  const read = (slug: string, endpoint: string, status: number, body: object) => ({
    url: `http://127.0.0.1/api/harness/${slug}/testing/${endpoint}`, status, body: JSON.stringify(body),
  });
  return [...(['selected', 'neighbor'] as const).flatMap(role => [
    read(testingPots[role], 'domains?phase=staging', 200, { domains: [{ id: `private-${role}-tests` }] }),
    read(testingPots[role], `domain-detail?domainId=private-${role}-tests`, 200,
      { id: `private-${role}-tests`, totalFiles: 1, sections: [{ files: [{ path: `${role}/${role}.test.ts` }] }] }),
    read(testingPots[role], 'domain-detail?domainId=private-foreign-tests', 404, { error: 'unknown_domain' }),
  ]), read(testingPots.foreign, 'domains?phase=staging', 200, { domains: [{ id: 'private-foreign-tests' }] })];
}

it('accepts Testing pot isolation with deliberate named cross-workspace lookup', () => {
  expect(() => verifyPrivateTestingReadScopes(testingScopeReads(), testingPots)).not.toThrow();
});

it('rejects Testing registries or file details contaminated by another pot', () => {
  const reads = testingScopeReads();
  for (const body of [{ domains: [{ id: 'private-selected-tests' }, { id: 'private-foreign-tests' }] },
    { domains: [{ id: 'private-neighbor-tests' }] }]) {
    expect(() => verifyPrivateTestingReadScopes([{ ...reads[0], body: JSON.stringify(body) }, ...reads.slice(1)], testingPots))
      .toThrow('requested pot domain');
  }
  for (const body of [
    { id: 'private-neighbor-tests', totalFiles: 1, sections: [{ files: [{ path: 'selected/selected.test.ts' }] }] },
    { id: 'private-selected-tests', totalFiles: 1, sections: [{ files: [{ path: 'foreign/foreign.test.ts' }] }] },
  ]) expect(() => verifyPrivateTestingReadScopes([reads[0], { ...reads[1], body: JSON.stringify(body) }, ...reads.slice(2)], testingPots))
    .toThrow();
});

it('requires actual Testing foreign-domain rejection for each requested pot', () => {
  const reads = testingScopeReads();
  for (const index of [2, 5]) {
    expect(() => verifyPrivateTestingReadScopes(reads.filter((_, i) => i !== index), testingPots))
      .toThrow('actual foreign-domain rejection');
    for (const replacement of [{ status: 200 }, { status: 403 }, { body: '{"error":"unknown project"}' }])
      expect(() => verifyPrivateTestingReadScopes(reads.map((read, i) => i === index ? { ...read, ...replacement } : read), testingPots))
        .toThrow();
  }
});

it('requires Testing lookup receipts to correlate the exact slug and domain', () => {
  const reads = testingScopeReads();
  for (const index of [0, 1, 3, 4, 6])
    expect(() => verifyPrivateTestingReadScopes(reads.filter((_, i) => i !== index), testingPots)).toThrow();
  expect(() => verifyPrivateTestingReadScopes([...reads.slice(0, 6), { ...reads[6], status: 404 }], testingPots)).toThrow();
  expect(() => verifyPrivateTestingReadScopes([...reads.slice(0, 6),
    { ...reads[6], body: '{"domains":[{"id":"private-selected-tests"}]}' }], testingPots)).toThrow();
});

it('selects the exact Docs directory by keyboard when index labels repeat', async () => {
  const browser = await chromium.launch({ channel: process.env.PORTAL_BROWSER_CHANNEL ?? 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<aside class="pc-adv-docs__nav">
      <section class="pc-adv-docs__navgroup"><div class="pc-adv-docs__navdir">/</div>
        <button onclick="document.querySelector('output').textContent='index.mdx'">index</button>
        <button>guides</button></section>
      <section class="pc-adv-docs__navgroup"><div class="pc-adv-docs__navdir">guides</div>
        <button onclick="document.querySelector('output').textContent='guides/index.mdx'">index</button></section>
      <section class="pc-adv-docs__navgroup"><div class="pc-adv-docs__navdir">guides/deep</div>
        <button onclick="document.querySelector('output').textContent='guides/deep/index.mdx'">index</button></section>
      </aside><output></output>`);
    expect(await page.getByRole('button', { name: 'index', exact: true }).count()).toBe(3);
    for (const path of ['index.mdx', 'guides/index.mdx', 'guides/deep/index.mdx']) {
      const selected = privateDocsNavButton(page, path);
      expect(await selected.count()).toBe(1);
      await selected.focus(); await page.keyboard.press('Enter');
      expect(await page.locator('output').textContent()).toBe(path);
    }
  } finally { await browser.close(); }
});

it('accepts repeated actual Insights refusals while requiring each distinct UI control', () => {
  const denial = (control: string) => ({ control, status: 403, body: '{"error":{"code":"host_not_allowed"}}' });
  const records = ['cold-overview', 'token-refresh', 'token-refresh', 'token-refresh', 'token-refresh', 'token-refresh', 'warm-overview'].map(denial);
  expect(verifyPrivateInsightsDenialCoverage(records)).toEqual({ hostDenials: 7,
    denialControls: ['cold-overview', 'token-refresh', 'warm-overview'] });
  for (const missing of ['cold-overview', 'token-refresh', 'warm-overview']) {
    expect(() => verifyPrivateInsightsDenialCoverage(records.filter(record => record.control !== missing)))
      .toThrow(`missing actual Host denial for ${missing}`);
  }
});

it('rejects a successful, unrelated or uncorrelated Insights denial receipt', () => {
  const records = ['cold-overview', 'token-refresh', 'warm-overview']
    .map(control => ({ control, status: 403, body: '{"error":{"code":"host_not_allowed"}}' }));
  expect(() => verifyPrivateInsightsDenialCoverage([{ ...records[0], status: 200 }, ...records.slice(1)])).toThrow();
  expect(() => verifyPrivateInsightsDenialCoverage([{ ...records[0], body: '{"error":{"code":"unrelated"}}' }, ...records.slice(1)])).toThrow();
  expect(() => verifyPrivateInsightsDenialCoverage([{ ...records[0], control: 'unknown' }, ...records.slice(1)])).toThrow('intended UI control');
});

it('retains the recorder and private runtime support in every original source census', () => {
  const filePath = 'packages/operator-core/lib/example.integration.test.ts';
  const fixture = 'packages/operator-core/test/__fixtures__/example.ts';
  const paths = isolatedIntegrationProofSourcePaths(filePath, [fixture, filePath, fixture]);
  expect(paths).toEqual([
    filePath, fixture,
    'packages/operator-core/lib/search/import-graph.ts',
    'packages/operator-core/test/isolated-integration-proof.ts',
    'packages/operator-core/test/private-http-workspace-preflight.ts',
    'scripts/lib/isolated-runtime-start.mjs', 'scripts/with-test-pg.mjs',
  ].sort());
  expect(new Set(paths).size).toBe(paths.length);
});

it('pins direct calibrated fixture imports before recording an original lifetime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isolated-calibration-source-'));
  const test = 'claim.e2e.test.ts', support = '__fixtures__/scoped-contracts.e2e.test.ts';
  const testBytes = "import './__fixtures__/scoped-contracts.e2e.test';\n";
  const supportBytes = 'export const fixture = "original";\n';
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  const git = (...args: string[]) => execFileSync('git', ['-C', root,
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    mkdirSync(join(root, '__fixtures__'));
    writeFileSync(join(root, test), testBytes);
    writeFileSync(join(root, support), supportBytes);
    git('init', '-q'); git('add', '.'); git('commit', '-qm', 'original calibrated fixture');
    const commit = git('rev-parse', 'HEAD');
    expect(await isolatedIntegrationSourceFiles(root, commit, [test])).toEqual([
      { path: test, sha256: digest(testBytes), gitSha256: digest(testBytes) },
      { path: support, sha256: digest(supportBytes), gitSha256: digest(supportBytes) },
    ]);
    const changed = 'export const fixture = "changed";\n';
    writeFileSync(join(root, support), changed);
    expect(await isolatedIntegrationSourceFiles(root, commit, [test, support, support])).toEqual([
      { path: test, sha256: digest(testBytes), gitSha256: digest(testBytes) },
      { path: support, sha256: digest(changed), gitSha256: digest(supportBytes) },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('pins an imported private cleanup helper even when the caller lists only the launcher', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isolated-cleanup-source-'));
  const launcher = 'scripts/with-test-pg.mjs';
  const helper = 'scripts/lib/with-test-pg-cleanup.mjs';
  const launcherBytes = "const cleanup = await import('./lib/with-test-pg-cleanup.mjs');\n";
  const helperBytes = 'export const cleanup = "original";\n';
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  const git = (...args: string[]) => execFileSync('git', ['-C', root,
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    mkdirSync(join(root, 'scripts/lib'), { recursive: true });
    writeFileSync(join(root, launcher), launcherBytes);
    writeFileSync(join(root, helper), helperBytes);
    git('init', '-q'); git('add', 'scripts'); git('commit', '-qm', 'original cleanup source');
    const commit = git('rev-parse', 'HEAD');
    const original = await isolatedIntegrationSourceFiles(root, commit, [launcher]);
    expect(original).toEqual([
      { path: launcher, sha256: digest(launcherBytes), gitSha256: digest(launcherBytes) },
      { path: helper, sha256: digest(helperBytes), gitSha256: digest(helperBytes) },
    ]);
    const changedHelper = 'export const cleanup = "changed";\n';
    writeFileSync(join(root, helper), changedHelper);
    const changed = await isolatedIntegrationSourceFiles(root, commit, [launcher, helper]);
    expect(changed).toHaveLength(2);
    expect(changed[1]).toEqual({ path: helper, sha256: digest(changedHelper), gitSha256: digest(helperBytes) });
    expect(digest(JSON.stringify(changed))).not.toBe(digest(JSON.stringify(original)));
    rmSync(join(root, helper));
    await expect(isolatedIntegrationSourceFiles(root, commit, [launcher])).rejects.toThrow();
    const inlineLauncher = 'const cleanup = () => {}; // historical inline cleanup\n';
    writeFileSync(join(root, launcher), inlineLauncher);
    expect(await isolatedIntegrationSourceFiles(root, commit, [launcher])).toEqual([
      { path: launcher, sha256: digest(inlineLauncher), gitSha256: digest(launcherBytes) },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('records submodule source at the original superproject pin even after its checkout moves', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'isolated-source-gitlink-'));
  const root = join(fixture, 'main'), origin = join(fixture, 'origin');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd,
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  try {
    mkdirSync(root); mkdirSync(origin);
    git(origin, 'init', '-q');
    writeFileSync(join(origin, 'source.ts'), 'original pinned source\n');
    git(origin, 'add', 'source.ts'); git(origin, 'commit', '-qm', 'original source');
    git(root, 'init', '-q');
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', origin, 'modules/child');
    writeFileSync(join(root, 'root.ts'), 'parent source\n');
    git(root, 'add', '.gitmodules', 'modules/child', 'root.ts'); git(root, 'commit', '-qm', 'pin child');
    const commit = git(root, 'rev-parse', 'HEAD');
    const path = 'modules/child/source.ts';
    expect(await isolatedIntegrationSourceFiles(root, commit, ['root.ts', path])).toEqual([
      { path: 'root.ts', sha256: digest('parent source\n'), gitSha256: digest('parent source\n') },
      { path, sha256: digest('original pinned source\n'), gitSha256: digest('original pinned source\n') },
    ]);
    writeFileSync(join(root, path), 'new child checkout source\n');
    git(join(root, 'modules/child'), 'add', 'source.ts');
    git(join(root, 'modules/child'), 'commit', '-qm', 'move child checkout');
    writeFileSync(join(root, 'untracked.ts'), 'local only\n');
    expect(await isolatedIntegrationSourceFiles(root, commit, [path, 'untracked.ts'])).toEqual([
      { path, sha256: digest('new child checkout source\n'), gitSha256: digest('original pinned source\n') },
      { path: 'untracked.ts', sha256: digest('local only\n'), gitSha256: null },
    ]);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

it('delivers the intended denial Host on the wire before trusting a private browser falsifier', async () => {
  const measured = await verifyPrivateHostHeaderTransport();
  console.info('PRIVATE_HOST_TRANSPORT_MEASUREMENT ' + JSON.stringify(measured));
  expect(measured.actualHost).toBe('foreign-work.invalid');
  expect(measured.intendedHost).toBe(measured.actualHost);
});

it('preflights native HUD read policy and the exact host denial before private PG', async () => {
  vi.stubEnv('PAPERCUSP_ALLOW_REMOTE_ADMIN', '1');
  vi.stubEnv('PAPERCUSP_DISTRIBUTION_PROFILE', 'hosted-control-plane');
  try {
    expect(await verifyPrivateHudReadPolicy()).toEqual({ denialStatus: 403, denialCode: 'host_not_allowed', allowedReads: 2 });
  } finally { vi.unstubAllEnvs(); }
  expect(() => verifyPrivateHudHostDenial(200, JSON.stringify({ rows: [] }))).toThrow();
  expect(() => verifyPrivateHudHostDenial(403, JSON.stringify({ error: 'loopback_only' }))).toThrow();
  expect(() => verifyPrivateHudHostDenial(403, JSON.stringify({ error: { code: 'unrelated_denial' } }))).toThrow();
});

it('selects exact HUD workspace reads among global subscriptions and rejects missing or contaminated scope', () => {
  expect(verifyPrivateHudCapturePreflight()).toEqual({ scopedCaptureVerified: true });
  const scope = { workspace: 'private-hud', selected: 'selected', neighbor: 'neighbor', foreign: 'foreign' };
  const capture = (workspaceId: string | null, owners: string[], name = 'advRoster.list', status = 200) => ({
    status, name, url: 'http://127.0.0.1/api/zero-harness/rest-query', args: JSON.stringify({ workspaceId, endedLimit: 50 }),
    body: { rows: [{ active: owners.map(ownerId => ({ ownerId })) }] },
  });
  const global = capture(null, [scope.foreign, scope.neighbor, scope.selected]);
  const scoped = capture(scope.workspace, [scope.neighbor, scope.selected]);
  expect(verifyPrivateHudCapturedRoster([global, scoped], scope)).toBe(scoped);
  expect(verifyPrivateHudCapturedRoster([scoped, global], scope)).toBe(scoped);
  for (const read of [global, capture('other-workspace', [scope.selected, scope.neighbor]),
    capture(scope.workspace, [scope.selected, scope.neighbor], 'advRoster.list.other'),
    capture(scope.workspace, [scope.selected, scope.neighbor], 'advRoster.list', 403)]) {
    expect(() => verifyPrivateHudCapturedRoster([read], scope)).toThrow('exact workspace');
  }
  expect(() => verifyPrivateHudCapturedRoster([capture(scope.workspace, [scope.neighbor])], scope)).toThrow('selected owner');
  expect(() => verifyPrivateHudCapturedRoster([capture(scope.workspace, [scope.selected])], scope)).toThrow('neighbor owner');
  expect(() => verifyPrivateHudCapturedRoster([capture(scope.workspace, [scope.selected, scope.neighbor, scope.foreign])], scope))
    .toThrow('foreign owner');
  // Reload evidence must stand alone; the prior epoch cannot rescue a global-only reload.
  expect(() => verifyPrivateHudCapturedRoster([scoped, global].slice(1), scope)).toThrow('exact workspace');
});

it('builds complete private Health seeds with isolated selected and foreign markers', () => {
  const selected = createPrivateHealthSnapshot('selected-workspace', false, 123);
  const foreign = createPrivateHealthSnapshot('foreign-workspace', true, 123);
  expect(Object.keys(selected.panels).sort()).toEqual([...PANEL_ORDER].sort());
  expect(Object.keys(foreign.panels).sort()).toEqual([...PANEL_ORDER].sort());
  expect(selected).toMatchObject({ workspaceId: 'selected-workspace', evaluatedAt: 123, overall: 'warn' });
  expect(selected.panels.workItems).toMatchObject({ key: 'workItems', status: 'warn', summary: 'private-health-selected',
    data: null, link: { href: '/adv?tab=harnesses' } });
  expect(selected.panels.plans).toMatchObject({ status: 'warn', summary: 'private-health-neighbor' });
  expect(selected.panels.deploy).toMatchObject({ status: 'unknown', summary: 'private-health-unmeasured' });
  expect(foreign.workspaceId).toBe('foreign-workspace');
  expect(Object.values(foreign.panels).map(panel => panel.summary)).toEqual(PANEL_ORDER.map(() => 'private-health-foreign'));
});

it('rejects an incomplete API graph before private allocation and reuses only the exact prepared artifact', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-api-preflight-'));
  const bin = join(root, 'apps/operator/bin');
  const prepare = join(root, 'proof/prepare'), execute = join(root, 'proof/execute');
  try {
    mkdirSync(bin, { recursive: true }); mkdirSync(prepare, { recursive: true });
    symlinkSync(resolve(import.meta.dirname, '../../../node_modules'), join(root, 'node_modules'), 'dir');
    // The same executable build boundary, with a tiny real esbuild graph.
    writeFileSync(join(bin, 'bundle-host.sh'), `cd "$(dirname "$0")/.."\necho compiler-started\necho census-diagnostic >&2\nnode -e 'require("esbuild").buildSync({entryPoints:[process.argv[1]],outfile:process.argv[2],bundle:true,platform:"node",format:"esm"})' "$1" "$2"\n`);
    writeFileSync(join(bin, 'hono-host.ts'), 'export { ready } from "./missing.ts";\n');
    expect(() => preparePrivateOperatorApiBundle(root, prepare)).toThrow();
    expect(readFileSync(join(prepare, 'operator-api-build.log'), 'utf8')).toContain('Could not resolve');
    expect(readFileSync(join(prepare, 'operator-api-build.log'), 'utf8')).toContain('compiler-started');
    expect(readFileSync(join(prepare, 'operator-api-build.log'), 'utf8')).toContain('census-diagnostic');
    writeFileSync(join(bin, 'missing.ts'), 'export const ready = true;\n');
    const artifact = preparePrivateOperatorApiBundle(root, prepare);
    expect(resolvePreparedPrivateApiBundle(['--prepared-api-sha=' + artifact.sha256,
      '--prepared-receipt-sha=' + artifact.receiptSha256], execute)).toBe(artifact.path);
    expect(resolvePreparedPrivateApiBundle(['--prepared-api-sha=' + artifact.sha256], execute)).toBe(artifact.path);
    expect(resolvePreparedPrivateApiBundle([], execute)).toBeUndefined();
    expect(() => resolvePreparedPrivateApiBundle(['--prepared-api-sha=' + artifact.sha256,
      '--prepared-api-sha=' + artifact.sha256], execute)).toThrow('exactly one');
    expect(() => resolvePreparedPrivateApiBundle(['--prepared-api-sha=invalid'], execute)).toThrow('SHA256');
    writeFileSync(artifact.path, 'changed artifact\n');
    expect(() => resolvePreparedPrivateApiBundle(['--prepared-api-sha=' + artifact.sha256], execute))
      .toThrow('changed after preflight');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('checks private socket capacity in bytes before runtime allocation, including multibyte scratch roots', () => {
  const suffix = '/papercusp-test-runtime-XXXXXX/tmp/rs-XXXXXX/su-rs-123456789-neighbor.sock';
  const rootAtLimit = '/' + 'x'.repeat(103 - Buffer.byteLength(suffix) - 1);
  expect(Buffer.byteLength(preparePrivateRosterSocketRoot(rootAtLimit))).toBe(103);
  expect(() => preparePrivateRosterSocketRoot(rootAtLimit + 'x')).toThrow('native socket capacity');
  expect(() => preparePrivateRosterSocketRoot('/mnt/backup/d813-history4-ldcW0D')).toThrow('native socket capacity');
  expect(() => preparePrivateRosterSocketRoot('/' + 'é'.repeat(20))).toThrow('native socket capacity');
  expect(() => preparePrivateRosterSocketRoot('relative')).toThrow('must be absolute');
  expect(preparePrivateRosterSocketRoot('/mnt/backup/h-XXXXXX')).toContain('/tmp/rs-XXXXXX/');
});

it('preserves a top-level native assertion and stack before long PG cleanup output', () => {
  const failure = 'AssertionError [ERR_ASSERTION]: private socket directory exceeds the native address limit\n'
    + '    at fixture.ts:28:8\n';
  const detail = isolatedWorkerFailureDetail('bootstrap\n' + failure + '\n' + 'cleanup observation\n'.repeat(2_000));
  expect(detail).toContain(failure.trim());
  expect(detail.length).toBeLessThan(500);
});

it.each([null, 'selected-rollout'])('correlates the production Codex stream key with native discovery %s', rolloutId => {
  const expected = {
    selected: { ownerId: 'selected', sessionId: 17, rolloutId: 'selected-rollout' },
    neighbor: { ownerId: 'neighbor', sessionId: 18, rolloutId: 'neighbor-rollout' },
  };
  const target = sessionTargetFromRoster({ agent: 'codex', advSessionId: 17,
    nativeSession: { backend: 'codex', source: 'adv_sessions', ownerId: 'selected', codexHome: '/private/codex',
      rolloutId, exactResumeSupported: Boolean(rolloutId), missingReason: null } });
  const url = 'http://private.test' + buildSessionStreamUrl('selected', target);
  expect(verifyPrivateHistoryStreams([{ url, status: 200 }], expected)).toEqual([{ url, status: 200 }]);
  // The old numeric-key-only oracle rejects a legitimate production rollout URL.
  expect(new URL(url).searchParams.get('codexSessionKey') === '17').toBe(rolloutId === null);
  for (const stream of [
    { url: url.replace('historyOwner=selected', 'historyOwner=neighbor'), status: 200 },
    { url: url.replace('17', '18').replace('selected-rollout', 'neighbor-rollout'), status: 200 },
    { url, status: 403 },
  ]) expect(() => verifyPrivateHistoryStreams([stream], expected)).toThrow();
  expect(() => verifyPrivateHistoryStreams([{ url, status: 200 }, {
    url: 'http://private.test/api/adv/session/thinking?codexRolloutId=neighbor-rollout&historyOwner=selected', status: 200,
  }], expected)).toThrow('no neighbor stream');
  expect(() => verifyPrivateHistoryStreams([{ url, status: 200 }, {
    url: 'http://private.test/api/adv/session/thinking?codexSessionKey=18&historyOwner=selected', status: 200,
  }], expected)).toThrow('no neighbor stream');
});

it('retains the original browser error and rendered controls when screenshot capture fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'private-browser-failure-'));
  try {
    const page = {
      url: () => 'http://private.test/?agentHistory=selected',
      content: async () => '<button>Open conversation</button>',
      locator: () => ({ innerText: async () => 'selected transcript', allTextContents: async () => ['Open conversation'] }),
      screenshot: async () => { throw new Error('screenshot unavailable'); },
    } as unknown as Parameters<typeof retainPortalBrowserFailure>[0];
    await retainPortalBrowserFailure(page, root, new Error('original missing-control failure'), ['original page error']);
    expect(JSON.parse(readFileSync(join(root, 'portal-browser-failure.json'), 'utf8'))).toMatchObject({
      url: 'http://private.test/?agentHistory=selected', message: 'original missing-control failure',
      text: 'selected transcript', buttons: ['Open conversation'], pageErrors: ['original page error'],
      diagnosticErrors: [{ index: 3, message: 'Error: screenshot unavailable' }],
    });
    expect(readFileSync(join(root, 'portal-browser-failure.html'), 'utf8')).toContain('Open conversation');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function writeNuqsExportFixture(root: string) {
  const files = {
    'node_modules/nuqs/package.json': JSON.stringify({ name: 'nuqs', type: 'module', exports: {
      '.': './dist/index.js', './adapters/react': './dist/adapters/react.js' } }),
    'node_modules/nuqs/dist/index.js': "export { context } from './context.js';",
    'node_modules/nuqs/dist/adapters/react.js': "export { context } from '../context.js';",
    'node_modules/nuqs/dist/context.js': 'export const context = {};',
  };
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), contents);
  }
}

it('bundles exported Nuqs adapters and pins cross-checkout consumers to one Portal context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'private-portal-nuqs-'));
  try {
    const portal = join(root, 'portal');
    const operator = join(root, 'operator');
    writeNuqsExportFixture(portal);
    writeNuqsExportFixture(operator);
    writeFileSync(join(operator, 'consumer.js'), "export { context } from 'nuqs';");
    const result = await build({ stdin: { contents: `import { context } from 'nuqs';
      import { context as adapter } from 'nuqs/adapters/react';
      import { context as operator } from ${JSON.stringify(join(operator, 'consumer.js'))};
      export const sameContext = context === adapter && context === operator;`, resolveDir: operator },
    bundle: true, write: false, format: 'cjs', platform: 'browser', metafile: true, plugins: [portalBrowserPackagesPlugin(portal)] });
    const module: { exports: { sameContext?: boolean } } = { exports: {} };
    new Function('exports', 'module', result.outputFiles[0].text)(module.exports, module);
    expect(module.exports.sameContext).toBe(true);
    expect(Object.keys(result.metafile!.inputs).some(path => path.includes('/operator/node_modules/nuqs/'))).toBe(false);
    // Directory-prefix rewriting must fail this exported-subpath control.
    await expect(build({ stdin: { contents: "import 'nuqs/adapters/react';", resolveDir: operator },
      alias: { nuqs: join(portal, 'node_modules/nuqs') }, bundle: true, write: false, logLevel: 'silent' })).rejects.toThrow('Could not resolve');
    await expect(build({ stdin: { contents: "import 'nuqs/private-internal';", resolveDir: operator },
      plugins: [portalBrowserPackagesPlugin(portal)], bundle: true, write: false, logLevel: 'silent' })).rejects.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('joins Portal providers and frozen-checkout consumers into the selected Sync context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'private-portal-sync-context-'));
  try {
    const portal = join(root, 'portal');
    const operator = join(root, 'invoked-source');
    for (const checkout of [portal, operator]) {
      const pkg = join(checkout, 'node_modules/@papercusp/sync');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({
        name: '@papercusp/sync', type: 'module', exports: './index.js',
      }));
      writeFileSync(join(pkg, 'index.js'), 'export const context = {};');
    }
    writeFileSync(join(operator, 'consumer.js'), "export { context } from '@papercusp/sync';");
    const entry = `import { context as provider } from '@papercusp/sync';
      import { context as consumer } from ${JSON.stringify(join(operator, 'consumer.js'))};
      export const shared = provider === consumer;`;
    const run = async (pinned: boolean) => {
      const result = await build({ stdin: { contents: entry, resolveDir: portal }, bundle: true,
        write: false, format: 'cjs', platform: 'browser', metafile: true,
        plugins: pinned ? [portalBrowserPackagesPlugin(portal, operator)] : [] });
      const module: { exports: { shared?: boolean } } = { exports: {} };
      new Function('exports', 'module', result.outputFiles[0].text)(module.exports, module);
      return { shared: module.exports.shared, inputs: Object.keys(result.metafile!.inputs) };
    };
    expect((await run(false)).shared).toBe(false);
    const pinned = await run(true);
    expect(pinned.shared).toBe(true);
    expect(pinned.inputs.some(path => path.includes('/portal/node_modules/@papercusp/sync/'))).toBe(false);
    expect(pinned.inputs.some(path => path.includes('/invoked-source/node_modules/@papercusp/sync/'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('joins cross-checkout toast producers and observers into one Sonner module store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'private-portal-sonner-'));
  try {
    const portal = join(root, 'portal');
    const operator = join(root, 'operator');
    for (const checkout of [portal, operator]) {
      const pkg = join(checkout, 'node_modules/sonner');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'sonner', type: 'module', exports: './index.js' }));
      writeFileSync(join(pkg, 'index.js'), 'export const store = []; export const toast = value => store.push(value);');
    }
    writeFileSync(join(operator, 'consumer.js'), "export { toast } from 'sonner';");
    const entry = `import { store } from 'sonner';
      import { toast } from ${JSON.stringify(join(operator, 'consumer.js'))};
      toast('Profile saved'); export const observed = store;`;
    const run = async (shared: boolean) => {
      const result = await build({ stdin: { contents: entry, resolveDir: portal }, bundle: true,
        write: false, format: 'cjs', platform: 'browser',
        plugins: shared ? [portalBrowserPackagesPlugin(portal)] : [] });
      const module: { exports: { observed?: string[] } } = { exports: {} };
      new Function('exports', 'module', result.outputFiles[0].text)(module.exports, module);
      return module.exports.observed;
    };
    expect(await run(false)).toEqual([]); // Reproduce the silent split-store failure.
    expect(await run(true)).toEqual(['Profile saved']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'builds the real Plans browser graph through the maintained Portal client boundary before private PG', async () => {
    const { buildPortalRosterBrowser } = await import('../test/portal-roster-browser-fixture');
    const result = await buildPortalRosterBrowser({ portalSourceRoot: process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT!,
      selected: 'preflight-selected', neighbor: 'preflight-neighbor', plans: {
        selectedSlug: 'preflight-selected', neighborSlug: 'preflight-neighbor', selectedTitle: 'preflight-selected',
        neighborTitle: 'preflight-neighbor', harness: 'papercusp' } });
    const paths = [...result.originals.keys()];
    expect(paths.some(path => path.endsWith('/PlansPane.tsx'))).toBe(true);
    expect(paths.some(path => path.endsWith('/operator-surface-build.mjs'))).toBe(true);
    expect(paths.some(path => path.endsWith('/useConfirmDialog.tsx'))).toBe(true);
    expect(paths.some(path => path.includes('/node_modules/undici/'))).toBe(false);
    expect(result.css.length).toBeGreaterThan(0);
  });

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'builds the real ADV Docs panel with production conditional stylesheet exports before private PG', async () => {
    const { buildPortalRosterBrowser } = await import('../test/portal-roster-browser-fixture');
    const result = await buildPortalRosterBrowser({ portalSourceRoot: process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT!,
      selected: 'preflight-selected', neighbor: 'preflight-neighbor', docs: {
        harness: 'preflight-docs', selectedDoc: 'selected.md', neighborDoc: 'neighbor.md',
        selectedHeading: 'selected', neighborHeading: 'neighbor' } });
    const paths = [...result.originals.keys()];
    expect(paths.some(path => path.endsWith('/AdvHarnessPanelPage.tsx'))).toBe(true);
    expect(paths.some(path => path.endsWith('/AdvDocsTab.tsx'))).toBe(true);
    expect(paths.some(path => path.endsWith('/operator-surface-build.mjs'))).toBe(true);
    expect(paths.some(path => path.endsWith('/@excalidraw/excalidraw/dist/prod/index.css'))).toBe(true);
    expect(result.bundle.length).toBeGreaterThan(0);
  }, 120_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'mounts the real standalone ADV Docs panel in a browser before private PG', async () => {
    const { verifyPrivateDocsBrowserMount } = await import('../test/portal-roster-browser-fixture');
    await expect(verifyPrivateDocsBrowserMount({ portalSourceRoot: process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT!,
      selected: 'preflight-selected', neighbor: 'preflight-neighbor', docs: {
        harness: 'preflight-docs', selectedDoc: 'selected.md', neighborDoc: 'neighbor.md',
        selectedHeading: 'selected', neighborHeading: 'neighbor' } })).resolves.toMatchObject({ mounted: true });
  }, 120_000);

it('validates the configured Docs corpus and rejects record-only targets before private PG', async () => {
  const root = realpathSync(join(import.meta.dirname, '../../..'));
  const prepared = await preparePrivateDocsBrowserDocuments(root);
  expect(prepared.docsRoot).toBe(join(root, 'apps/operator-docs/src/content/docs'));
  expect(prepared.bodies[prepared.selection.selectedDoc]).toContain('## Classic Identity');
  expect(prepared.bodies[prepared.selection.neighborDoc]).toContain('## What this is');
  await expect(preparePrivateDocsBrowserDocuments(root, {
    selectedDoc: 'reports/cloud-cross-feature-e2e-2026-10-08.md',
    neighborDoc: 'reports/desktop-design-drift-2026-09-08.md',
    selectedHeading: 'Cloud end-to-end campaign — 2026-10-08',
    neighborHeading: 'Desktop GUI design drift: findings, repair and prevention plan',
  })).rejects.toThrow('has no body in the configured corpus');
});

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'renders the actual standalone Docs markdown body before private PG', async () => {
    const root = realpathSync(join(import.meta.dirname, '../../..'));
    const prepared = await preparePrivateDocsBrowserDocuments(root);
    const { verifyPrivateDocsBrowserMount } = await import('../test/portal-roster-browser-fixture');
    await expect(verifyPrivateDocsBrowserMount({ portalSourceRoot: process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT!,
      selected: 'preflight-selected', neighbor: 'preflight-neighbor',
      docs: { harness: 'preflight-docs', ...prepared.selection },
      markdownPreflight: { value: prepared.bodies[prepared.selection.selectedDoc], heading: prepared.selection.selectedHeading },
    })).resolves.toMatchObject({ mounted: true });
  }, 120_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'builds the real Inbox browser graph through the maintained Portal client boundary before private PG', async () => {
    const { buildPortalRosterBrowser } = await import('../test/portal-roster-browser-fixture');
    const result = await buildPortalRosterBrowser({ portalSourceRoot: process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT!,
      selected: 'preflight-selected', neighbor: 'preflight-neighbor', inbox: {
        selectedMessageId: 'preflight-selected', neighborMessageId: 'preflight-neighbor',
        selectedTitle: 'preflight-selected', neighborTitle: 'preflight-neighbor' } });
    const paths = [...result.originals.keys()];
    expect(paths.some(path => path.endsWith('/InboxPane.tsx'))).toBe(true);
    expect(paths.some(path => path.endsWith('/operator-surface-build.mjs'))).toBe(true);
    expect(paths.some(path => path.endsWith('/delegated-tasks-browser.ts'))).toBe(true);
    expect(paths.some(path => path.endsWith('/lib/delegated-tasks.ts'))).toBe(false);
    expect(paths.some(path => path.includes('/node_modules/undici/'))).toBe(false);
    expect(paths.some(path => path.endsWith('/presence-ui.module.css'))).toBe(true);
    expect(result.css.length).toBeGreaterThan(0);
  });

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'preflights the browser Origin denial input on the wire before a private database run', async () => {
    const receipt = await verifyPrivateProfileOriginControl();
    expect(receipt.continuedControl).toEqual({ origin: 'https://unapproved.invalid', status: 403 });
    // Preserve what the browser actually sent with the old input mechanism.
    // Chromium builds may differ; the fixed precondition must work either way.
    expect([receipt.base, 'https://unapproved.invalid']).toContain(receipt.oldControl.origin);
  });

const stopCleanupStages = ['native-shutdown', 'native-exit', 'session-end-records', 'api-stop', 'listeners-stop',
  'auth-invalidation-listener-stop', 'database-census', 'database-close', 'db-org-pools-reset', 'database-resources-closed'];
function stopCleanupOutput(change: (row: { stage: string; status: string; elapsedMs: number }) => unknown = row => row) {
  return stopCleanupStages.flatMap(stage => ['start', 'complete'].map(status =>
    'ROSTER_STOP_HTTP_CLEANUP_PHASE ' + JSON.stringify(change({ stage, status, elapsedMs: status === 'start' ? 0 : 297 }))))
    .join('\n') + '\nROSTER_STOP_HTTP_CLEANUP {"childrenStopped":true,"apiStopped":true}';
}

it('requires complete original cleanup even when a wrong-target mutation exits as expected', () => {
  const mutation = 'ROSTER_STOP_HTTP_FAILURE {"message":"selected-session receipt correlation"}\n';
  expect(() => verifyPrivateStopCleanup(mutation + stopCleanupOutput())).not.toThrow();
  const failed = stopCleanupOutput(row => row.stage === 'native-exit' && row.status === 'complete'
    ? { ...row, status: 'failed', elapsedMs: 29_571, error: 'Private roster cleanup stalled: native-exit' } : row);
  // This is the observed false positive: correlation + exit 1 + eventual childrenStopped.
  expect(() => verifyPrivateStopCleanup(mutation + failed)).toThrow('every private stop cleanup phase');
});

it('rejects missing and duplicate private stop cleanup phases', () => {
  const output = stopCleanupOutput();
  expect(() => verifyPrivateStopCleanup(output.split('\n').filter(line => !line.includes('native-exit')).join('\n')))
    .toThrow('every private stop cleanup phase');
  expect(() => verifyPrivateStopCleanup(output + '\nROSTER_STOP_HTTP_CLEANUP_PHASE {"stage":"native-exit","status":"complete","elapsedMs":1}'))
    .toThrow('every private stop cleanup phase');
});

it('rejects a late cleanup completion even if an overdue timer did not run first', () => {
  expect(() => verifyPrivateStopCleanup(stopCleanupOutput(row => row.stage === 'native-exit' && row.status === 'complete'
    ? { ...row, elapsedMs: 15_001 } : row))).toThrow('15s deadline');
});

it('requires the original cleanup summary to confirm both native children and API stopped', () => {
  const output = stopCleanupOutput();
  expect(() => verifyPrivateStopCleanup(output.replace('"childrenStopped":true', '"childrenStopped":false'))).toThrow();
  expect(() => verifyPrivateStopCleanup(output.replace('ROSTER_STOP_HTTP_CLEANUP {', 'unrelated {'))).toThrow('one original');
});

it('correlates a private browser stop to the exact owner, managed row, launch and disposition', () => {
  const expected = { ownerId: 'selected', managedSessionId: 17, startedAt: '2026-10-10T03:00:00Z' };
  const receipt = { status: 200, body: { ok: true, ownerId: expected.ownerId, managedSessionId: expected.managedSessionId,
    sessionStartedAt: expected.startedAt, status: 'stop-requested' } };
  expect(() => verifyPrivateStopReceipt(receipt, expected)).not.toThrow();
  expect(() => verifyPrivateStopReceipt(receipt, { ...expected, ownerId: 'neighbor' })).toThrow('selected-owner');
  expect(() => verifyPrivateStopReceipt(receipt, { ...expected, managedSessionId: 18 })).toThrow('selected-session');
  expect(() => verifyPrivateStopReceipt(receipt, { ...expected, startedAt: 'replacement' })).toThrow('selected-launch');
  expect(() => verifyPrivateStopReceipt({ ...receipt, status: 403 }, expected)).toThrow();
  expect(() => verifyPrivateStopReceipt({ ...receipt, body: { ...receipt.body, status: 'queued' } }, expected)).toThrow('stop disposition');
});

it.each([{ summary: 'private-browser-message', wake: false }, { summary: '(nudge from the portal)', wake: true }])(
  'correlates the actual private action payload $summary instead of the HTTP-only marker', async expected => {
    const result = { ok: true, to: ['selected'], msg_id: 'action-message',
      ...(expected.wake ? { wake: { pickupConfirmed: false } } : {}) };
    const receipt = { status: 200, body: { results: [result] } };
    const stored = { to: ['selected'], ...expected };
    expect(await verifyPrivateCoordReceipt(receipt, { ownerId: 'selected', ...expected }, async () => stored)).toBe('action-message');
    await expect(verifyPrivateCoordReceipt(receipt, { ownerId: 'selected', ...expected, summary: 'private-coord-marker' }, async () => stored))
      .rejects.toThrow('persisted action payload correlation');
    await expect(verifyPrivateCoordReceipt(receipt, { ownerId: 'neighbor', ...expected }, async () => stored))
      .rejects.toThrow('selected-recipient receipt correlation');
  });

it('refuses a synchronous private wake receipt that fabricates observed pickup', async () => {
  await expect(verifyPrivateCoordReceipt({ status: 200, body: { results: [{ ok: true, to: ['selected'], msg_id: 'wake',
    wake: { pickupConfirmed: true } }] } }, { ownerId: 'selected', summary: 'nudge', wake: true },
  async () => ({ to: ['selected'], summary: 'nudge', wake: true }))).rejects.toThrow('send-time wake cannot attest pickup');
});

it('validates explicit Portal source before a private runtime even after ambient selection is stripped', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-portal-source-'));
  try {
    for (const file of ['packages/ui/src/agents-popover.tsx', 'app/tokens.css', 'app/globals.css',
      'node_modules/react/package.json', 'node_modules/react-dom/package.json']) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), '{}');
    }
    writeNuqsExportFixture(root);
    vi.stubEnv('PAPERCUSP_TEST_PORTAL_SOURCE_ROOT', undefined);
    expect(preparePortalBrowserSource(['node', 'fixture.ts', '--portal-source=' + root])).toBe(realpathSync(root));
    expect(() => preparePortalBrowserSource(['node', 'fixture.ts'])).toThrow('exactly one explicit');
    expect(() => preparePortalBrowserSource(['--portal-source=relative'])).toThrow('absolute maintained');
    expect(() => preparePortalBrowserSource(['--portal-source=' + root, '--portal-source=' + root])).toThrow('exactly one explicit');
    rmSync(join(root, 'node_modules/nuqs/dist/adapters/react.js'));
    expect(() => preparePortalBrowserSource(['--portal-source=' + root])).toThrow();
    writeNuqsExportFixture(root);
    rmSync(join(root, 'packages/ui/src/agents-popover.tsx'));
    expect(() => preparePortalBrowserSource(['--portal-source=' + root])).toThrow();
  } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});

it('prepares a private foreign workspace before the real HTTP middleware checks it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'private-http-registry-'));
  const workspace = 'test-runtime-registry-control';
  try {
    vi.stubEnv('HOME', join(root, 'home'));
    vi.stubEnv('TMPDIR', join(root, 'tmp'));
    vi.stubEnv('PAPERCUSP_WORKSPACES_ROOT', join(root, 'workspaces'));
    vi.stubEnv('PAPERCUSP_WORKSPACE_ID', workspace);
    const app = new Hono();
    app.use('*', workspaceContextMiddleware);
    app.get('/probe', c => c.json({ admitted: true }));
    const request = () => app.request('/probe', { headers: { 'x-papercusp-workspace': workspace + '-foreign' } });
    expect((await request()).status).toBe(400);
    expect(preparePrivateHttpWorkspaces()).toEqual({ workspace, foreignWorkspace: workspace + '-foreign' });
    expect((await request()).status).toBe(200);
    const registry = JSON.parse(readFileSync(join(root, 'workspaces/registry.json'), 'utf8'));
    expect(registry.workspaces.map((entry: { id: string }) => entry.id)).toEqual([workspace, workspace + '-foreign']);
    // A shared or mismatched root must fail before writing a registry.
    const retained = readFileSync(join(root, 'workspaces/registry.json'), 'utf8');
    vi.stubEnv('TMPDIR', join(root, 'unrelated'));
    expect(preparePrivateHttpWorkspaces).toThrow('disposable runtime scratch');
    expect(readFileSync(join(root, 'workspaces/registry.json'), 'utf8')).toBe(retained);
  } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});

it('retains the original structured worker failure after a long successful cleanup', () => {
  const failure = 'ROSTER_STOP_HTTP_FAILURE ' + JSON.stringify({ message: 'unknown_workspace', stack: 'original assertion' });
  const cleanup = '\npg cleanup progress'.repeat(500);
  expect(isolatedWorkerFailureDetail(failure + cleanup)).toBe(failure);
  expect(isolatedWorkerFailureDetail('unstructured error')).toBe('unstructured error');
});

it('pins the original short-lived Node worker before allowing its command to run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-start-'));
  const child = spawn(process.execPath, ['--import', join(import.meta.dirname, '../../../scripts/lib/isolated-runtime-start.mjs'),
    '-e', "console.log('command-after-observation'); process.exit(7);"], {
    env: { ...process.env, PC_ISOLATED_RUNTIME_START_TOKEN: 'original-token' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  try {
    const captured = captureIsolatedWorker(child, dir, { timeoutMs: 10_000 });
    expect((await once(child, 'message'))[0]).toEqual({ kind: 'isolated-worker-ready', token: 'original-token' });
    const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8');
    child.send({ kind: 'isolated-worker-observed', token: 'wrong-token', accepted: true });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(readFileSync(join(dir, 'worker.log'), 'utf8')).toBe('');
    expect(readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(')').slice(1).join(')').trim().split(/\s+/)[19])
      .toBe(stat.split(')').slice(1).join(')').trim().split(/\s+/)[19]);
    child.send({ kind: 'isolated-worker-observed', token: 'original-token', accepted: true });
    const result = await captured;
    expect(result).toMatchObject({ code: 7, timedOut: false });
    expect(result.output).toContain('command-after-observation');
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

it('refuses to run command code when the original observer disconnects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-unobserved-'));
  const child = spawn(process.execPath, ['--import', join(import.meta.dirname, '../../../scripts/lib/isolated-runtime-start.mjs'),
    '-e', "console.log('unobserved-command-ran');"], {
    env: { ...process.env, PC_ISOLATED_RUNTIME_START_TOKEN: 'original-token' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  try {
    const captured = captureIsolatedWorker(child, dir, { timeoutMs: 10_000 });
    await once(child, 'message');
    child.disconnect();
    const result = await captured;
    expect(result).toMatchObject({ code: 1, timedOut: false });
    expect(result.output).toContain('original worker observer disconnected');
    expect(result.output).not.toContain('unobserved-command-ran');
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

it('composes the nested router budgets without spending execution time on bootstrap', () => {
  const options = isolatedTestFileWorkerOptions({ PAPERCUSP_TEST_FILE_TIMEOUT_MS: '900000', PAPERCUSP_TEST_FILE_LIST_TIMEOUT_MS: '180000' }, 2);
  expect(options.phaseTimeouts).toMatchObject({ bootstrapMs: 180_000, executeMs: 1_082_000 });
  // Widening the encompassing router must not inflate either inner ceiling.
  expect(options.phaseTimeouts.bootstrapMaxMs).toBe(600_000);
  expect(options.phaseTimeouts.teardownMaxMs).toBe(600_000);
  const widened = isolatedTestFileWorkerOptions({ PAPERCUSP_TEST_FILE_TIMEOUT_MS: '1200000', PAPERCUSP_TEST_FILE_LIST_TIMEOUT_MS: '180000' }, 2);
  expect(widened.phaseTimeouts.bootstrapMaxMs).toBe(options.phaseTimeouts.bootstrapMaxMs);
  expect(widened.phaseTimeouts.teardownMaxMs).toBe(options.phaseTimeouts.teardownMaxMs);
  expect(options.killGraceMs).toBeGreaterThanOrEqual(10_000 + 5_000);
  expect(options.testTimeoutMs).toBeGreaterThan(options.phaseTimeouts.bootstrapMs + options.phaseTimeouts.executeMaxMs! + options.phaseTimeouts.teardownMs);
});

it('gives each lifecycle phase its own budget and refuses deadline renewal by repeated IPC', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-phases-'));
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: { bootstrapMs: 100, executeMs: 200, teardownMs: 150 }, killGraceMs: 50 });
    await vi.advanceTimersByTimeAsync(90);
    child.emit('message', { kind: 'isolated-runtime-start' });
    await vi.advanceTimersByTimeAsync(190);
    expect(kill).not.toHaveBeenCalled();
    child.emit('message', { kind: 'isolated-runtime-stopping' });
    await vi.advanceTimersByTimeAsync(140);
    child.emit('message', { kind: 'isolated-runtime-stopping' });
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'teardown', stdioDrainTimedOut: false });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('bounds a missing runtime-start and cannot extend it with unrelated IPC', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-bootstrap-'));
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: { bootstrapMs: 100, executeMs: 200, teardownMs: 150 }, killGraceMs: 50 });
    await vi.advanceTimersByTimeAsync(90); child.emit('message', { kind: 'other' });
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(50);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    Object.assign(child, { signalCode: 'SIGKILL' }); child.emit('exit', null, 'SIGKILL'); child.emit('close', null, 'SIGKILL');
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'bootstrap', signal: 'SIGKILL' });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('extends cleanup for measured original PG writes but refuses logs, counter replay and PID reuse', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-cleanup-progress-'));
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  const sample = (startTicks: string, syscw: string) => child.emit('message', { kind: 'isolated-runtime-cleanup', stage: 'pg-stop-observation',
    processes: [{ pid: 100, startTicks, io: { syscw, write_bytes: '1000' } }] });
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: { bootstrapMs: 100, executeMs: 100, teardownMs: 100, teardownMaxMs: 300 }, killGraceMs: 50 });
    child.emit('message', { kind: 'isolated-runtime-start' });
    child.emit('message', { kind: 'isolated-runtime-stopping' });
    sample('1', '0');
    await vi.advanceTimersByTimeAsync(90); sample('1', '1');
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(90);
    sample('1', '1'); sample('1', '0'); sample('1', '1'); sample('2', '100');
    child.emit('message', { kind: 'isolated-runtime-cleanup', stage: 'pg-log', message: 'noisy shutdown output' });
    // Ordinary CLI visibility must not turn elapsed waiting into measured I/O
    // progress or grant extra time to the original-worker proof route.
    child.emit('message', { kind: 'isolated-runtime-cleanup', stage: 'pg-stop-waiting', elapsedMs: 190 });
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'teardown' });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('separates ordinary cleanup stdout from bootstrap and refuses incomplete, foreign or elapsed-only progress', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'ordinary-cleanup-deadlines-'));
  const child = new ChildProcess();
  Object.assign(child, { pid: 123, stdout: new PassThrough(), stderr: new PassThrough() });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  const line = (supervisorPid: number, stage: string) => '[with-test-pg] cleanup ' + JSON.stringify({
    kind: 'isolated-runtime-cleanup', supervisorPid, stage, elapsedMs: 90,
  }) + '\n';
  try {
    const captured = captureIsolatedWorker(child, dir, { cleanupFromStdout: true,
      phaseTimeouts: { bootstrapMs: 100, executeMs: 100, teardownMs: 100, teardownMaxMs: 300 }, killGraceMs: 50 });
    child.stdout!.emit('data', Buffer.from(line(999, 'start')));
    await vi.advanceTimersByTimeAsync(90);
    const start = line(123, 'start');
    child.stdout!.emit('data', Buffer.from(start.slice(0, -1)));
    await vi.advanceTimersByTimeAsync(5);
    child.stdout!.emit('data', Buffer.from('\n'));
    await vi.advanceTimersByTimeAsync(90);
    expect(kill).not.toHaveBeenCalled();
    child.stdout!.emit('data', Buffer.from(line(999, 'pg-stopped') + line(123, 'pg-stop-waiting')));
    await vi.advanceTimersByTimeAsync(10);
    // The maintained watchdog includes the stall-window boundary. Its first
    // checkpoint may extend from the genuine start; later waiting cannot.
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(90);
    expect(kill).not.toHaveBeenCalled();
    child.stdout!.emit('data', Buffer.from(line(123, 'pg-stop-waiting')));
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'teardown' });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('bounds continuously progressing cleanup at the existing absolute verification ceiling', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-cleanup-ceiling-'));
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: { bootstrapMs: 100, executeMs: 100, teardownMs: 100, teardownMaxMs: 300 }, killGraceMs: 50 });
    child.emit('message', { kind: 'isolated-runtime-start' });
    child.emit('message', { kind: 'isolated-runtime-stopping' });
    for (const stage of ['pg-stop', 'pg-stopped', 'remove-private-state']) {
      await vi.advanceTimersByTimeAsync(90);
      child.emit('message', { kind: 'isolated-runtime-cleanup', stage });
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'teardown' });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('allows actual TERM cleanup to finish before its declared grace and preserves timeout failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-grace-'));
  const child = fork('-e', ["process.on('SIGTERM', () => setTimeout(() => { console.log('cleanup-finished'); process.exit(0); }, 200)); process.send({kind:'isolated-runtime-start'}); setInterval(() => {},1000);"], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    const result = await captureIsolatedWorker(child, dir, { phaseTimeouts: { bootstrapMs: 10_000, executeMs: 100, teardownMs: 1000 }, killGraceMs: 1000 });
    expect(result).toMatchObject({ code: 0, signal: null, timedOut: true, timeoutPhase: 'execute', stdioDrainTimedOut: false });
    expect(result.output).toContain('cleanup-finished');
    expect(JSON.parse(readFileSync(join(dir, 'worker-result.json'), 'utf8'))).toMatchObject({ timedOut: true, timeoutPhase: 'execute' });
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

it('extends progressing bootstrap stages and refuses renewal by noise or repeated stages', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-boot-progress-'));
  const child = new ChildProcess();
  const stdout = new PassThrough(); Object.assign(child, { stdout });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: {
      bootstrapMs: 100, bootstrapMaxMs: 300, executeMs: 100, teardownMs: 100,
    }, killGraceMs: 50 });
    await vi.advanceTimersByTimeAsync(90);
    child.emit('message', { kind: 'isolated-runtime-bootstrap-progress', stage: 'migration:000-baseline.sql' });
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(90);
    stdout.write('noisy NOTICE is not stage progress');
    child.emit('message', { kind: 'isolated-runtime-bootstrap-progress', stage: 'migration:000-baseline.sql' });
    child.emit('message', { kind: 'isolated-runtime-bootstrap-progress', stage: 'invented' });
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'bootstrap' });
  } finally { stdout.destroy(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('enforces the absolute bootstrap ceiling despite distinct continuing stages', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-boot-ceiling-'));
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: {
      bootstrapMs: 100, bootstrapMaxMs: 300, executeMs: 100, teardownMs: 100,
    }, killGraceMs: 50 });
    for (const stage of ['initdb', 'postmaster', 'database']) {
      await vi.advanceTimersByTimeAsync(90);
      child.emit('message', { kind: 'isolated-runtime-bootstrap-progress', stage });
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'bootstrap' });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('waits for observed kernel exit before starting the shorter pipe-drain budget', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-exit-race-'));
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  let settled = false;
  try {
    const captured = captureIsolatedWorker(child, dir, { timeoutMs: 100, killGraceMs: 50, drainGraceMs: 20 }).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(150);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    Object.assign(child, { signalCode: 'SIGKILL' }); child.emit('exit', null, 'SIGKILL'); child.emit('close', null, 'SIGKILL');
    expect(await captured).toMatchObject({ signal: 'SIGKILL', exitWaitTimedOut: false, stdioDrainTimedOut: false });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('cannot renew the execution deadline by repeating runtime-start', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-execution-'));
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: { bootstrapMs: 100, executeMs: 200, teardownMs: 100 }, killGraceMs: 50 });
    child.emit('message', { kind: 'isolated-runtime-start' });
    await vi.advanceTimersByTimeAsync(190); child.emit('message', { kind: 'isolated-runtime-start' });
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'execute' });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('uses the router progress watchdog and still enforces its absolute ceiling', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-progress-'));
  const child = new ChildProcess();
  const stdout = new PassThrough(); Object.assign(child, { stdout });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: { bootstrapMs: 100, executeMs: 200, executeMaxMs: 400, teardownMs: 100 }, killGraceMs: 50 });
    child.emit('message', { kind: 'isolated-runtime-start' });
    await vi.advanceTimersByTimeAsync(190); stdout.write('original-progress\n');
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(190); stdout.write('still-progressing\n');
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'execute' });
  } finally { stdout.destroy(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

isolatedIntegrationCases('attaches per-case isolated runtime evidence after an async test (failing exit: %s)', async (failingExit, context) => {
  await Promise.resolve();
  const runId = failingExit ? '20261008T000001Z-100' : '20261008T000000Z-100';
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  expect(context.task.meta).toMatchObject({ papercuspIsolatedRuntimeRunId: runId });
});

it('retains output before a failing worker closes and preserves its actual exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-capture-'));
  const child = spawn(process.execPath, ['-e', "console.log('original-before-failure'); setTimeout(() => process.exit(7), 100);"], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const result = captureIsolatedWorker(child, dir, { timeoutMs: 10_000 });
    await once(child.stdout!, 'data');
    expect(readFileSync(join(dir, 'worker.log'), 'utf8')).toContain('original-before-failure');
    expect(await result).toMatchObject({ code: 7, signal: null, timedOut: false, stdioDrainTimedOut: false });
    expect(JSON.parse(readFileSync(join(dir, 'worker-result.json'), 'utf8'))).toMatchObject({ code: 7, timedOut: false });
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

it('terminates a worker that ignores TERM and retains the timeout as failure evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-timeout-'));
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('original-hung-worker'); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  try {
    const result = await captureIsolatedWorker(child, dir, { timeoutMs: 2_000, killGraceMs: 100 });
    await exit;
    expect(result).toMatchObject({ code: null, signal: 'SIGKILL', timedOut: true, stdioDrainTimedOut: false });
    expect(result.output).toContain('original-hung-worker');
    expect(JSON.parse(readFileSync(join(dir, 'worker-result.json'), 'utf8'))).toMatchObject({ signal: 'SIGKILL', timedOut: true });
    expect(() => process.kill(child.pid!, 0)).toThrow();
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

it('bounds drainage when an exited worker leaves a descendant holding its pipes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-pipe-'));
  const child = spawn(process.execPath, ['-e', "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] }); console.log('descendant=' + c.pid); process.exit(0);"], { stdio: ['ignore', 'pipe', 'pipe'] });
  let descendant: number | undefined;
  try {
    const result = await captureIsolatedWorker(child, dir, { timeoutMs: 10_000, killGraceMs: 100 });
    descendant = Number(result.output.match(/descendant=(\d+)/)?.[1]);
    expect(descendant).toBeGreaterThan(0);
    expect(result).toMatchObject({ code: 0, signal: null, timedOut: false, stdioDrainTimedOut: true });
    expect(JSON.parse(readFileSync(join(dir, 'worker-result.json'), 'utf8'))).toMatchObject({ stdioDrainTimedOut: true });
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* already gone */ } }
    child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true });
  }
});

it('kills a TERM-ignoring worker and its owned descendant together', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-group-'));
  const source = "const {fork}=require('node:child_process'); process.on('SIGTERM',()=>{}); const d=fork('-e',[\"process.on('SIGTERM',()=>{}); process.send({ready:true}); setInterval(()=>{},1000);\"],{execArgv:[],stdio:['ignore',1,2,'ipc']}); d.on('message',()=>{console.log('descendant='+d.pid); process.send({kind:'isolated-runtime-start'});}); setInterval(()=>{},1000);";
  const child = fork('-e', [source], { detached: true, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let descendant: number | undefined;
  try {
    const result = await captureIsolatedWorker(child, dir, {
      phaseTimeouts: { bootstrapMs: 10_000, executeMs: 100, teardownMs: 1000 }, killGraceMs: 100,
    });
    descendant = Number(result.output.match(/descendant=(\d+)/)?.[1]);
    expect(descendant).toBeGreaterThan(0);
    expect(result).toMatchObject({ signal: 'SIGKILL', timedOut: true, timeoutPhase: 'execute', stdioDrainTimedOut: false });
    // An orphan may await the host reaper as a zombie; it has exited and cannot
    // keep PG, pipes or private files active. A live descendant fails this guard.
    await expect.poll(() => {
      try {
        const stat = readFileSync(`/proc/${descendant}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[0] === 'Z';
      } catch { return true; }
    }, { timeout: 5000 }).toBe(true);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* already exited */ } }
    child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true });
  }
});
