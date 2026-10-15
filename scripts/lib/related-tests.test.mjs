import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildIndex, edgeCacheKey, selectRelatedTests } from "./related-tests.mjs";

test("runtime-loaded shell scripts select their dependent tests", () => {
  const rootDir = path.resolve("/fixture");
  const testFile = path.join(
    rootDir,
    "apps/operator/scripts/__tests__/kopia-healthcheck-source-age.test.ts",
  );
  const unrelatedTest = path.join(rootDir, "apps/operator/scripts/__tests__/other.test.ts");
  const healthcheckScript = path.join(
    rootDir,
    "apps/operator/scripts/systemd/kopia-healthcheck.sh",
  );
  const cacheBootstrap = path.join(
    rootDir,
    "apps/operator/scripts/systemd/kopia-cache-bootstrap.sh",
  );
  const files = new Map([
    [
      testFile,
      [
        "import { resolve } from 'node:path';",
        "import { readFileSync } from 'node:fs';",
        "const SOURCE_SCRIPT = resolve(__dirname, '../systemd/kopia-healthcheck.sh');",
        "const CACHE_BOOTSTRAP = resolve(__dirname, '../systemd/kopia-cache-bootstrap.sh');",
        "readFileSync(SOURCE_SCRIPT, 'utf8');",
        "readFileSync(CACHE_BOOTSTRAP, 'utf8');",
      ].join("\n"),
    ],
    [unrelatedTest, "import test from 'node:test'; test('unrelated', () => {});"],
    [healthcheckScript, "#!/usr/bin/env bash\nprintf 'healthcheck'\n"],
    [cacheBootstrap, "#!/usr/bin/env bash\nprintf 'cache bootstrap'\n"],
  ]);
  const fs = {
    list: () => [testFile, unrelatedTest],
    read: (file) => files.get(path.resolve(file)) ?? null,
    exists: (file) => files.has(path.resolve(file)),
  };

  const index = buildIndex({ rootDir, fs });

  assert.deepEqual(index.unresolved, new Set());
  assert.ok(index.deps.get(testFile)?.has(healthcheckScript));
  assert.ok(index.deps.get(testFile)?.has(cacheBootstrap));

  for (const changedPath of [healthcheckScript, cacheBootstrap]) {
    const result = selectRelatedTests({
      rootDir,
      changedPaths: [changedPath],
      fs,
      index,
      threshold: 0.95,
    });

    assert.equal(result.mode, "related");
    assert.deepEqual(result.selected, [testFile]);
  }
});

test("an edge cache reuses parses by (path, content key), re-parses a changed blob, never caches an unreadable file", () => {
  const rootDir = path.resolve("/fixture-edge-cache");
  const a = path.join(rootDir, "a.ts");
  const b = path.join(rootDir, "b.ts");
  const t = path.join(rootDir, "a.test.ts");
  const ghost = path.join(rootDir, "ghost.ts");
  const files = new Map([
    [a, "import { b } from './b';\nexport const a = b;\n"],
    [b, "export const b = 1;\n"],
    [t, "import { a } from './a';\n"],
  ]);
  const keys = new Map([[a, "sha-a1"], [b, "sha-b1"], [t, "sha-t1"], [ghost, "sha-ghost"]]);
  const reads = [];
  const fs = {
    list: () => [a, b, t, ghost],
    read: (file) => {
      reads.push(file);
      return files.get(file) ?? null;
    },
    exists: (file) => files.has(file),
    key: (file) => keys.get(file) ?? null,
  };
  const cache = new Map();

  const cold = buildIndex({ rootDir, fs, edgeCache: cache });
  assert.deepEqual(reads, [a, b, t, ghost]);
  assert.deepEqual([...cache.keys()].sort(), [edgeCacheKey(a, "sha-a1"), edgeCacheKey(b, "sha-b1"), edgeCacheKey(t, "sha-t1")].sort());
  assert.deepEqual(cold.unresolved, new Set([ghost]));

  // Unchanged content is not read again (only the unreadable file is retried), and the graph
  // equals an uncached build.
  reads.length = 0;
  const warm = buildIndex({ rootDir, fs, edgeCache: cache });
  assert.deepEqual(reads, [ghost]);
  assert.deepEqual(warm.deps, buildIndex({ rootDir, fs: { ...fs, key: undefined } }).deps);
  assert.deepEqual(warm.unresolved, cold.unresolved);

  // A changed blob at the same path is re-read and its new import counts.
  files.set(b, "import { a } from './a';\nexport const b = 2;\n");
  keys.set(b, "sha-b2");
  reads.length = 0;
  const changed = buildIndex({ rootDir, fs, edgeCache: cache });
  assert.deepEqual(reads, [b, ghost]);
  assert.ok(changed.deps.get(b)?.has(a));
  assert.ok(!warm.deps.get(b)?.has(a));
});
