import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

describe('published verifier-source package entrypoint', () => {
  it('resolves through fresh Node package exports and loads its receipt reader', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      'const source = await import("@papercusp/verification-harness/verifier-source"); if (typeof source.readVerifierSourceReceiptSync !== "function" || typeof source.findVerifierSourceRoot !== "function") throw new Error("incomplete verifier-source exports"); console.log("verifier-source-loaded");'],
    { cwd: root, encoding: 'utf8', timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('verifier-source-loaded');
  });
});
