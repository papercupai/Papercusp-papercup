/**
 * WI-10006543: the off-thread runner for graph:query callers. Forks the real
 * worker (`first-party-callers.worker.ts`, under Node's native type stripping)
 * against a throwaway repo, and fake workers for the failure paths. Every
 * failure must be an error answer, never a bare empty.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firstPartyCallers } from './first-party-callers';
import { defaultFirstPartyCallersWorker, firstPartyCallersOffthread } from './first-party-callers-offthread';

// createRequire(<dir>/noop.js)('typescript') from the package resolves the repo's own typescript.
const VENDOR_DIR = resolve(__dirname, '../..');

const FILES: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true } }),
  'src/a.ts': 'export function target(n: number): number {\n  return n + 1;\n}\n',
  'src/barrel.ts': 'export * from "./a";\n',
  'src/use.ts': 'import { target } from "./barrel";\nexport const one = target(1);\nexport const two = target(2);\n',
};

let root = '';
let fakes = '';
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'first-party-callers-offthread-'));
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  fakes = mkdtempSync(join(tmpdir(), 'first-party-callers-fakes-'));
  writeFileSync(join(fakes, 'hang.mjs'), 'process.on("message", () => {}); setInterval(() => {}, 1000);\n');
  writeFileSync(join(fakes, 'exit.mjs'), 'process.on("message", () => { console.error("Error: boom from the fake"); process.exit(3); });\n');
  writeFileSync(join(fakes, 'junk.mjs'), 'process.on("message", () => process.send({ nope: true }, () => process.disconnect()));\n');
  writeFileSync(join(fakes, 'progress-hang.mjs'), 'process.on("message", job => process.send({ kind: "first-party-callers-progress", phase: job.name, elapsedMs: 12 })); setInterval(() => {}, 1000);\n');
  writeFileSync(join(fakes, 'invalid-progress.mjs'), 'process.on("message", () => process.send({ kind: "first-party-callers-progress", phase: "compiler-query", elapsedMs: -1 }, () => process.disconnect()));\n');
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(fakes, { recursive: true, force: true });
});

const keys = (sites: readonly { path: string; line1: number | null }[]): string[] => sites.map((s) => `${s.path}:${s.line1}`).sort();

describe('firstPartyCallersOffthread', () => {
  it('resolves the unbundled .ts worker beside the module when no bundle is staged', () => {
    expect(defaultFirstPartyCallersWorker()).toMatch(/first-party-callers\.worker\.ts$/);
  });

  it('answers in a forked worker exactly as the in-process library does', async () => {
    const off = await firstPartyCallersOffthread({ vendorDir: VENDOR_DIR, root, name: 'target' });
    expect(off.error).toBeNull();
    expect(off.backend).toBe('typescript-service');
    expect(keys(off.sites)).toEqual(['src/use.ts:2', 'src/use.ts:3']);
    const inline = firstPartyCallers({ ts, root, name: 'target' });
    expect(keys(off.sites)).toEqual(keys(inline.sites));
    expect(off.attribution?.resolved).toBe(inline.attribution?.resolved);
  }, 60_000);

  it('kills a worker that passes its deadline and answers with an error', async () => {
    const t0 = Date.now();
    const a = await firstPartyCallersOffthread(
      { vendorDir: VENDOR_DIR, root, name: 'target' },
      { workerPath: join(fakes, 'hang.mjs'), budgetMs: 400 },
    );
    expect(a.error).toMatch(/exceeded its 400 ms deadline/);
    expect(a.sites).toEqual([]);
    expect(a.freshness.health).toBe('unhealthy');
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('reports a worker that exits before answering, with its stderr cause', async () => {
    const a = await firstPartyCallersOffthread(
      { vendorDir: VENDOR_DIR, root, name: 'target' },
      { workerPath: join(fakes, 'exit.mjs') },
    );
    expect(a.error).toMatch(/exited \(3\) before answering: Error: boom from the fake/);
    expect(a.sites).toEqual([]);
  });

  it.each(['compiler-query', 'source-tree', 'source-capture', 'source-diff', 'source-clones', 'source-calls'])(
    'retains measured %s progress on a deadline without accepting it as an answer', async (phase) => {
    const result = await firstPartyCallersOffthread(
      { vendorDir: VENDOR_DIR, root, name: phase },
      { workerPath: join(fakes, 'progress-hang.mjs'), budgetMs: 2_000 },
    );
    expect(result.error).toContain('exceeded its 2000 ms deadline');
    expect(result.error).toContain(`last measured phase=${phase}, workerElapsedMs=12`);
    expect(result.sites).toEqual([]);
    expect(result.freshness.health).toBe('unhealthy');
  }, 15_000);

  it('refuses an invalid progress frame rather than extending the worker deadline', async () => {
    const result = await firstPartyCallersOffthread(
      { vendorDir: VENDOR_DIR, root, name: 'target' },
      { workerPath: join(fakes, 'invalid-progress.mjs') },
    );
    expect(result.error).toContain('not an answer');
    expect(result.sites).toEqual([]);
  });

  it('refuses a reply that is not an answer', async () => {
    const a = await firstPartyCallersOffthread(
      { vendorDir: VENDOR_DIR, root, name: 'target' },
      { workerPath: join(fakes, 'junk.mjs') },
    );
    expect(a.error).toMatch(/not an answer/);
  });

  it('answers with an error when the vendored TypeScript cannot be loaded', async () => {
    const a = await firstPartyCallersOffthread({ vendorDir: join(fakes, 'no-such-vendor'), root, name: 'target' });
    expect(a.error).toMatch(/^could not load the vendored TypeScript/);
    expect(a.sites).toEqual([]);
  }, 60_000);
});
