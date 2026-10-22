import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

it('replays the leaf test core from a host bundle without rebinding its occupied port', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const directory = await mkdtemp(join(tmpdir(), 'testing-run-bundled-recovery-'));
  const bundle = join(directory, 'hono-host.mjs');
  const require = createRequire(join(root, 'package.json'));
  try {
    // Compile the real tool into a host-shaped entrypoint while keeping its
    // dependencies external. Its import.meta.url now names this server bundle.
    await build({
      entryPoints: [join(root, 'packages/operator-core/lib/agent-tools/testing/run.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'es2022',
      logLevel: 'silent',
      plugins: [{
        name: 'external-tool-dependencies',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === 'entry-point') return;
            return {
              path: args.path.startsWith('.') || isAbsolute(args.path)
                ? resolve(args.resolveDir, args.path)
                : require.resolve(args.path),
              external: true,
            };
          });
        },
      }],
      footer: { js: `
import { createServer as createRecoveryTestHost } from 'node:net';
const recoveryTestHost = createRecoveryTestHost();
await new Promise((resolve, reject) => {
  recoveryTestHost.once('error', reject);
  recoveryTestHost.listen(Number(process.env.TEST_RECOVERY_HOST_PORT || 0), '127.0.0.1', resolve);
});
process.env.TEST_RECOVERY_HOST_PORT = String(recoveryTestHost.address().port);
globalThis.recoveryTestHost = recoveryTestHost;
` },
    });
    const parent = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
const { buildDetachedTestRunRequest } = await import(${JSON.stringify(pathToFileURL(bundle).href)});
try {
  const request = buildDetachedTestRunRequest({
    root: ${JSON.stringify(root)}, files: ['unused.test.ts'],
    deadline: { startedAtMs: 0, taskDeadlineAtMs: 1, childCutoffAtMs: 0, cleanupReserveMs: 1 },
  });
  try {
    const control = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      'await import(' + ${JSON.stringify(JSON.stringify(pathToFileURL(bundle).href))} + ');'], {
      cwd: request.cwd, env: process.env, encoding: 'utf8', timeout: 45000,
    });
    const child = spawnSync(request.command, request.args, {
      cwd: request.cwd, env: { ...process.env, ...request.env }, encoding: 'utf8', timeout: 45000,
    });
    console.log('RECOVERY_RESULT ' + JSON.stringify({ status: child.status, stdout: child.stdout, stderr: child.stderr,
      error: child.error?.message, hostStillListening: globalThis.recoveryTestHost.listening,
      controlStatus: control.status, controlStderr: control.stderr, controlError: control.error?.message }));
  } finally {
    const { rmSync } = await import('node:fs');
    for (const artifact of request.detachedReportArtifacts ?? [])
      rmSync(dirname(artifact.reportPath), { recursive: true, force: true });
  }
} finally {
  globalThis.recoveryTestHost.close();
}
`], { cwd: root, encoding: 'utf8', timeout: 55_000 });
    expect(parent.error, parent.stderr).toBeUndefined();
    expect(parent.status, parent.stderr).toBe(0);
    const line = parent.stdout.split('\n').find(value => value.startsWith('RECOVERY_RESULT '));
    expect(line, parent.stdout).toBeDefined();
    const result = JSON.parse(line!.slice('RECOVERY_RESULT '.length));
    expect(result.controlError).toBeUndefined();
    expect(result.controlStatus).toBe(1);
    expect(result.controlStderr).toContain('EADDRINUSE');
    expect(result.error).toBeUndefined();
    expect(result.stderr).not.toContain('EADDRINUSE');
    expect(result.hostStillListening).toBe(true);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toMatchObject({ ok: false, error: 'deadline_exhausted' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
