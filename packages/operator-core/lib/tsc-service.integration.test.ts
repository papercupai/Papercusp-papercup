import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
// eslint-disable-next-line import/no-relative-packages
import { tscServiceIdentity } from '../../../scripts/lib/tsc-service.mjs';
import { readProcessIdentity } from './process-identity';

it('completes a source-bound request through the installed focused socket service without full fallback', async context => {
  const verifierRoot = resolve(import.meta.dirname, '../../..');
  // The fixed installed socket serves its configured checkout. An immutable
  // verifier clone must verify that source, not send its different root to a
  // daemon whose root fence is required to reject it.
  const configuredRoot = process.env.PAPERCUSP_TSC_SERVICE_ROOT || execFileSync('systemctl',
    ['--user', 'show', 'papercup-tsc-service.service', '-p', 'WorkingDirectory', '--value'],
    { encoding: 'utf8', timeout: 5_000 }).trim();
  expect(isAbsolute(configuredRoot), 'installed service root must be explicit').toBe(true);
  const root = resolve(configuredRoot);
  const comparedPaths = ['scripts/lib/tsc-service.mjs', 'scripts/tsc-service/server.mjs',
    'packages/operator-core/tsconfig.json', 'packages/operator-core/lib/serving-build.ts'];
  for (const path of comparedPaths)
    expect(readFileSync(resolve(root, path)), `installed source differs: ${path}`)
      .toEqual(readFileSync(resolve(verifierRoot, path)));
  const service = await import(pathToFileURL(resolve(root, 'scripts/lib/tsc-service.mjs')).href);
  const request = { root, project: resolve(root, 'packages/operator-core/tsconfig.json'),
    files: ['packages/operator-core/lib/serving-build.ts'], scope: 'named', requestId: randomUUID() };
  const socketPath = service.tscServiceSocketPath();
  const expected = tscServiceIdentity(request);
  const identity = service.tscServiceIdentity(request);
  expect(identity).toMatchObject({ serviceSourceSha256: expected.serviceSourceSha256,
    compilerArtifactsSha256: expected.compilerArtifactsSha256, compilerVersion: expected.compilerVersion,
    projectConfigSha256: expected.projectConfigSha256, namedSources: expected.namedSources });
  const progress: unknown[] = [];
  const result = await service.requestTscService({ socketPath, request, timeoutMs: 30_000,
    onProgress: (entry: unknown) => progress.push(entry) });
  expect(result).toMatchObject({ kind: 'result', ok: true, requestId: request.requestId, identity,
    errorCount: 0, checked: request.files, namedNotInProgram: [] });
  expect(result).not.toHaveProperty('fallback');
  expect(progress.length, 'the service must acknowledge this request before its terminal result').toBeGreaterThan(0);
  for (const entry of progress) {
    expect(entry).toMatchObject({ kind: 'progress', requestId: request.requestId, identity });
    expect(['accepted', 'queued']).toContain((entry as { phase: string }).phase);
  }
  const runtime = result.runtime as { pid: number; startedAt: number };
  expect(runtime.pid).toBeGreaterThan(0);
  expect(runtime.startedAt).toBeGreaterThan(0);
  const processIdentity = readProcessIdentity(runtime.pid);
  expect(processIdentity).toBeTruthy();
  const receipt = { observedAt: new Date().toISOString(), verifierRoot, comparedPaths, socketPath, request, identity,
    progress, result, processIdentity };
  Object.assign(context.task.meta, { papercuspFocusedServiceReceipt: receipt });
  console.info('FRICTION_FOCUSED_SERVICE_RECEIPT ' + JSON.stringify(receipt));
}, 40_000);
