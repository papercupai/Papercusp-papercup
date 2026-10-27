import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Module, { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { writeStdoutSync } from '../../../scripts/lib/write-stdout-sync.mjs';
import { parseArgs } from 'node:util';
import { moduleRepoRoot } from '@papercusp/operator-core/lib/module-repo-root';
import { prepareDesktopPortalHostBundle } from './desktop-portal-host-bundle.ts';
import { createDesktopPortalHost } from './desktop-portal-host.ts';

const { values } = parseArgs({ options: {
  'portal-root': { type: 'string' }, 'papercusp-root': { type: 'string' },
  'compile-only': { type: 'boolean', default: false },
} });
if (!values['portal-root']) throw new Error('--portal-root must name the maintained portal checkout');
const papercuspRoot = values['papercusp-root'] ?? moduleRepoRoot(import.meta.url);
const result = await prepareDesktopPortalHostBundle({
  portalRoot: values['portal-root'], papercuspRoot,
  outputFile: resolve(values['portal-root'], 'desktop-portal-memory-only.cjs'),
});
const identity = {
  sourceFingerprint: result.sourceFingerprint, sourceInputs: result.inputs,
  desktopAdapterInput: result.desktopAdapterInput,
  graphInputCount: Object.keys(result.metafile.inputs).length,
  outputBytes: result.outputFiles[0].contents.length,
  outputFingerprint: createHash('sha256').update(result.outputFiles[0].contents).digest('hex'),
};
if (values['compile-only']) {
  // Synchronous: process.exit() would truncate a buffered console.log to a pipe.
  writeStdoutSync(`${JSON.stringify({ schemaVersion: 'desktop-portal-host-preflight-v1', ok: true,
    ...identity, outputsWritten: false, listenerStarted: false, persistentStoreOpened: false,
    scope: 'In-memory local portal host compilation only; runtime acceptance remains unverified.',
  })}\n`);
  process.exit(0);
}
// Evaluate the prepared CommonJS bytes in memory. External dependencies resolve
// from the measured portal source, exactly as they will for its private package.
const filename = resolve(result.source.root, 'desktop-portal-memory-only.cjs');
const memoryModule = new Module(filename);
const load = createRequire(filename);
const evaluate = new Function('exports', 'require', 'module', '__filename', '__dirname', result.outputFiles[0].text);
evaluate(memoryModule.exports, load, memoryModule, filename, result.source.root);
const { createPortalRuntime, createDesktopPortalApplication } = memoryModule.exports;
// Explicit ephemeral qualification fixture. The packaged factory's default
// createPortalRuntime() remains persistent; this probe never opens that store.
const runtime = await createPortalRuntime({ memory: true });
const upstream: Array<{ path: string; workspace: string | null }> = [];
const host = await createDesktopPortalApplication({ runtime, ownerId: 'desktop-preflight', createHost: createDesktopPortalHost,
  operator: async (request: Request) => {
    upstream.push({ path: new URL(request.url).pathname, workspace: request.headers.get('x-papercusp-workspace') });
    return Response.json({ ok: true, service: 'desktop-operator-preflight' });
  },
});
const request = (path: string, init?: RequestInit) => host.fetch(new Request(`http://localhost:21696${path}`, init));
const checks: string[] = [];
try {
  const apps = await (await request('/api/apps')).json();
  assert.equal(apps.ok, true);
  assert.ok(apps.apps.some((app: { slug: string }) => app.slug === 'home'));
  checks.push('maintained local portal app registry');
  const put = await request('/api/preferences', { method: 'PUT', headers: {
    origin: 'http://tauri.localhost', 'content-type': 'application/json',
  }, body: JSON.stringify({ theme: 'dark' }) });
  assert.equal(put.status, 200);
  const preferences = await (await request('/api/preferences')).json();
  assert.equal(preferences.preferences.theme, 'dark');
  checks.push('maintained local preference write/read');
  assert.equal(upstream.length, 0);
  const health = await (await request('/api/health')).json();
  assert.equal(health.service, 'desktop-operator-preflight');
  const native = await request('/api/desktop-preflight', { headers: { 'x-papercusp-workspace': 'window-A' } });
  assert.equal(native.status, 200);
  assert.deepEqual(upstream, [
    { path: '/api/health', workspace: null },
    { path: '/api/desktop-preflight', workspace: 'window-A' },
  ]);
  checks.push('maintained passthrough terminates in inner operator once with workspace');
  const denied = await request('/api/preferences', { headers: { origin: 'https://foreign.example' } });
  assert.equal(denied.status, 403);
  checks.push('foreign origin refused before local portal identity');
  const voice = await (await request('/api/voice/engines')).json();
  assert.equal(voice.ok, true);
  assert.equal((await request('/api/voice/elevenlabs/token', { method: 'POST' })).status, 404);
  checks.push('external voice provider unconfigured');
} finally {
  await host.stop();
}
console.log(JSON.stringify({
  schemaVersion: 'desktop-portal-host-preflight-v1', ok: true,
  preparedAt: new Date().toISOString(), ...identity,
  checks, outputsWritten: false, listenerStarted: false, persistentStoreOpened: false,
  scope: 'Actual maintained local portal API with an ephemeral store and a fixture inner operator. Native/installed/hosted/public acceptance remains unverified.',
}, null, 2));
