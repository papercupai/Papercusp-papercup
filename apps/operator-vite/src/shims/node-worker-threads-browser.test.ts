import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { MessageChannel, receiveMessageOnPort, Worker } from './node-worker-threads-browser';

describe('worker thread browser boundary', () => {
  it('bundles the decision transport against the browser shim', async () => {
    const shim = resolve(__dirname, 'node-worker-threads-browser.ts');
    const result = await build({
      entryPoints: [resolve(__dirname, '../../../../libs/generic/decision-model/src/worker-transport.ts')],
      bundle: true, platform: 'node', format: 'esm', write: false, treeShaking: false,
      plugins: [{ name: 'worker-thread-browser-boundary', setup(builder) {
        builder.onResolve({ filter: /^node:worker_threads$/ }, () => ({ path: shim }));
      } }],
    });
    expect(result.errors).toEqual([]);
    expect(result.outputFiles[0].text).toContain('cannot run in the operator-vite browser bundle');
  });

  it('refuses server worker operations when reached in a browser', () => {
    const worker = Worker as unknown as new () => object;
    const channel = MessageChannel as unknown as new () => object;
    for (const operation of [() => new worker(), () => new channel(), () => receiveMessageOnPort()]) {
      expect(operation).toThrow('node:worker_threads is server-only');
    }
  });
});
