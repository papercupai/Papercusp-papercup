import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as preview from '../../../scripts/source-preview.mjs';
import { buildRuntimeGeneratedInputs, verifyRuntimeGeneratedInputs } from './blind-review-generated-inputs';
import { packRuntimeSourceImage, prepareRuntimeSourceImage } from './blind-review-source-image';
import { admitRuntimeSourceImage } from './blind-review-source-admission';
import { write } from './source-preview.fixture';
import { brokerSourceFixture } from './blind-review-source.fixture';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const helper = fileURLToPath(new URL('../../../scripts/lib/blind-review-sealed-source.py', import.meta.url));

const fixture = (options: Parameters<typeof brokerSourceFixture>[1] = {}) => brokerSourceFixture(roots, options);

describe('broker generated build closure', () => {
  it('measures fixed build outputs and boots all three output classes from the same sealed image after donor removal', async () => {
    const f = await fixture({ gitCheckout: true }); const generated = await buildRuntimeGeneratedInputs(f);
    expect(Object.isFrozen(generated.files)).toBe(true);
    expect(generated.files.map(file => file.path)).toContain('apps/operator/public/wake-runtime/runtime.js');
    expect(generated.files.map(file => file.path)).toContain('apps/operator/dist-verify/spa/index.html');
    expect(generated.files.some(file => file.path.includes('/spa-build/'))).toBe(false);
    const image = await packRuntimeSourceImage({ ...f, generated });
    try {
      await expect(admitRuntimeSourceImage({ ...image }, { repositoryId: 'fixture-repository' }))
        .rejects.toThrow('broker_source_origin_unavailable');
      // Change the mutable preparation after sealing. Admission must inspect
      // only the retained image and compare with independent committed Git bytes.
      write(f.root, 'apps/operator/bin/build.cjs', 'changed donor bytes');
      const admission = await admitRuntimeSourceImage(image, { repositoryId: 'fixture-repository' });
      expect(admission.censusStatus).toBe('admit');
      expect(admission.sourceImageNonce).toBe(image.sourceImageNonce);
      rmSync(f.root, { recursive: true }); rmSync(f.repositoryRoot, { recursive: true });
      const result = spawnSync('/usr/bin/python3', ['-I', '-S', helper, 'seal-exec', '--sha256', image.imageSha256,
        '--max-bytes', String(image.imageBytes), '--', '/usr/bin/python3', '-I', '-S', helper,
        'mount-exec', '--sha256', image.imageSha256, '--max-bytes', String(image.imageBytes),
        '--manifest-sha256', image.manifestSha256, '--', '/usr/bin/python3', '-I', '-S', '-c', `
import json,os
assert 'measured host' in open('/source/apps/operator/dist-verify/hono-host.mjs').read()
assert 'measured spa' in open('/source/apps/operator/dist-verify/spa/index.html').read()
assert open('/source/apps/operator/public/wake-runtime/runtime.js').read() == 'measured prebuild'
build=json.load(open('/source/.broker-build.json'))
assert len(build['files']) >= 5
assert not os.path.exists('/source/.git')
print('GENERATED_CLOSURE_BOOTED')`],
      { stdio: ['ignore', 'pipe', 'pipe', image.handle.fd], encoding: 'utf8', timeout: 20_000 });
      expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('GENERATED_CLOSURE_BOOTED');
    } finally { await image.handle.close(); }
  }, 30_000);

  it.each(['generated-bytes', 'unrecorded-output', 'dependency-bytes', 'source-bytes', 'redirect'])(
    'refuses changed closure before image publication (%s)', async defect => {
      const f = await fixture(); const generated = await buildRuntimeGeneratedInputs(f);
      if (defect === 'generated-bytes') write(f.root, 'apps/operator/dist-verify/hono-host.mjs', 'changed');
      if (defect === 'unrecorded-output') write(f.root, 'apps/operator/dist-verify/new.mjs', 'unknown');
      if (defect === 'dependency-bytes') write(f.root, 'node_modules/dep/index.js', 'changed');
      if (defect === 'source-bytes') write(f.root, 'apps/operator/bin/build.cjs', 'changed');
      if (defect === 'redirect') {
        rmSync(join(f.root, 'apps/operator/dist-verify/hono-host.mjs'));
        symlinkSync('/etc/passwd', join(f.root, 'apps/operator/dist-verify/hono-host.mjs'));
      }
      await expect(packRuntimeSourceImage({ ...f, generated })).rejects.toThrow();
      expect(readdirSync(f.custodyRoot).some(name => name.startsWith('broker-source-'))).toBe(false);
    }, 30_000);

  it('rejects receipt-shaped copies and never adopts pre-existing generated outputs', async () => {
    const f = await fixture(); const generated = await buildRuntimeGeneratedInputs(f);
    await expect(verifyRuntimeGeneratedInputs(f.root, f.source, f.dependencies,
      JSON.parse(JSON.stringify(generated)))).rejects.toThrow('broker_generated_provenance_invalid');
    await expect(buildRuntimeGeneratedInputs(f)).rejects.toThrow('broker_generated_output_already_exists');
    expect(readdirSync(f.custodyRoot).some(name => name.startsWith('broker-build-'))).toBe(false);
  }, 30_000);

  it('requires complete build output even when every build command exits successfully', async () => {
    const f = await fixture({ omitAssets: true });
    await expect(buildRuntimeGeneratedInputs(f)).rejects.toThrow('broker_generated_build_incomplete');
    expect(readdirSync(f.custodyRoot).some(name => name.startsWith('broker-build-'))).toBe(false);
  }, 30_000);

  it('honors cancellation before allocating private build state', async () => {
    const f = await fixture();
    const controller = new AbortController(); controller.abort();
    await expect(buildRuntimeGeneratedInputs({ ...f, signal: controller.signal })).rejects.toThrow();
    expect(readdirSync(f.custodyRoot).some(name => name.startsWith('broker-build-'))).toBe(false);
  });

  it('names the drifting dependency stage and retains diagnostic inputs before expensive later builds', async () => {
    const f = await fixture();
    const phases = join(f.custodyRoot, 'phases.jsonl');
    const runPhase = preview.verifierPhaseRunner(phases,
      { PAPERCUSP_CHECKPOINT_LOG_DIR: join(f.custodyRoot, 'archive') }, join(f.custodyRoot, 'child.json'));
    const actual = preview.runVerifierDependencyCommand;
    vi.spyOn(preview, 'runVerifierDependencyCommand').mockImplementation(async (command, args, options) => {
      const result = await actual(command, args, options);
      if (args.includes('prebuild')) write(f.root, 'node_modules/dep/index.js', 'changed by build');
      return result;
    });
    await expect(buildRuntimeGeneratedInputs({ ...f, runPhase })).rejects.toMatchObject({
      name: 'RuntimeBuildDependencyDrift', stage: 'prebuild', retainVerifierTree: true,
      changes: ['node_modules/dep/index.js'],
    });
    expect(readdirSync(f.custodyRoot).some(name => name.startsWith('broker-build-'))).toBe(true);
    expect(existsSync(join(f.root, 'apps/operator/dist-verify/hono-host.mjs'))).toBe(false);
    const events = readFileSync(phases, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { phase: string; event: string });
    expect(events).toContainEqual(expect.objectContaining({ phase: 'build.prebuild', event: 'completed' }));
    expect(events).toContainEqual(expect.objectContaining({ phase: 'deps.census', event: 'progress' }));
    expect(events).toContainEqual(expect.objectContaining({ phase: 'build.prebuild.verify', event: 'failed' }));
    expect(events.some(event => event.phase === 'build.spa')).toBe(false);
    rmSync(phases);
    expect(readFileSync(runPhase.archivePath, 'utf8')).toContain('build.prebuild.verify');
  }, 30_000);

  it('retains private build inputs when a dependency command cannot verify process-group exit', async () => {
    const f = await fixture();
    const failure = new AggregateError([Object.assign(new Error('group still live'), { retainVerifierTree: true })]);
    vi.spyOn(preview, 'runVerifierDependencyCommand').mockRejectedValueOnce(failure);
    await expect(buildRuntimeGeneratedInputs(f)).rejects.toBe(failure);
    expect(readdirSync(f.custodyRoot).some(name => name.startsWith('broker-build-'))).toBe(true);
  });

  it('retains the source tree when dependency preparation reports an unverified live writer', async () => {
    const f = await fixture();
    const failure = new Error('dependency fence failed', {
      cause: Object.assign(new Error('group still live'), { retainVerifierTree: true }) });
    vi.spyOn(preview, 'prepareVerifierSource').mockResolvedValueOnce(f.source);
    vi.spyOn(preview, 'prepareVerifierDependencies').mockRejectedValueOnce(failure);
    await expect(prepareRuntimeSourceImage({ repositoryRoot: f.repositoryRoot, custodyRoot: f.custodyRoot,
      sourceCommit: f.source.sourceCommit, inputs: ['apps/operator/bin/build.cjs'] })).rejects.toBe(failure);
    expect(readdirSync(f.custodyRoot).some(name => name.startsWith('broker-prepare-'))).toBe(true);
  });
});
