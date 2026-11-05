import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { buildWorkspace, captureClosure, verifyClosure } from '../apps/operator/bin/release/dependency-generation-verifier.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function write(root, path, body) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'verifier-source-census-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  write(root, '.gitignore', 'node_modules/\ndist/\napps/operator/dist-verify/\n');
  write(root, 'package.json', '{"name":"census-fixture","private":true}');
  return root;
}
function generatedPackage(root, path) {
  write(root, path + '/package.json', JSON.stringify({ name: 'generated-bin', bin: 'dist/cli.cjs' }));
  write(root, path + '/src/cli.cjs', 'console.log("source-census");\n');
}
function ignoredCandidate(root) {
  // A retained native candidate is an output, even though it contains a full
  // source checkout and real package manifests with generated bin entries.
  const path = 'apps/operator/dist-verify/retained-candidate/packages/omp-plugin';
  generatedPackage(root, path);
  return path;
}

test('closure capture ignores retained candidates without weakening real workspace custody', () => {
  const root = fixture();
  generatedPackage(root, 'packages/cli');
  buildWorkspace(root, 'packages/cli', [process.execPath, '-e',
    'const fs=require("node:fs");fs.mkdirSync("dist");fs.copyFileSync("src/cli.cjs","dist/cli.cjs");']);
  ignoredCandidate(root);

  const closure = captureClosure(root);
  assert.equal(closure.complete, true, closure.reason);
  assert.deepEqual(closure.workspaces.map(entry => entry.output), ['packages/cli/dist']);
  assert.equal(readFileSync(join(root, 'packages/cli/dist/cli.cjs'), 'utf8'), 'console.log("source-census");\n');

  rmSync(join(root, 'packages/cli/dist/.papercusp-workspace-build.json'));
  const missing = captureClosure(root);
  assert.equal(missing.complete, false);
  assert.match(missing.reason, /packages\/cli\/dist\/\.papercusp-workspace-build\.json/);
});

test('a new untracked source package still requires a generated-output receipt', () => {
  const root = fixture();
  ignoredCandidate(root);
  generatedPackage(root, 'packages/new-cli');
  const closure = captureClosure(root);
  assert.equal(closure.complete, false);
  assert.match(closure.reason, /packages\/new-cli\/dist\/\.papercusp-workspace-build\.json/);
});

test('selected-source verification ignores candidate output but rejects a new source bin', () => {
  const root = fixture();
  const generation = mkdtempSync(join(tmpdir(), 'verifier-census-generation-'));
  roots.push(generation);
  mkdirSync(join(generation, 'tree'));
  const closure = captureClosure(root);
  assert.equal(closure.complete, true, closure.reason);
  write(generation, '.verifier-closure.json', JSON.stringify(closure));
  ignoredCandidate(root);

  assert.doesNotThrow(() => verifyClosure(generation, root));
  generatedPackage(root, 'packages/new-cli');
  assert.throws(() => verifyClosure(generation, root), /workspace-requirements-mismatch/);
});
