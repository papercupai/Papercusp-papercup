import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  cacheVerifyArgs,
  installLockWaitReporter,
  lockfileDepFlagOnlyChanges,
  main,
  publishDependencyGeneration,
  readLockfileText,
  restoreScopedFlagOnlyLockfileRewrite,
  workspaceSelectorsForNpmArgs,
  npmChildEnv,
  normalizeNpmArgs,
  parseCliArgs,
  readChildRssBytes,
  repoLockName,
  RESOLUTION_STALE_ATTEMPTS_DEFAULT,
  resolutionStaleAttempts,
  runCommandUnderInstallMutex,
  runNpmWithHeartbeat,
  USAGE,
  verifyDepsExtracted,
  withPackageCacheReadLease,
  verificationScopeForNpmArgs,
  verifyNpmCache,
  verifyNpmCacheExclusive,
  withWriterAttribution,
  writerAttributionRecord,
  writerAttributionSnapshot,
} from "./npm-install-safe.mjs";
import {
  PACKAGE_CACHE_MUTEX_NAME,
  resolveFsMutexTimeoutMs,
  withFsMutex,
  withFsMutexRead,
} from "./lib/fs-mutex.mjs";
import { TEST_FILE_EXIT_NOT_MEASURED } from "./lib/test-file-exit-codes.mjs";

// npm run exports its own prefix and can carry user config. These fixtures
// model local installs in a disposable repo; each case sets its routing options.
const NPM_FIXTURE_CONFIG_RESET = Object.fromEntries(
  ["prefix", "save", "package_lock", "package_lock_only", "global"].flatMap(name => [
    ["npm_config_" + name, undefined],
    ["NPM_CONFIG_" + name.toUpperCase(), undefined],
  ]),
);

function createManifestResolutionFixture({
  staleDuringResolve = false,
  expectFallback = false,
  publisherStatus,
  flagOnlyDuringResolve = false,
} = {}) {
  const tempRoot = mkdtempSync(join(tmpdir(), "npm-install-safe-resolution-"));
  const repoRoot = join(tempRoot, "repo");
  const workspaceRoot = join(repoRoot, "packages", "operator-core");
  const binDir = join(tempRoot, "bin");
  const lockDir = join(tempRoot, "mutex");
  const tracePath = join(tempRoot, "npm-phases.txt");
  const fakeNpm = join(binDir, "npm");
  const cli = fileURLToPath(new URL("./npm-install-safe.mjs", import.meta.url));
  const fsMutexUrl = pathToFileURL(
    fileURLToPath(new URL("./lib/fs-mutex.mjs", import.meta.url)),
  ).href;

  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  if (publisherStatus !== undefined) {
    const fakeBash = join(binDir, 'bash');
    writeFileSync(fakeBash, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'fs.appendFileSync(process.env.NPM_INSTALL_SAFE_TEST_TRACE, "publish\\n");',
      `process.exit(${publisherStatus});`,
    ].join('\n') + '\n');
    chmodSync(fakeBash, 0o755);
  }
  const localPackageRoot = join(tempRoot, "fixture-pkg");
  mkdirSync(localPackageRoot, { recursive: true });
  writeFileSync(
    join(localPackageRoot, "package.json"),
    JSON.stringify({ name: "fixture-pkg", version: "1.2.3" }, null, 2) + "\n",
  );
  writeFileSync(
    join(repoRoot, "package.json"),
    JSON.stringify(
      {
        name: "fixture",
        version: "1.0.0",
        private: true,
        workspaces: ["packages/*"],
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(repoRoot, "package-lock.json"),
    JSON.stringify(
      {
        name: "fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "fixture",
            version: "1.0.0",
            workspaces: ["packages/*"],
          },
          "packages/operator-core": {
            name: "@fixture/operator-core",
            version: "1.0.0",
            ...(flagOnlyDuringResolve ? { dependencies: { "fixture-pkg": "1.2.3" } } : {}),
          },
          ...(flagOnlyDuringResolve ? {
            "node_modules/fixture-pkg": {
              version: "1.2.3",
              resolved: "https://registry.npmjs.org/fixture-pkg/-/fixture-pkg-1.2.3.tgz",
              integrity: "sha512-fixture",
              devOptional: true,
            },
          } : {}),
        },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        name: "@fixture/operator-core",
        version: "1.0.0",
        ...(flagOnlyDuringResolve ? { dependencies: { "fixture-pkg": "1.2.3" } } : {}),
      },
      null,
      2,
    ) + "\n",
  );

  const npmShim = [
    "#!/usr/bin/env node",
    "const fs = require(\"node:fs\");",
    "const path = require(\"node:path\");",
    "(async () => {",
    "  const { withFsMutex } = await import(__FS_MUTEX_URL__);",
    "  const args = process.argv.slice(2);",
    "  const phase = args[0] === \"cache\" ? \"cache-verify\" : (args.includes(\"--package-lock-only=true\") ? \"resolve\" : (args.includes(\"--legacy-peer-deps\") ? \"repair\" : \"reify\"));",
    "  const repoRoot = process.env.NPM_INSTALL_SAFE_TEST_ROOT;",
    "  const lockName = process.env.NPM_INSTALL_SAFE_TEST_LOCK_NAME;",
    "  const record = (value) => fs.appendFileSync(process.env.NPM_INSTALL_SAFE_TEST_TRACE, value + \"\\n\");",
    "  if (phase === \"cache-verify\") { record(phase); return; }",
    "  let writerAcquired = false;",
    "  try {",
    "    await withFsMutex(lockName, async () => { writerAcquired = true; }, { timeoutMs: phase === \"resolve\" ? 2000 : 250, retryMs: 10 });",
    "  } catch (error) {",
    "    if (!String(error?.message || error).startsWith(\"Timed out after \")) throw error;",
    "  }",
    "  const foreignWorkspace = process.env.NPM_INSTALL_SAFE_TEST_FOREIGN_WORKSPACE;",
    "  if (foreignWorkspace && phase === \"resolve\" && !fs.existsSync(path.join(process.cwd(), foreignWorkspace, \"package.json\"))) throw new Error(\"npm workspace omitted from resolver scratch tree\");",
    "  const archive = process.env.NPM_INSTALL_SAFE_TEST_ARCHIVE;",
    "  if (archive && phase === \"resolve\" && fs.readFileSync(path.join(process.cwd(), archive), \"utf8\") !== \"packed fixture\") throw new Error(\"local archive omitted or changed in resolver snapshot\");",
    "  if (process.env.NPM_INSTALL_SAFE_TEST_FOREIGN_FALLBACK === \"1\") {",
    "    if (phase === \"resolve\" || writerAcquired || process.cwd() !== repoRoot) throw new Error(\"unsupported foreign workspace must use the original tree under its writer\");",
    "    record(\"fallback\");",
    "    return;",
    "  }",
    "  if (process.env.NPM_INSTALL_SAFE_TEST_EXPECT_FALLBACK === \"1\") {",
    "    if (phase === \"resolve\") throw new Error(\"local package target was incorrectly resolved from scratch\");",
    "    if (phase !== \"reify\" || writerAcquired) throw new Error(\"fallback install did not hold the repo writer\");",
    "    const packageSpec = args.find((arg) => arg.includes(\"@file:\"));",
    "    const packagePath = packageSpec?.slice(packageSpec.indexOf(\"@file:\") + \"@file:\".length);",
    "    if (process.cwd() !== repoRoot || !packagePath || !fs.existsSync(path.join(path.resolve(process.cwd(), packagePath), \"package.json\"))) throw new Error(\"fallback lost the original repo-relative package target\");",
    "    record(\"fallback\");",
    "    return;",
    "  }",
    "  if (phase === \"resolve\") {",
    "    if (!writerAcquired) throw new Error(\"resolve ran while the repo mutex blocked a writer\");",
    "    const scratchManifest = path.join(process.cwd(), \"packages\", \"operator-core\", \"package.json\");",
    "    const manifest = JSON.parse(fs.readFileSync(scratchManifest, \"utf8\"));",
    "    manifest.dependencies = { ...(manifest.dependencies || {}), \"fixture-pkg\": \"1.2.3\" };",
    "    fs.writeFileSync(scratchManifest, JSON.stringify(manifest, null, 2) + \"\\n\");",
    "    const lockfilePath = path.join(process.cwd(), \"package-lock.json\");",
    "    const lockfile = JSON.parse(fs.readFileSync(lockfilePath, \"utf8\"));",
    "    lockfile.packages[\"packages/operator-core\"].dependencies = { \"fixture-pkg\": \"1.2.3\" };",
    "    lockfile.packages[\"node_modules/fixture-pkg\"] = { version: \"1.2.3\", resolved: \"https://registry.npmjs.org/fixture-pkg/-/fixture-pkg-1.2.3.tgz\", integrity: \"sha512-fixture\", ...(process.env.NPM_INSTALL_SAFE_TEST_FLAG_ONLY === \"1\" ? { dev: true } : {}) };",
    "    fs.writeFileSync(lockfilePath, JSON.stringify(lockfile, null, 2) + \"\\n\");",
    "    if (process.env.NPM_INSTALL_SAFE_TEST_STALE) {",
    "      const livePath = path.join(repoRoot, \"packages\", \"operator-core\", \"package.json\");",
    "      const liveManifest = JSON.parse(fs.readFileSync(livePath, \"utf8\"));",
    "      liveManifest.externalFixtureChange = process.env.NPM_INSTALL_SAFE_TEST_STALE === \"always\" ? (Number(liveManifest.externalFixtureChange) || 0) + 1 : true;",
    "      fs.writeFileSync(livePath, JSON.stringify(liveManifest, null, 2) + \"\\n\");",
    "    }",
    "    record(phase);",
    "    const resolveGate = process.env.NPM_INSTALL_SAFE_TEST_RESOLVE_GATE;",
    "    if (resolveGate) while (!fs.existsSync(resolveGate)) await new Promise(resolve => setTimeout(resolve, 5));",
    "    return;",
    "  }",
    "  if (writerAcquired) throw new Error(phase + \" ran without the repo writer\");",
    "  const liveManifestPath = path.join(repoRoot, \"packages\", \"operator-core\", \"package.json\");",
    "  const liveManifest = JSON.parse(fs.readFileSync(liveManifestPath, \"utf8\"));",
    "  if (liveManifest.dependencies?.[\"fixture-pkg\"] !== \"1.2.3\") throw new Error(\"resolved manifest was not applied before reify\");",
    "  const liveLockfile = JSON.parse(fs.readFileSync(path.join(repoRoot, \"package-lock.json\"), \"utf8\"));",
    "  if (!liveLockfile.packages?.[\"node_modules/fixture-pkg\"]) throw new Error(\"resolved lockfile was not applied before reify\");",
    "  if (phase === \"repair\") {",
    "    fs.mkdirSync(path.join(repoRoot, \"node_modules\", \"fixture-pkg\"), { recursive: true });",
    "    fs.writeFileSync(path.join(repoRoot, \"node_modules\", \"fixture-pkg\", \"package.json\"), JSON.stringify({ name: \"fixture-pkg\", version: \"1.2.3\" }));",
    "  }",
    "  record(phase);",
    "})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });",
  ].join("\n").replace("__FS_MUTEX_URL__", JSON.stringify(fsMutexUrl)) + "\n";
  writeFileSync(fakeNpm, npmShim);
  chmodSync(fakeNpm, 0o755);

  return {
    tempRoot,
    repoRoot,
    tracePath,
    cli,
    args: [
      "--repo-root",
      repoRoot,
      "install",
      "fixture-pkg@1.2.3",
      "-w",
      "@fixture/operator-core",
    ],
    env: {
      ...process.env,
      ...NPM_FIXTURE_CONFIG_RESET,
      PATH: binDir + delimiter + (process.env.PATH ?? ""),
      PAPERCUSP_FS_MUTEX_LOCK_DIR: lockDir,
      PAPERCUSP_FS_MUTEX_TIMEOUT_MS: "10000",
      PAPERCUSP_SKIP_DEP_GENERATION: publisherStatus === undefined ? "1" : "0",
      NPM_INSTALL_SAFE_TEST_ROOT: repoRoot,
      NPM_INSTALL_SAFE_TEST_TRACE: tracePath,
      NPM_INSTALL_SAFE_TEST_LOCK_NAME: repoLockName(repoRoot),
      ...(flagOnlyDuringResolve ? { NPM_INSTALL_SAFE_TEST_FLAG_ONLY: "1" } : {}),
      ...(expectFallback
        ? {
            NPM_INSTALL_SAFE_TEST_EXPECT_FALLBACK: "1",
            PAPERCUSP_SKIP_DEP_VERIFY: "1",
          }
        : {}),
      ...(staleDuringResolve
        ? { NPM_INSTALL_SAFE_TEST_STALE: staleDuringResolve === "always" ? "always" : "1" }
        : {}),
    },
  };
}

test("manifest resolution fixtures ignore inherited npm routing config", {
  skip: process.platform === "win32",
}, () => {
  const restoreEnv = setEnv({
    npm_config_prefix: "/inherited-prefix",
    NPM_CONFIG_SAVE: "false",
    npm_config_package_lock: "false",
    NPM_CONFIG_PACKAGE_LOCK_ONLY: "true",
    npm_config_global: "true",
  });
  const fixture = createManifestResolutionFixture();
  try {
    const result = spawnSync(process.execPath, [fixture.cli, ...fixture.args], {
      encoding: "utf8", timeout: 15_000, env: fixture.env,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(readFileSync(fixture.tracePath, "utf8").trim().split("\n"),
      ["cache-verify", "resolve", "reify", "repair"]);
    assert.equal(process.env.npm_config_prefix, "/inherited-prefix");
  } finally {
    restoreEnv();
    rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

function addForeignWorkspace(fixture, dependencies = {}) {
  // A verification exclusion must not remove an npm workspace from resolution.
  const dir = "apps/slack-asana-bug-drill";
  const rootManifestPath = join(fixture.repoRoot, "package.json");
  const rootManifest = JSON.parse(readFileSync(rootManifestPath, "utf8"));
  rootManifest.workspaces.push("apps/*");
  writeFileSync(rootManifestPath, JSON.stringify(rootManifest));
  mkdirSync(join(fixture.repoRoot, dir), { recursive: true });
  const manifest = { name: "@foreign/fixture", version: "1.0.0", dependencies };
  writeFileSync(join(fixture.repoRoot, dir, "package.json"), JSON.stringify(manifest));
  const lockPath = join(fixture.repoRoot, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.packages[""].workspaces = rootManifest.workspaces;
  lock.packages[dir] = manifest;
  lock.packages["node_modules/@foreign/fixture"] = { resolved: dir, link: true };
  writeFileSync(lockPath, JSON.stringify(lock));
  fixture.env.NPM_INSTALL_SAFE_TEST_FOREIGN_WORKSPACE = dir;
  return dir;
}

test("manifest-only resolution includes foreign npm workspaces in its snapshot", {
  skip: process.platform === "win32",
}, () => {
  const fixture = createManifestResolutionFixture();
  try {
    const dir = addForeignWorkspace(fixture);
    fixture.args.push("--package-lock-only");
    const result = spawnSync(process.execPath, [fixture.cli, ...fixture.args], {
      encoding: "utf8", timeout: 15_000, env: fixture.env,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(readFileSync(fixture.tracePath, "utf8").trim().split("\n"),
      ["cache-verify", "resolve"]);
    const lock = JSON.parse(readFileSync(join(fixture.repoRoot, "package-lock.json"), "utf8"));
    assert.equal(lock.packages[dir].name, "@foreign/fixture");
    assert.deepEqual(lock.packages["node_modules/@foreign/fixture"], { resolved: dir, link: true });
  } finally { rmSync(fixture.tempRoot, { recursive: true, force: true }); }
});

test("unsupported foreign workspace dependencies fall back before incomplete resolution", {
  skip: process.platform === "win32",
}, () => {
  const fixture = createManifestResolutionFixture();
  try {
    addForeignWorkspace(fixture, { "vendored-pkg": "file:vendor/package.tgz" });
    fixture.env.NPM_INSTALL_SAFE_TEST_FOREIGN_FALLBACK = "1";
    fixture.env.PAPERCUSP_SKIP_DEP_VERIFY = "1";
    const result = spawnSync(process.execPath, [fixture.cli, ...fixture.args], {
      encoding: "utf8", timeout: 15_000, env: fixture.env,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stderr, /file dependency has no package manifest/);
    assert.deepEqual(readFileSync(fixture.tracePath, "utf8").trim().split("\n"),
      ["cache-verify", "fallback"]);
  } finally { rmSync(fixture.tempRoot, { recursive: true, force: true }); }
});

for (const lockOnly of [false, true]) {
  test(`workspace-scoped resolver preserves original flag-only lock bytes (${lockOnly ? "lock-only" : "reify"})`, {
    skip: process.platform === "win32",
  }, () => {
    const fixture = createManifestResolutionFixture({ flagOnlyDuringResolve: true });
    try {
      const lockPath = join(fixture.repoRoot, "package-lock.json");
      const original = readFileSync(lockPath, "utf8");
      if (lockOnly) fixture.args.push("--package-lock-only");
      const result = spawnSync(process.execPath, [fixture.cli, ...fixture.args], {
        encoding: "utf8", timeout: 15_000, env: fixture.env,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.deepEqual(readFileSync(fixture.tracePath, "utf8").trim().split("\n"),
        lockOnly ? ["cache-verify", "resolve"] : ["cache-verify", "resolve", "reify", "repair"]);
      assert.equal(readFileSync(lockPath, "utf8"), original,
        "the resolver must preserve the pre-resolution lock before reify takes its snapshot");
    } finally {
      rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });
}

test("lock-only resolution does not publish unchanged installed dependencies", {
  skip: process.platform === "win32",
}, () => {
  for (const viaConfig of [false, true]) {
    const fixture = createManifestResolutionFixture({ publisherStatus: 77 });
    try {
      if (viaConfig) fixture.env.npm_config_package_lock_only = 'true';
      else fixture.args.push('--package-lock-only');
      const result = spawnSync(process.execPath, [fixture.cli, ...fixture.args], {
        encoding: "utf8", timeout: 15_000, env: fixture.env,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.deepEqual(readFileSync(fixture.tracePath, 'utf8').trim().split('\n'), ['cache-verify', 'resolve']);
      assert.equal(existsSync(join(fixture.repoRoot, 'node_modules')), false);
      const lock = JSON.parse(readFileSync(join(fixture.repoRoot, 'package-lock.json'), 'utf8'));
      assert.equal(lock.packages['node_modules/fixture-pkg'].version, '1.2.3');
    } finally { rmSync(fixture.tempRoot, { recursive: true, force: true }); }
  }
});

test("reify and repair still publish and propagate generation failure", {
  skip: process.platform === "win32",
}, () => {
  const fixture = createManifestResolutionFixture({ publisherStatus: 77 });
  try {
    const result = spawnSync(process.execPath, [fixture.cli, ...fixture.args], {
      encoding: "utf8", timeout: 15_000, env: fixture.env,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 77, result.stderr + result.stdout);
    assert.deepEqual(readFileSync(fixture.tracePath, 'utf8').trim().split('\n'), ['cache-verify', 'resolve', 'reify', 'repair', 'publish']);
    assert.match(result.stderr, /immutable dependency generation publish exited 77/);
    const attribution = result.stderr.split('\n')
      .filter((line) => line.startsWith('NPM_INSTALL_SAFE attribution='))
      .map((line) => JSON.parse(line.slice('NPM_INSTALL_SAFE attribution='.length)));
    const reify = attribution.find((record) => record.phase === 'reify');
    const publish = attribution.find((record) => record.phase === 'generation-publish');
    assert.ok(reify && publish, result.stderr);
    assert.equal(publish.invocationId, reify.invocationId);
    assert.equal(publish.lockMode, 'reader');
    assert.equal(publish.exitCode, 77);
  } finally { rmSync(fixture.tempRoot, { recursive: true, force: true }); }
});

test("lock-only fallback does not verify or publish the unchanged installed tree", {
  skip: process.platform === "win32",
}, () => {
  for (const viaConfig of [false, true]) {
    const fixture = createManifestResolutionFixture({ expectFallback: true, publisherStatus: 77 });
    fixture.args[3] = "fixture-pkg@file:../fixture-pkg";
    delete fixture.env.PAPERCUSP_SKIP_DEP_VERIFY;
    const manifestPath = join(fixture.repoRoot, 'packages', 'operator-core', 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.dependencies = { 'fixture-pkg': '1.2.3' };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const lockPath = join(fixture.repoRoot, 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.packages['packages/operator-core'].dependencies = manifest.dependencies;
    lock.packages['node_modules/fixture-pkg'] = { version: '1.2.3', resolved: 'https://registry.npmjs.org/fixture-pkg/-/fixture-pkg-1.2.3.tgz' };
    writeFileSync(lockPath, JSON.stringify(lock));
    if (viaConfig) fixture.env.npm_config_package_lock_only = 'true';
    else fixture.args.push('--package-lock-only');
    try {
      const result = spawnSync(process.execPath, [fixture.cli, ...fixture.args], {
        encoding: 'utf8', timeout: 15_000, env: fixture.env,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.deepEqual(readFileSync(fixture.tracePath, 'utf8').trim().split('\n'), ['cache-verify', 'fallback']);
      assert.equal(existsSync(join(fixture.repoRoot, 'node_modules')), false);
    } finally { rmSync(fixture.tempRoot, { recursive: true, force: true }); }
  }
});

test("manifest resolution includes local archives from other workspaces without a writer fallback", {
  skip: process.platform === "win32",
}, () => {
  const fixture = createManifestResolutionFixture();
  const consumer = "packages/archive-consumer";
  const archive = "vendor/local.tgz";
  mkdirSync(join(fixture.repoRoot, consumer), { recursive: true });
  mkdirSync(join(fixture.repoRoot, "vendor"), { recursive: true });
  writeFileSync(join(fixture.repoRoot, archive), "packed fixture");
  const manifest = { name: "@fixture/archive-consumer", version: "1.0.0", dependencies: { "local-archive": "file:../../vendor/local.tgz" } };
  writeFileSync(join(fixture.repoRoot, consumer, "package.json"), JSON.stringify(manifest));
  const lockPath = join(fixture.repoRoot, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.packages[consumer] = manifest;
  writeFileSync(lockPath, JSON.stringify(lock));
  try {
    const result = spawnSync(process.execPath, [fixture.cli, ...fixture.args], {
      encoding: "utf8", timeout: 15_000,
      env: { ...fixture.env, NPM_INSTALL_SAFE_TEST_FOREIGN_WORKSPACE: consumer, NPM_INSTALL_SAFE_TEST_ARCHIVE: archive },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const phases = readFileSync(fixture.tracePath, "utf8").trim().split("\n");
    assert.equal(phases.includes("resolve"), true, phases.join(", "));
    assert.equal(phases.includes("fallback"), false);
    assert.equal(readFileSync(join(fixture.repoRoot, archive), "utf8"), "packed fixture");
  } finally { rmSync(fixture.tempRoot, { recursive: true, force: true }); }
});

test("incompatible installed dependencies reserve the writer while existing readers finish", { timeout: 25_000 }, async () => {
  const fixture = createManifestResolutionFixture({ flagOnlyDuringResolve: true });
  const packageDir = join(fixture.repoRoot, "node_modules", "fixture-pkg");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "fixture-pkg", version: "0.1.0" }));
  const gate = join(fixture.tempRoot, "resolve-ready");
  const lockRootDir = fixture.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  const name = repoLockName(fixture.repoRoot);
  const child = spawn(process.execPath, [fixture.cli, ...fixture.args], {
    env: { ...fixture.env, NPM_INSTALL_SAFE_TEST_RESOLVE_GATE: gate },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const ended = new Promise(resolve => child.once("close", resolve));
  const waitFor = async predicate => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, output);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  let releaseReader = () => {};
  let reader;
  try {
    await waitFor(() => existsSync(fixture.tracePath) && readFileSync(fixture.tracePath, "utf8").split("\n").includes("resolve"));
    let markReady;
    const ready = new Promise(resolve => { markReady = resolve; });
    const held = new Promise(resolve => { releaseReader = resolve; });
    reader = withFsMutexRead(name, async () => { markReady(); await held; }, { lockRootDir });
    await ready;
    writeFileSync(gate, "go");
    await waitFor(() => existsSync(join(lockRootDir, name + ".lock")));
    await assert.rejects(
      withFsMutexRead(name, async () => { throw new Error("new reader entered ahead of repair"); }, { lockRootDir, timeoutMs: 50, retryMs: 5 }),
      /Timed out/,
    );
    releaseReader();
    await reader;
    assert.equal(await ended, 0, output);
  } finally {
    releaseReader();
    await reader;
    if (child.exitCode === null) child.kill("SIGTERM");
    await ended;
    rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("test:affected preflight refuses stale workspace lock metadata before launching tests", async () => {
  const fixture = createManifestResolutionFixture();
  const manifestPath = join(fixture.repoRoot, "packages", "operator-core", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies = { "fixture-pkg": "1.2.3" };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const events = [];
  let childRuns = 0;
  const run = () => runCommandUnderInstallMutex({
    repoRoot: fixture.repoRoot,
    commandArgs: ["node", "scripts/affected-tests.mjs"],
    acquireReadMutex: async (_name, fn) => fn(),
    runCommand: () => { childRuns += 1; return { status: 0 }; },
    env: {},
    log: (line) => events.push(line),
  });

  try {
    assert.equal(await run(), TEST_FILE_EXIT_NOT_MEASURED);
    assert.equal(childRuns, 0);
    assert.match(events.join("\n"), /NPM_INSTALL_SAFE_WORKSPACE_LOCK_DRIFT/);
    assert.match(events.join("\n"), /packages\/operator-core dependencies/);
    assert.match(events.join("\n"), /TEST_RUN_NOT_MEASURED reason=workspace-lock-manifest-drift/);

    delete manifest.dependencies;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    assert.equal(await run(), 0, events.join("\n"));
    assert.equal(childRuns, 1);
  } finally {
    rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("fallback install refuses stale workspace lock metadata before npm runs", {
  skip: process.platform === "win32",
}, () => {
  const fixture = createManifestResolutionFixture();
  const manifestPath = join(fixture.repoRoot, "packages", "operator-core", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies = { "fixture-pkg": "1.2.3" };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  try {
    const result = spawnSync(
      process.execPath,
      [fixture.cli, "--repo-root", fixture.repoRoot, "install", "--dry-run"],
      { cwd: fixture.repoRoot, encoding: "utf8", timeout: 15_000, env: fixture.env },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stderr, /NPM_INSTALL_SAFE_WORKSPACE_LOCK_DRIFT/);
    assert.match(result.stderr, /packages\/operator-core dependencies/);
    assert.equal(existsSync(fixture.tracePath), false, "npm cache verify and Arborist must not start");
  } finally {
    rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("manifest-only installs refuse stale workspace metadata before resolution", {
  skip: process.platform === "win32",
}, () => {
  const fixture = createManifestResolutionFixture();
  const manifestPath = join(fixture.repoRoot, "packages", "operator-core", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies = { "stale-fixture": "1.0.0" };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  try {
    const blocked = spawnSync(process.execPath, [fixture.cli, ...fixture.args], {
      cwd: fixture.repoRoot,
      encoding: "utf8",
      timeout: 15_000,
      env: fixture.env,
    });
    assert.ifError(blocked.error);
    assert.equal(blocked.status, 1, blocked.stderr + blocked.stdout);
    assert.match(blocked.stderr, /NPM_INSTALL_SAFE_WORKSPACE_LOCK_DRIFT/);
    assert.match(blocked.stderr, /packages\/operator-core dependencies/);
    assert.equal(existsSync(fixture.tracePath), false, "the cache verifier and Arborist must not start");

    // Even package-lock-only invokes Arborist's graph resolver. Refuse it too while
    // the recorded graph disagrees with the manifests, then prove it proceeds once
    // the workspace lock mirror is reconciled.
    fixture.args.push("--package-lock-only");
    const driftedLockOnly = spawnSync(process.execPath, [fixture.cli, ...fixture.args], {
      cwd: fixture.repoRoot,
      encoding: "utf8",
      timeout: 15_000,
      env: fixture.env,
    });
    assert.ifError(driftedLockOnly.error);
    assert.equal(driftedLockOnly.status, 1, driftedLockOnly.stderr + driftedLockOnly.stdout);
    assert.match(driftedLockOnly.stderr, /NPM_INSTALL_SAFE_WORKSPACE_LOCK_DRIFT/);
    assert.equal(existsSync(fixture.tracePath), false);

    const lockPath = join(fixture.repoRoot, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.packages["packages/operator-core"].dependencies = manifest.dependencies;
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
    const reconciled = spawnSync(process.execPath, [fixture.cli, ...fixture.args], {
      cwd: fixture.repoRoot,
      encoding: "utf8",
      timeout: 15_000,
      env: fixture.env,
    });
    assert.ifError(reconciled.error);
    assert.equal(reconciled.status, 0, reconciled.stderr + reconciled.stdout);
    assert.deepEqual(readFileSync(fixture.tracePath, "utf8").trim().split("\n"), ["cache-verify", "resolve"]);
  } finally {
    rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("repo writers can proceed during resolution but stay blocked during reify and repair", {
  skip: process.platform === "win32",
}, () => {
  const fixture = createManifestResolutionFixture();
  try {
    const result = spawnSync(process.execPath, [fixture.cli, ...fixture.args], {
      encoding: "utf8",
      timeout: 15_000,
      env: fixture.env,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(
      readFileSync(fixture.tracePath, "utf8").trim().split("\n"),
      ["cache-verify", "resolve", "reify", "repair"],
    );
    assert.match(result.stderr, /NPM_INSTALL_SAFE phase=resolve started/);
    assert.match(result.stderr, /NPM_INSTALL_SAFE phase=reify started/);
    assert.match(result.stderr, /NPM_INSTALL_SAFE phase=repair started/);
    assert.ok(
      existsSync(
        join(fixture.repoRoot, "node_modules", "fixture-pkg", "package.json"),
      ),
    );
  } finally {
    rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("manifest-only install re-resolves against the current manifests when they changed after the snapshot", {
  skip: process.platform === "win32",
}, () => {
  // The fake resolve edits the live operator-core manifest; on attempt 2 it rewrites the same
  // bytes, so this models one peer edit landing mid-resolve (WI-10006714).
  const fixture = createManifestResolutionFixture({ staleDuringResolve: "once" });
  try {
    const result = spawnSync(process.execPath, [fixture.cli, ...fixture.args], {
      encoding: "utf8",
      timeout: 15_000,
      env: fixture.env,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(
      result.stderr,
      /NPM_INSTALL_SAFE_RESOLUTION_RETRY: source-changed at \S*package\.json during attempt 1\/3/,
    );
    assert.doesNotMatch(result.stderr, /NPM_INSTALL_SAFE_RESOLUTION_STALE/);
    assert.deepEqual(
      readFileSync(fixture.tracePath, "utf8").trim().split("\n"),
      ["cache-verify", "resolve", "cache-verify", "resolve", "reify", "repair"],
    );
    const liveManifest = JSON.parse(
      readFileSync(
        join(fixture.repoRoot, "packages", "operator-core", "package.json"),
        "utf8",
      ),
    );
    // Both are present: attempt 2 resolved from the peer-edited manifest instead of
    // overwriting the peer's edit with the stale resolution.
    assert.equal(liveManifest.externalFixtureChange, true);
    assert.equal(liveManifest.dependencies?.["fixture-pkg"], "1.2.3");
    assert.ok(
      existsSync(
        join(fixture.repoRoot, "node_modules", "fixture-pkg", "package.json"),
      ),
    );
  } finally {
    rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("resolutionStaleAttempts defaults to 3 and accepts only a positive integer override", () => {
  assert.equal(RESOLUTION_STALE_ATTEMPTS_DEFAULT, 3);
  assert.equal(resolutionStaleAttempts({}), 3);
  assert.equal(resolutionStaleAttempts({ PAPERCUSP_INSTALL_SAFE_STALE_ATTEMPTS: "" }), 3);
  assert.equal(resolutionStaleAttempts({ PAPERCUSP_INSTALL_SAFE_STALE_ATTEMPTS: "1" }), 1);
  assert.equal(resolutionStaleAttempts({ PAPERCUSP_INSTALL_SAFE_STALE_ATTEMPTS: "5" }), 5);
  for (const bad of ["0", "-2", "1.5", "abc"])
    assert.equal(
      resolutionStaleAttempts({ PAPERCUSP_INSTALL_SAFE_STALE_ATTEMPTS: bad }),
      3,
      bad,
    );
});

test("manifest-only install gives up without reifying when the manifests change on every attempt", {
  skip: process.platform === "win32",
}, () => {
  const fixture = createManifestResolutionFixture({ staleDuringResolve: "always" });
  const initialLockfile = readFileSync(
    join(fixture.repoRoot, "package-lock.json"),
    "utf8",
  );
  try {
    const result = spawnSync(process.execPath, [fixture.cli, ...fixture.args], {
      encoding: "utf8",
      timeout: 15_000,
      env: fixture.env,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(
      result.stderr,
      /NPM_INSTALL_SAFE_RESOLUTION_STALE: source-changed at \S*package\.json on all 3 attempt\(s\)/,
    );
    assert.equal(result.stderr.match(/NPM_INSTALL_SAFE_RESOLUTION_RETRY/g)?.length, 2);
    assert.deepEqual(
      readFileSync(fixture.tracePath, "utf8").trim().split("\n"),
      ["cache-verify", "resolve", "cache-verify", "resolve", "cache-verify", "resolve"],
    );
    const liveManifest = JSON.parse(
      readFileSync(
        join(fixture.repoRoot, "packages", "operator-core", "package.json"),
        "utf8",
      ),
    );
    assert.equal(liveManifest.externalFixtureChange, 3);
    assert.equal(liveManifest.dependencies, undefined);
    assert.equal(
      readFileSync(join(fixture.repoRoot, "package-lock.json"), "utf8"),
      initialLockfile,
    );
    assert.equal(existsSync(join(fixture.repoRoot, "node_modules")), false);
  } finally {
    rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("name@file package targets fall back to npm under the original repo writer", {
  skip: process.platform === "win32",
}, () => {
  const fixture = createManifestResolutionFixture({ expectFallback: true });
  fixture.args[3] = "fixture-pkg@file:../fixture-pkg";
  try {
    const result = spawnSync(process.execPath, [fixture.cli, ...fixture.args], {
      encoding: "utf8",
      timeout: 15_000,
      env: fixture.env,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(
      result.stderr,
      /NPM_INSTALL_SAFE_RESOLUTION_FALLBACK: a command-line package target is local or remote/,
    );
    assert.deepEqual(
      readFileSync(fixture.tracePath, "utf8").trim().split("\n"),
      ["cache-verify", "fallback"],
    );
  } finally {
    rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("runNpmWithHeartbeat reports asynchronous phase, child PID, RSS, and exit status", async () => {
  const child = new EventEmitter();
  child.pid = 4321;
  const lines = [];
  const status = await runNpmWithHeartbeat({
    phase: "resolve",
    args: ["install", "--package-lock-only=true"],
    spawnCommand: () => {
      setTimeout(() => child.emit("close", 0, null), 20);
      return child;
    },
    heartbeatIntervalMs: 1,
    readRssBytes: (pid) => (pid === 4321 ? 512 * 1024 * 1024 : null),
    log: (line) => lines.push(line),
  });
  assert.equal(status, 0);
  assert.match(lines[0], /phase=resolve started childPid=4321/);
  assert.ok(
    lines.some((line) =>
      /phase=resolve heartbeat .*childRssMb=512\.0/.test(line),
    ),
  );
  assert.match(lines.at(-1), /phase=resolve finished .*exitCode=0 signal=none/);
});

test("writer attribution distinguishes a phase disappearance from an initially absent path", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "install-safe-attribution-"));
  const nestedPath = "apps/slack-asana-bug-drill/node_modules/@types/node/node_modules/undici-types";
  const target = join(repoRoot, nestedPath);
  const packageLock = '{"lockfileVersion":3,"packages":{}}\n';
  const runPhase = async (removeDuringPhase) => {
    const child = new EventEmitter();
    child.pid = 4321;
    const lines = [];
    const status = await runNpmWithHeartbeat({
      phase: "reify",
      args: ["install"],
      cwd: repoRoot,
      heartbeatIntervalMs: 0,
      attribution: {
        repoRoot,
        nestedPath,
        invocationId: "fixture-invocation",
        lockName: repoLockName(repoRoot),
      },
      spawnCommand: () => {
        setImmediate(() => {
          if (removeDuringPhase) rmSync(target, { recursive: true, force: true });
          child.emit("close", 0, null);
        });
        return child;
      },
      log: (line) => lines.push(line),
    });
    assert.equal(status, 0);
    return JSON.parse(lines.find((line) => line.startsWith("NPM_INSTALL_SAFE attribution="))
      .slice("NPM_INSTALL_SAFE attribution=".length));
  };
  try {
    writeFileSync(join(repoRoot, "package-lock.json"), packageLock);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "package.json"), '{"name":"undici-types"}\n');
    const disappearance = await runPhase(true);
    assert.equal(disappearance.pathTransition, "disappeared-during-phase");
    assert.equal(disappearance.writerInference, "candidate-writer-window");
    assert.equal(disappearance.invocationId, "fixture-invocation");
    assert.equal(disappearance.lockMode, "writer");
    assert.equal(disappearance.childPid, 4321);
    assert.equal(disappearance.before.nestedPathStat.status, "observed");
    assert.equal(disappearance.after.nestedPathStat.reason, "absent");
    assert.equal(disappearance.before.rootPackageLockSha256.status, "observed");
    assert.equal(disappearance.before.rootPackageLockSha256.sha256,
      disappearance.after.rootPackageLockSha256.sha256);

    // Negative control: a later successful phase cannot be blamed for a path
    // that had already gone missing before its child was spawned.
    const initiallyAbsent = await runPhase(false);
    assert.equal(initiallyAbsent.pathTransition, "initially-absent");
    assert.equal(initiallyAbsent.writerInference, "none");
    assert.equal(initiallyAbsent.before.nestedPathStat.reason, "absent");
    assert.equal(initiallyAbsent.after.nestedPathStat.reason, "absent");
    assert.equal(writerAttributionRecord({
      before: { nestedPathStat: { status: "not-observed", reason: "probe-failed" } },
      after: { nestedPathStat: { status: "not-observed", reason: "probe-failed" } },
    }).pathTransition, "not-observed");
    assert.equal(writerAttributionRecord({
      lockMode: "none",
      before: { nestedPathStat: { status: "observed" } },
      after: { nestedPathStat: { status: "not-observed", reason: "absent" } },
    }).writerInference, "unattributed-shared-or-unlocked-window");
    assert.equal(writerAttributionSnapshot({ repoRoot, nestedPath }).nestedPathStat.reason, "absent");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("writer transaction attribution captures wrapper-side removal before any npm child", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "install-safe-writer-attribution-"));
  const nestedPath = "apps/slack-asana-bug-drill/node_modules/@types/node/node_modules/undici-types";
  const target = join(repoRoot, nestedPath);
  const lines = [];
  try {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(repoRoot, "package-lock.json"), "{}\n");
    assert.equal(await withWriterAttribution({
      repoRoot,
      nestedPath,
      invocationId: "wrapper-fixture",
      lockName: repoLockName(repoRoot),
      phase: "install-transaction",
      log: (line) => lines.push(line),
    }, async () => {
      rmSync(target, { recursive: true, force: true });
      return 0;
    }), 0);
    const record = JSON.parse(lines[0].slice("NPM_INSTALL_SAFE attribution=".length));
    assert.equal(record.invocationId, "wrapper-fixture");
    assert.equal(record.phase, "install-transaction");
    assert.equal(record.childPid, null);
    assert.equal(record.pathTransition, "disappeared-during-phase");
    assert.equal(record.writerInference, "candidate-writer-window");
    assert.equal(record.before.nestedPathStat.status, "observed");
    assert.equal(record.after.nestedPathStat.reason, "absent");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("generation publish attribution records the source transition under the reader grant", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "install-safe-generation-attribution-"));
  const nestedPath = "apps/slack-asana-bug-drill/node_modules/@types/node/node_modules/undici-types";
  const target = join(repoRoot, nestedPath);
  const lines = [];
  try {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(repoRoot, "package-lock.json"), "{}\n");
    const result = await publishDependencyGeneration({
      repoRoot,
      log: (line) => lines.push(line),
      env: {
        ...process.env,
        PAPERCUSP_INSTALL_ATTRIBUTION_ID: "generation-fixture",
        PAPERCUSP_INSTALL_ATTRIBUTION_PATH: target,
      },
      runPublisher: () => {
        rmSync(target, { recursive: true, force: true });
        return { status: 0, signal: null, pid: 7654 };
      },
    });
    assert.equal(result, 0);
    const attribution = JSON.parse(lines.find((line) =>
      line.startsWith("NPM_INSTALL_SAFE attribution="),
    ).slice("NPM_INSTALL_SAFE attribution=".length));
    assert.equal(attribution.childPid, 7654);
    assert.equal(attribution.phase, "generation-publish");
    assert.equal(attribution.invocationId, "generation-fixture");
    assert.equal(attribution.lockMode, "reader");
    assert.equal(attribution.exitCode, 0);
    assert.equal(attribution.pathTransition, "disappeared-during-phase");
    assert.equal(attribution.writerInference, "unattributed-shared-or-unlocked-window");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("readChildRssBytes refuses unsupported platforms and invalid PIDs", () => {
  assert.equal(readChildRssBytes(-1, "linux"), null);
  assert.equal(readChildRssBytes(Number.NaN, "linux"), null);
  assert.equal(readChildRssBytes(1234, "darwin"), null);
  if (process.platform === "linux") {
    const rssBytes = readChildRssBytes(process.pid);
    assert.equal(typeof rssBytes, "number");
    assert.ok(rssBytes > 0);
  }
});

// EI-24961470606265468: the P-532f capacity build died after the interactive
// 180 s fs-mutex wait behind a peer's install. The unattended lock-wait knob
// (seconds) now sets it, and the explicit ms knob still wins.
test("fs-mutex wait budget honours the unattended knob below the explicit one", () => {
  assert.equal(resolveFsMutexTimeoutMs({}), 180_000);
  assert.equal(resolveFsMutexTimeoutMs({ PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC: "3600" }), 3_600_000);
  assert.equal(
    resolveFsMutexTimeoutMs({
      PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC: "3600",
      PAPERCUSP_FS_MUTEX_TIMEOUT_MS: "25",
    }),
    25,
  );
  assert.equal(resolveFsMutexTimeoutMs({ PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC: "junk" }), 180_000);
});

test("fs-mutex reclaims a recycled reader PID but retains its matching live identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "install-safe-recycled-reader-"));
  const previousRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = root;
  try {
    let identity;
    await withFsMutex("identity-probe", async () => {
      identity = JSON.parse(readFileSync(join(root, "identity-probe.lock", "owner.json"), "utf8"));
    });
    if (!identity.startTicks) return; // Kernel identity is Linux-specific.
    const reader = join(root, "recycled-reader.readers", "fixture.lock");
    mkdirSync(reader, { recursive: true });
    writeFileSync(join(reader, "owner.json"), JSON.stringify({ ...identity,
      pid: process.pid, host: hostname(), mode: "read", startTicks: "0" }));
    let entered = false;
    await withFsMutex("recycled-reader", async () => { entered = true; }, { timeoutMs: 100, retryMs: 5 });
    assert.equal(entered, true);
    const tid = readdirSync('/proc/self/task').map(Number).find(value => value !== process.pid);
    assert.ok(tid, 'Node must expose a live nonleader thread for the legacy-reuse control');
    mkdirSync(reader, { recursive: true });
    writeFileSync(join(reader, "owner.json"), JSON.stringify({
      pid: tid, host: hostname(), startedAt: new Date().toISOString(), mode: "read",
    }));
    await withFsMutex("recycled-reader", async () => {}, { timeoutMs: 100, retryMs: 5 });
    assert.equal(existsSync(reader), false);
    mkdirSync(reader, { recursive: true });
    writeFileSync(join(reader, "owner.json"), JSON.stringify(identity));
    await assert.rejects(withFsMutex("recycled-reader", async () => {
      throw new Error("live reader must retain its lease");
    }, { timeoutMs: 40, retryMs: 5 }), /waiting for fs-mutex readers/);
  } finally {
    if (previousRoot === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

// WI-10006385: a printed wait must be closed by a line saying how long it really lasted
// and under which budget; an uncontested lock stays silent.
test("install writer drains existing readers before reserving new-reader admission", { timeout: 5_000 }, async () => {
  const lockRootDir = mkdtempSync(join(tmpdir(), "install-prereserve-drain-"));
  const name = "install";
  let releaseReader;
  let readyReader;
  const ready = new Promise(resolve => { readyReader = resolve; });
  const held = new Promise(resolve => { releaseReader = resolve; });
  const reader = withFsMutexRead(name, async () => { readyReader(); await held; }, { lockRootDir });
  let releaseWriter;
  const writerHeld = new Promise(resolve => { releaseWriter = resolve; });
  let writer;
  let newcomer;
  let writerEntered = false;
  let newcomerEntered = false;
  try {
    await ready;
    let draining;
    const waiting = new Promise(resolve => { draining = resolve; });
    let enteredWriter;
    const writerReady = new Promise(resolve => { enteredWriter = resolve; });
    writer = withFsMutex(name, async () => {
      writerEntered = true;
      enteredWriter();
      await writerHeld;
    }, { lockRootDir, waitForReadersBeforeReserve: true, timeoutMs: 2_000, retryMs: 5, onWaiting: draining });
    await waiting;
    assert.equal(writerEntered, false);
    assert.equal(existsSync(join(lockRootDir, name + ".lock")), false);
    await withFsMutexRead(name, async () => { newcomerEntered = true; }, { lockRootDir, timeoutMs: 100 });
    assert.equal(newcomerEntered, true);
    releaseReader();
    await reader;
    await writerReady;
    newcomerEntered = false;
    let blocked;
    const blockedReader = new Promise(resolve => { blocked = resolve; });
    newcomer = withFsMutexRead(name, async () => { newcomerEntered = true; }, {
      lockRootDir, timeoutMs: 2_000, retryMs: 5, onWaiting: blocked,
    });
    await blockedReader;
    assert.equal(newcomerEntered, false);
    releaseWriter();
    await writer;
    await newcomer;
    assert.equal(newcomerEntered, true);
  } finally {
    releaseReader();
    releaseWriter();
    await Promise.allSettled([reader, ...(writer ? [writer] : []), ...(newcomer ? [newcomer] : [])]);
    rmSync(lockRootDir, { recursive: true, force: true });
  }
});

test("install writer timeout before reservation leaves readers available and removes its ticket", async () => {
  const lockRootDir = mkdtempSync(join(tmpdir(), "install-prereserve-timeout-"));
  let releaseReader;
  let readyReader;
  const ready = new Promise(resolve => { readyReader = resolve; });
  const held = new Promise(resolve => { releaseReader = resolve; });
  const reader = withFsMutexRead("install", async () => { readyReader(); await held; }, { lockRootDir });
  let writerEntered = false;
  try {
    await ready;
    await assert.rejects(withFsMutex("install", async () => { writerEntered = true; }, {
      lockRootDir, waitForReadersBeforeReserve: true, timeoutMs: 30, retryMs: 5,
    }), /waiting for fs-mutex readers/);
    assert.equal(writerEntered, false);
    assert.equal(existsSync(join(lockRootDir, "install.lock")), false);
    assert.deepEqual(readdirSync(join(lockRootDir, "install.queue")), []);
    assert.equal(await withFsMutexRead("install", async () => "available", { lockRootDir, timeoutMs: 100 }), "available");
  } finally {
    releaseReader();
    await reader;
    rmSync(lockRootDir, { recursive: true, force: true });
  }
});

test("install writer rechecks readers that race the pre-reservation drain", async () => {
  const lockRootDir = mkdtempSync(join(tmpdir(), "install-prereserve-race-"));
  const readerDir = join(lockRootDir, "install.readers", "racing.lock");
  let writerEntered = false;
  let writer;
  try {
    let draining;
    const waiting = new Promise(resolve => { draining = resolve; });
    writer = withFsMutex("install", async () => { writerEntered = true; }, {
      lockRootDir, waitForReadersBeforeReserve: true, timeoutMs: 2_000, retryMs: 5,
      onWaiting: draining,
      io: {
        writeFile: async (path, ...args) => {
          if (String(path) === join(lockRootDir, "install.lock", "owner.json")) {
            mkdirSync(readerDir, { recursive: true });
            writeFileSync(join(readerDir, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), mode: "read" }));
          }
          writeFileSync(path, ...args);
        },
      },
    });
    await waiting;
    assert.equal(writerEntered, false);
    rmSync(readerDir, { recursive: true });
    await writer;
    assert.equal(writerEntered, true);
  } finally {
    rmSync(readerDir, { recursive: true, force: true });
    await Promise.allSettled(writer ? [writer] : []);
    rmSync(lockRootDir, { recursive: true, force: true });
  }
});

test("installer admission drains both protected readers before admitting a waiting new reader", { timeout: 5_000 }, async () => {
  const lockRootDir = mkdtempSync(join(tmpdir(), "install-two-reader-drain-"));
  const name = "two-generation-readers";
  const releases = [];
  const entered = [];
  const readers = Array.from({ length: 2 }, () => {
    let enteredReader;
    entered.push(new Promise(resolve => { enteredReader = resolve; }));
    const held = new Promise(resolve => { releases.push(resolve); });
    return withFsMutexRead(name, async () => {
      enteredReader();
      await held;
    }, { lockRootDir });
  });
  let releaseWriter;
  const writerHeld = new Promise(resolve => { releaseWriter = resolve; });
  let writer;
  let newcomer;
  let writerEntered = false;
  let newcomerEntered = false;
  let firstReaderReleased = false;
  try {
    await Promise.all(entered);
    let draining;
    const drainStarted = new Promise(resolve => { draining = resolve; });
    let remainingReaderObserved;
    const stillDraining = new Promise(resolve => { remainingReaderObserved = resolve; });
    let admitted;
    const writerAdmitted = new Promise(resolve => { admitted = resolve; });
    writer = withFsMutex(name, async () => {
      writerEntered = true;
      admitted();
      await writerHeld;
    }, {
      lockRootDir, timeoutMs: 2_000, retryMs: 5, waitingNoticeIntervalMs: 1,
      onWaiting: () => {
        draining();
        if (firstReaderReleased) remainingReaderObserved();
      },
    });
    await drainStarted;
    let waitingNewcomer;
    const newcomerWaiting = new Promise(resolve => { waitingNewcomer = resolve; });
    newcomer = withFsMutexRead(name, async () => { newcomerEntered = true; }, {
      lockRootDir, timeoutMs: 2_000, retryMs: 5, onWaiting: () => waitingNewcomer(),
    });
    await newcomerWaiting;
    assert.equal(writerEntered, false);
    assert.equal(newcomerEntered, false);

    // Cancelling just the publisher is insufficient: its joining reader still
    // protects the source and must finish before any installer may mutate it.
    releases[0]();
    await readers[0];
    firstReaderReleased = true;
    await stillDraining;
    assert.equal(writerEntered, false);
    assert.equal(newcomerEntered, false);

    releases[1]();
    await readers[1];
    await writerAdmitted;
    assert.equal(newcomerEntered, false);
    releaseWriter();
    await writer;
    await newcomer;
    assert.equal(newcomerEntered, true);
  } finally {
    releases.forEach(release => release());
    releaseWriter();
    await Promise.allSettled([...readers, ...(writer ? [writer] : []), ...(newcomer ? [newcomer] : [])]);
    rmSync(lockRootDir, { recursive: true, force: true });
  }
});

test("installLockWaitReporter identifies protected readers while the writer drains them", async () => {
  const lockRootDir = mkdtempSync(join(tmpdir(), "install-reader-drain-"));
  const name = "reader-drain-report";
  const lines = [];
  let releaseReader;
  let readerEntered;
  const entered = new Promise(resolve => { readerEntered = resolve; });
  const held = new Promise(resolve => { releaseReader = resolve; });
  const reader = withFsMutexRead(name, async () => {
    readerEntered();
    await held;
  }, { lockRootDir });
  let writer;
  let writerEntered = false;
  try {
    await entered;
    let noticed;
    const waiting = new Promise(resolve => { noticed = resolve; });
    const reporter = installLockWaitReporter({
      lock: "writer",
      describe: owner => `waiting on another install: ${owner}`,
      log: line => lines.push(line),
      budgetMs: 2_000,
    });
    writer = withFsMutex(name, async () => { writerEntered = true; }, {
      lockRootDir, timeoutMs: 2_000, retryMs: 5,
      ...reporter,
      onWaiting: info => { reporter.onWaiting(info); noticed(); },
    });
    await Promise.race([waiting, writer.then(() => assert.fail("writer bypassed held reader"))]);
    assert.equal(writerEntered, false);
    assert.match(lines[0], /writer waiting for dependency readers/);
    assert.doesNotMatch(lines[0], /another install/);
    assert.match(lines[0], new RegExp(`"pid": ${process.pid}`));
    releaseReader();
    await reader;
    await writer;
    assert.equal(writerEntered, true);
    assert.match(lines.at(-1), /NPM_INSTALL_SAFE_LOCK_ACQUIRED lock=writer/);
  } finally {
    releaseReader();
    await Promise.allSettled([reader, ...(writer ? [writer] : [])]);
    rmSync(lockRootDir, { recursive: true, force: true });
  }
});

test("installLockWaitReporter closes a printed wait with its real length and stays quiet uncontested", () => {
  const quiet = [];
  const uncontested = installLockWaitReporter({
    lock: "writer",
    describe: (owner, elapsedMs) => `waiting ${elapsedMs} ${owner}`,
    log: line => quiet.push(line),
    budgetMs: 3_600_000,
  });
  uncontested.onAcquired({ waitedMs: 3 });
  assert.deepEqual(quiet, []);

  const lines = [];
  const contested = installLockWaitReporter({
    lock: "writer",
    describe: (owner, elapsedMs) => `waiting ${elapsedMs} ${owner}`,
    log: line => lines.push(line),
    budgetMs: 3_600_000,
  });
  contested.onWaiting({ owner: "  {\"pid\":7}\n", elapsedMs: 0 });
  contested.onWaiting({ owner: "{\"pid\":8}", elapsedMs: 30_000 });
  contested.onWaiting({ owner: "unreadable owner", elapsedMs: 60_000 });
  contested.onAcquired({ waitedMs: 2_712_345 });
  assert.deepEqual(lines, [
    'waiting 0 {"pid":7}',
    'waiting 30000 {"pid":8}',
    'waiting 60000 unreadable owner',
    "NPM_INSTALL_SAFE_LOCK_ACQUIRED lock=writer waitedMs=2712345 budgetMs=3600000",
  ]);
});

// WI-10003114 fixture: the measured shape of the 2026-09-29 flip. An unscoped
// install wrote `devOptional`; the desktop build's scoped install wrote `dev`
// (and added a bare `optional`) back, touching no version/resolved/integrity.
function lockfileFixture({ jsdomFlags, zodFlags, undiciVersion = "7.16.0" }) {
  return {
    name: "papercusp",
    version: "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "papercusp", workspaces: ["apps/*"] },
      "node_modules/@asamuzakjp/css-color": {
        version: "5.1.11",
        ...jsdomFlags,
        license: "MIT",
      },
      "node_modules/zod": { version: "3.25.76", license: "MIT", ...zodFlags },
      "node_modules/undici": {
        version: undiciVersion,
        resolved: `https://registry.npmjs.org/undici/-/undici-${undiciVersion}.tgz`,
        integrity: `sha512-${undiciVersion}`,
      },
    },
  };
}

const unscopedLock = lockfileFixture({
  jsdomFlags: { devOptional: true },
  zodFlags: {},
});
const scopedLock = lockfileFixture({
  jsdomFlags: { dev: true },
  zodFlags: { optional: true },
});

const lockText = (lock) => `${JSON.stringify(lock, null, 2)}\n`;

test("workspaceSelectorsForNpmArgs reads every npm workspace selector form", () => {
  assert.deepEqual(
    workspaceSelectorsForNpmArgs([
      "install",
      "--workspace=@papercusp/web",
      "--workspace",
      "@papercusp/sse",
      "-w",
      "apps/operator-vite",
      "-w=@papercusp/omp",
    ]),
    ["@papercusp/web", "@papercusp/sse", "apps/operator-vite", "@papercusp/omp"],
  );
  assert.deepEqual(workspaceSelectorsForNpmArgs(["install", "--legacy-peer-deps"]), []);
});

test("lockfileDepFlagOnlyChanges names entries that differ only in dependency-type flags", () => {
  assert.deepEqual(lockfileDepFlagOnlyChanges(unscopedLock, scopedLock), [
    "node_modules/@asamuzakjp/css-color",
    "node_modules/zod",
  ]);
  assert.deepEqual(lockfileDepFlagOnlyChanges(unscopedLock, unscopedLock), []);
});

test("lockfileDepFlagOnlyChanges refuses anything that changes what gets installed", () => {
  const versionBump = lockfileFixture({
    jsdomFlags: { dev: true },
    zodFlags: { optional: true },
    undiciVersion: "7.24.0",
  });
  assert.equal(lockfileDepFlagOnlyChanges(unscopedLock, versionBump), null);

  const added = structuredClone(scopedLock);
  added.packages["node_modules/left-pad"] = { version: "1.3.0" };
  assert.equal(lockfileDepFlagOnlyChanges(unscopedLock, added), null);

  const removed = structuredClone(scopedLock);
  delete removed.packages["node_modules/zod"];
  assert.equal(lockfileDepFlagOnlyChanges(unscopedLock, removed), null);

  const newEdge = structuredClone(scopedLock);
  newEdge.packages["node_modules/zod"].dependencies = { tslib: "^2" };
  assert.equal(lockfileDepFlagOnlyChanges(unscopedLock, newEdge), null);

  const topLevel = structuredClone(scopedLock);
  topLevel.lockfileVersion = 2;
  assert.equal(lockfileDepFlagOnlyChanges(unscopedLock, topLevel), null);

  assert.equal(lockfileDepFlagOnlyChanges(unscopedLock, null), null);
});

test("restoreScopedFlagOnlyLockfileRewrite restores the pre-install bytes after a flag-only rewrite", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "npm-install-safe-flags-"));
  try {
    const committed = lockText(unscopedLock);
    writeFileSync(join(repoRoot, "package-lock.json"), lockText(scopedLock));
    const result = restoreScopedFlagOnlyLockfileRewrite({
      repoRoot,
      beforeText: committed,
    });
    assert.equal(result.restored, true);
    assert.equal(result.reason, "dep-flags-only");
    assert.equal(result.entries.length, 2);
    assert.equal(
      readFileSync(join(repoRoot, "package-lock.json"), "utf8"),
      committed,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("restoreScopedFlagOnlyLockfileRewrite keeps a substantive rewrite exactly as npm wrote it", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "npm-install-safe-flags-"));
  try {
    const rewritten = lockText(
      lockfileFixture({
        jsdomFlags: { dev: true },
        zodFlags: {},
        undiciVersion: "7.24.0",
      }),
    );
    writeFileSync(join(repoRoot, "package-lock.json"), rewritten);
    const result = restoreScopedFlagOnlyLockfileRewrite({
      repoRoot,
      beforeText: lockText(unscopedLock),
    });
    assert.deepEqual(result, {
      restored: false,
      reason: "substantive-change",
      entries: [],
    });
    assert.equal(
      readFileSync(join(repoRoot, "package-lock.json"), "utf8"),
      rewritten,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("restoreScopedFlagOnlyLockfileRewrite is a no-op without a before snapshot, an unchanged file, or a removed file", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "npm-install-safe-flags-"));
  try {
    assert.equal(readLockfileText(repoRoot), undefined);
    assert.equal(
      restoreScopedFlagOnlyLockfileRewrite({ repoRoot, beforeText: undefined })
        .reason,
      "no-lockfile-before",
    );
    assert.equal(
      restoreScopedFlagOnlyLockfileRewrite({
        repoRoot,
        beforeText: lockText(unscopedLock),
      }).reason,
      "lockfile-removed",
    );
    const committed = lockText(unscopedLock);
    writeFileSync(join(repoRoot, "package-lock.json"), committed);
    assert.equal(readLockfileText(repoRoot), committed);
    assert.equal(
      restoreScopedFlagOnlyLockfileRewrite({ repoRoot, beforeText: committed })
        .reason,
      "unchanged",
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("cacheVerifyArgs preserves an explicit npm cache path", () => {
  assert.deepEqual(cacheVerifyArgs(["dedupe", "--cache", "/tmp/npm-cache"]), [
    "cache",
    "verify",
    "--cache",
    "/tmp/npm-cache",
  ]);
  assert.deepEqual(cacheVerifyArgs(["--cache=/tmp/npm-cache", "install"]), [
    "cache",
    "verify",
    "--cache=/tmp/npm-cache",
  ]);
  assert.deepEqual(cacheVerifyArgs(["install"]), ["cache", "verify"]);
});

test("verificationScopeForNpmArgs maps npm workspace names and paths without widening to unselected workspaces", () => {
  const repoRoot = "/repo";
  const manifests = new Map([
    ["/repo/package.json", { workspaces: ["apps/*", "!apps/*-checkpoint"] }],
    ["/repo/apps/drill-checkpoint/package.json", { name: "@papercusp/drill-checkpoint" }],
    ["/repo/apps/web/package.json", { name: "@papercusp/web" }],
    [
      "/repo/apps/operator-vite/package.json",
      { name: "@papercusp/operator-vite" },
    ],
    [
      "/repo/apps/operator-docs/package.json",
      { name: "@papercusp/operator-docs" },
    ],
  ]);
  const deps = {
    readJson: (path) => manifests.get(path),
    existsSync: (path) => path === "/repo/apps" || manifests.has(path),
    readDir: () => [
      { name: "drill-checkpoint", isDir: true },
      { name: "web", isDir: true },
      { name: "operator-vite", isDir: true },
      { name: "operator-docs", isDir: true },
    ],
  };

  assert.throws(() => verificationScopeForNpmArgs({
    repoRoot, npmArgs: ["install", "--workspace=@papercusp/drill-checkpoint"], deps,
  }), /workspace selector did not resolve/);

  assert.deepEqual(
    verificationScopeForNpmArgs({
      repoRoot,
      npmArgs: [
        "install",
        "--workspace=@papercusp/web",
        "-w",
        "apps/operator-vite",
      ],
      deps,
    }),
    {
      workspaceDirs: ["apps/web", "apps/operator-vite"],
      repairWorkspaceArgs: [
        "--workspace=@papercusp/web",
        "--workspace=apps/operator-vite",
      ],
    },
  );
  assert.deepEqual(
    verificationScopeForNpmArgs({ repoRoot, npmArgs: ["install"], deps }),
    { workspaceDirs: undefined, repairWorkspaceArgs: [] },
  );
});

test("verifyNpmCache invokes npm cache verify in the target repo and returns its status", () => {
  const calls = [];
  const env = { NPM_CONFIG_CACHE: "/tmp/npm-cache" };
  const status = verifyNpmCache({
    repoRoot: "/tmp/papercusp-test-repo",
    npmArgs: ["dedupe", "--cache", "/tmp/explicit-cache"],
    env,
    runNpm: (...args) => {
      calls.push(args);
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [
    [
      "npm",
      ["cache", "verify", "--cache", "/tmp/explicit-cache"],
      {
        cwd: "/tmp/papercusp-test-repo",
        stdio: "inherit",
        env,
      },
    ],
  ]);
});

test("verifyNpmCache returns a failure status without hiding npm cache errors", () => {
  assert.equal(
    verifyNpmCache({
      runNpm: () => ({ status: 7 }),
    }),
    7,
  );
});

test("parseCliArgs consumes the wrapper-only offline-safe flag", () => {
  const parsed = parseCliArgs(["--offline-safe", "ci", "--ignore-scripts"]);

  assert.equal(parsed.offlineSafe, true);
  assert.deepEqual(parsed.npmArgs, ["ci", "--ignore-scripts"]);
});

test("parseCliArgs keeps offline-safe out of npm argv after an explicit repo root", () => {
  const parsed = parseCliArgs(
    ["--repo-root", "../sidestage", "--offline-safe", "--", "install", "--no-save"],
    { cwd: "/managed/papercusp" },
  );

  assert.deepEqual(parsed, {
    repoRoot: "/managed/sidestage",
    npmArgs: ["install", "--no-save"],
    offlineSafe: true,
  });
});

test("npmChildEnv overrides onnxruntime postinstall only in offline-safe mode", () => {
  const callerEnv = {
    PATH: "/bin",
    CUSTOM_SETTING: "preserve",
  };

  assert.deepEqual(npmChildEnv({ env: callerEnv }), callerEnv);
  assert.deepEqual(npmChildEnv({ env: callerEnv, offlineSafe: true }), {
    ...callerEnv,
    ONNXRUNTIME_NODE_INSTALL: "skip",
  });
  assert.equal(callerEnv.ONNXRUNTIME_NODE_INSTALL, undefined);
});

test("npmChildEnv preserves an explicit caller install choice in offline-safe mode", () => {
  const callerEnv = { ONNXRUNTIME_NODE_INSTALL: "cuda12" };

  assert.deepEqual(
    npmChildEnv({ env: callerEnv, offlineSafe: true }),
    callerEnv,
  );
});

test('dependency verification repairs nested dependency executable links before publishing', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'install-safe-nested-bin-'));
  const owner = join(repoRoot, 'node_modules/@scope/owner');
  const bin = join(owner, 'node_modules/.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ workspaces: [] }));
  writeFileSync(join(owner, 'package.json'), JSON.stringify({ name: '@scope/owner', version: '1.0.0' }));
  const broken = join(bin, '.tool-retired');
  const healthy = join(bin, 'healthy.cmd');
  symlinkSync('../missing/cli.js', broken);
  writeFileSync(healthy, 'healthy shim');
  let repairs = 0;
  try {
    const result = await verifyDepsExtracted({
      repoRoot, probeSpecifiers: [], env: {}, deps: { sleep: async () => {} },
      runNpm: () => {
        repairs++;
        assert.throws(() => lstatSync(broken), { code: 'ENOENT' });
        assert.equal(readFileSync(healthy, 'utf8'), 'healthy shim');
        return 0;
      },
    });
    assert.equal(result, 0);
    assert.equal(repairs, 1);
    assert.throws(() => lstatSync(broken), { code: 'ENOENT' });
    assert.equal(readFileSync(healthy, 'utf8'), 'healthy shim');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

for (const needsRepair of [false, true]) {
  test(`dependency verification provisions embedded extensions after scoped reify (repair=${needsRepair})`, async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "install-safe-pg-extensions-"));
    const nativePackages = [
      "node_modules/@embedded-postgres/linux-x64",
      "apps/operator/node_modules/@embedded-postgres/linux-x64",
    ];
    const put = (path, content) => {
      const target = join(repoRoot, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content));
    };
    put("package.json", { workspaces: ["apps/operator"] });
    put("apps/operator/package.json", {
      name: "operator-fixture",
      dependencies: needsRepair ? { "was-missing": "^1" } : {},
    });
    const packages = { "": {} };
    for (const path of nativePackages) {
      packages[path] = { version: "18.4.0-beta.1" };
      put(path + "/package.json", { name: "@embedded-postgres/linux-x64", version: "18.4.0-beta.1" });
      mkdirSync(join(repoRoot, path, "native"));
    }
    put("package-lock.json", { lockfileVersion: 3, packages });
    put("host/vector.so", "fixture-vector-library");
    put("host/extension/vector.control", "default_version = '0.8.1'");
    put("host/extension/vector--0.8.1.sql", "-- fixture extension SQL");
    let repairs = 0;
    try {
      const status = await verifyDepsExtracted({
        repoRoot,
        npmArgs: ["install", "--workspace=operator-fixture"],
        probeSpecifiers: [],
        env: {
          PAPERCUSP_PGVECTOR_LIB: join(repoRoot, "host/vector.so"),
          PAPERCUSP_PGVECTOR_EXT_DIR: join(repoRoot, "host/extension"),
        },
        deps: { sleep: async () => {} },
        runNpm: () => {
          repairs++;
          mkdirSync(join(repoRoot, "node_modules/was-missing"), { recursive: true });
          return 0;
        },
      });
      assert.equal(status, 0);
      assert.equal(repairs, needsRepair ? 1 : 0);
      for (const path of nativePackages) {
        assert.equal(readFileSync(join(repoRoot, path, "native/lib/postgresql/vector.so"), "utf8"), "fixture-vector-library");
        assert.equal(readFileSync(join(repoRoot, path, "native/share/postgresql/extension/vector.control"), "utf8"), "default_version = '0.8.1'");
        assert.ok(existsSync(join(repoRoot, path, "native/share/postgresql/extension/vector--0.8.1.sql")));
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
}

test("dependency verification refuses an embedded server without a required extension source", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "install-safe-pg-unavailable-"));
  const pkg = join(repoRoot, "node_modules/@embedded-postgres/linux-x64");
  mkdirSync(join(pkg, "native"), { recursive: true });
  writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ workspaces: [] }));
  // A distinct major keeps the fixture independent of host-installed extensions.
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "97.0.0" }));
  try {
    assert.equal(await verifyDepsExtracted({ repoRoot, probeSpecifiers: [], env: {} }), 1);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("verifyDepsExtracted passes the selected npm environment to bounded repairs", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "install-safe-repair-env-"));
  const workspace = join(repoRoot, "apps/operator");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(repoRoot, "package.json"),
    JSON.stringify({ workspaces: ["apps/operator"] }),
  );
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ dependencies: { "was-missing": "^1" } }),
  );

  const env = {
    PATH: "/bin",
    ONNXRUNTIME_NODE_INSTALL: "skip",
    PAPERCUSP_INSTALL_SAFE_ACTIVE: "1",
  };
  const calls = [];
  try {
    const status = await verifyDepsExtracted({
      repoRoot,
      env,
      runNpm: (args, options) => {
        calls.push({ args, options });
        mkdirSync(join(repoRoot, "node_modules/was-missing"), {
          recursive: true,
        });
        return 0;
      },
      deps: { sleep: async () => {} },
    });

    assert.equal(status, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["install", "--legacy-peer-deps"]);
    assert.deepEqual(calls[0].options, {
      cwd: repoRoot,
      stdio: "inherit",
      env,
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

for (const inlinePrefix of [false, true]) {
  for (const installed of [false, true]) {
    test(`explicit-prefix verification keeps the full-root audit without a root repair (${inlinePrefix}, ${installed})`, async () => {
      const repoRoot = mkdtempSync(join(tmpdir(), "install-safe-prefix-"));
      const prefix = join(repoRoot, "kits/template");
      const put = (path, value) => {
        const target = join(repoRoot, path);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, JSON.stringify(value));
      };
      put("package.json", { name: "fixture", workspaces: [] });
      put("kits/template/package.json", { name: "template", devDependencies: { types: "22.20.5" } });
      put("package-lock.json", {
        lockfileVersion: 3,
        packages: { "": {}, "kits/template/node_modules/types": { version: "22.20.5" } },
      });
      mkdirSync(join(repoRoot, "node_modules"));
      if (installed) put("kits/template/node_modules/types/package.json", { name: "types", version: "22.20.5" });
      const before = readFileSync(join(repoRoot, "package-lock.json"), "utf8");
      const calls = [];
      try {
        const result = await verifyDepsExtracted({
          repoRoot,
          npmArgs: ["install", ...(inlinePrefix ? [`--prefix=${prefix}`] : ["--prefix", prefix])],
          probeSpecifiers: [],
          deps: { sleep: async () => {} },
          runNpm: (args) => { calls.push(args); return 0; },
        });
        assert.equal(result, installed ? 0 : 1);
        assert.deepEqual(calls, [], "a prefixed install must not fall back to root npm install");
        assert.equal(readFileSync(join(repoRoot, "package-lock.json"), "utf8"), before);
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    });
  }
}

test("publishDependencyGeneration invokes the shared atomic publisher after install verification", async () => {
  const repoRoot = mkdtempSync(
    join(tmpdir(), "install-safe-generation-publish-"),
  );
  const calls = [];
  const env = { PATH: "/bin" };
  try {
    const status = await publishDependencyGeneration({
      repoRoot,
      env,
      runPublisher: (...args) => {
        calls.push(args);
        return { status: 0 };
      },
    });

    assert.equal(status, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "bash");
    assert.match(calls[0][1][0], /dependency-generation\.sh$/);
    assert.deepEqual(calls[0][1].slice(1), ["--integration", repoRoot]);
    assert.deepEqual(calls[0][2], {
      cwd: repoRoot,
      stdio: "inherit",
      env,
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

for (const outcome of ["repaired", "unchanged", "failed"]) {
  test(`workspace-scoped verification detects locked topology drift outside its selection (${outcome})`, async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "install-safe-lock-topology-"));
    const put = (path, value) => {
      const full = join(repoRoot, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, JSON.stringify(value));
    };
    put("package.json", { workspaces: ["apps/selected", "apps/other"] });
    put("apps/selected/package.json", { name: "selected" });
    put("apps/other/package.json", { name: "other", dependencies: { types: "1.0.0" } });
    put("apps/other/node_modules/types/package.json", { name: "types", version: "1.0.0", dependencies: { undici: "7.0.0" } });
    // Node can resolve the correct version here, but the root lock pins it at
    // types/node_modules/undici, as in the measured undici-types incident.
    put("apps/other/node_modules/undici/package.json", { name: "undici", version: "7.0.0" });
    mkdirSync(join(repoRoot, "node_modules"));
    put("package-lock.json", {
      lockfileVersion: 3,
      packages: {
        "": {},
        "apps/selected": { name: "selected" },
        "apps/other": { name: "other", dependencies: { types: "1.0.0" } },
        "apps/other/node_modules/types": { version: "1.0.0" },
        "apps/other/node_modules/types/node_modules/undici": { version: "7.0.0" },
      },
    });
    const calls = [];
    try {
      const result = await verifyDepsExtracted({
        repoRoot,
        npmArgs: ["install", "--workspace=selected"],
        probeSpecifiers: [],
        deps: { sleep: async () => {} },
        runNpm: (args) => {
          calls.push(args);
          if (outcome === "repaired")
            put("apps/other/node_modules/types/node_modules/undici/package.json", { name: "undici", version: "7.0.0" });
          return outcome === "failed" ? 2 : 0;
        },
      });
      assert.deepEqual(calls, [["install", "--legacy-peer-deps"]]);
      assert.equal(result, outcome === "repaired" ? 0 : 1);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
}

test("publishDependencyGeneration preserves an explicit emergency skip", async () => {
  let called = false;
  assert.equal(
    await publishDependencyGeneration({
      env: { PAPERCUSP_SKIP_DEP_GENERATION: "1" },
      runPublisher: () => {
        called = true;
        return { status: 0 };
      },
    }),
    0,
  );
  assert.equal(called, false);
});

test("cache-only package runner waits for maintenance even with an inherited repo reader marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "install-safe-cache-command-"));
  const previousLockRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = join(root, "locks");
  let releaseWriter;
  let writerReady;
  const ready = new Promise(resolve => { writerReady = resolve; });
  const writer = withFsMutex(PACKAGE_CACHE_MUTEX_NAME, async () => {
    writerReady();
    await new Promise(resolve => { releaseWriter = resolve; });
  });
  let runner;
  try {
    await ready;
    let entered = false;
    const parsed = parseCliArgs(["--repo-root", root, "--exec-under-cache-lock", "--", "npx", "--yes", "esbuild@0.25.0", "input with spaces.ts"]);
    assert.equal(parsed.cacheRead, true);
    runner = runCommandUnderInstallMutex({
      ...parsed,
      env: { PAPERCUSP_INSTALL_MUTEX_HELD: repoLockName(root) },
      runCommand: (command, args, options) => {
        entered = true;
        assert.equal(command, "npx");
        assert.deepEqual(args, ["--yes", "esbuild@0.25.0", "input with spaces.ts"]);
        assert.equal(options.cwd, root);
        assert.equal(options.env.PAPERCUSP_INSTALL_MUTEX_HELD, repoLockName(root));
        assert.ok(existsSync(join(root, "locks", "package-manager-cache.readers")));
        return { status: 17 };
      },
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(entered, false, "repo marker must not bypass cache maintenance");
    releaseWriter();
    await writer;
    assert.equal(await runner, 17);
    assert.equal(entered, true);
  } finally {
    releaseWriter?.();
    await writer;
    if (runner) await runner.catch(() => {});
    if (previousLockRoot === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousLockRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("package-cache cleanup waits for every safe-install cache reader across repo locks", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "install-safe-package-cache-reader-"),
  );
  const previousLockRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = join(root, "locks");

  let readerStarted;
  const readerReady = new Promise((resolve) => {
    readerStarted = resolve;
  });
  let releaseReader;
  const readerMayFinish = new Promise((resolve) => {
    releaseReader = resolve;
  });
  let reader;

  try {
    reader = withPackageCacheReadLease(async () => {
      readerStarted();
      await readerMayFinish;
      return "installed";
    });
    await readerReady;

    let cleanupEntered = false;
    let cleanupWaiting = false;
    const cleanup = withFsMutex(
      PACKAGE_CACHE_MUTEX_NAME,
      async () => {
        cleanupEntered = true;
        return "cleaned";
      },
      {
        timeoutMs: 2_000,
        retryMs: 1,
        onWaiting: () => {
          cleanupWaiting = true;
        },
      },
    );
    for (let attempt = 0; attempt < 100 && !cleanupWaiting; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(cleanupWaiting, true);
    assert.equal(cleanupEntered, false);

    releaseReader();
    assert.equal(await reader, "installed");
    assert.equal(await cleanup, "cleaned");
    assert.equal(cleanupEntered, true);
  } finally {
    releaseReader?.();
    if (reader) await reader.catch(() => {});
    if (previousLockRoot === undefined)
      delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousLockRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishDependencyGeneration holds a reader lock until the publisher finishes", async () => {
  const repoRoot = mkdtempSync(
    join(tmpdir(), "install-safe-generation-reader-"),
  );
  const previousLockRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = join(repoRoot, "locks");

  let publisherStarted;
  const publisherReady = new Promise((resolve) => {
    publisherStarted = resolve;
  });
  let releasePublisher;
  const publisherMayFinish = new Promise((resolve) => {
    releasePublisher = resolve;
  });
  let publishing;

  try {
    publishing = publishDependencyGeneration({
      repoRoot,
      env: { PATH: process.env.PATH ?? "" },
      runPublisher: async () => {
        publisherStarted();
        await publisherMayFinish;
        return { status: 0 };
      },
    });
    await publisherReady;

    let writerEntered = false;
    let writerWaiting = false;
    const writer = withFsMutex(
      repoLockName(repoRoot),
      async () => {
        writerEntered = true;
        return 0;
      },
      {
        timeoutMs: 2_000,
        retryMs: 1,
        onWaiting: () => {
          writerWaiting = true;
        },
      },
    );
    for (let attempt = 0; attempt < 100 && !writerWaiting; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(writerWaiting, true);
    assert.equal(writerEntered, false);

    releasePublisher();
    assert.equal(await publishing, 0);
    assert.equal(await writer, 0);
    assert.equal(writerEntered, true);
  } finally {
    releasePublisher?.();
    if (publishing) await publishing.catch(() => {});
    if (previousLockRoot === undefined)
      delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousLockRoot;
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("nested exec-under-lock readers do not reacquire the writer mutex", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "install-safe-nested-reader-"));
  const previousEnv = {
    PAPERCUSP_FS_MUTEX_LOCK_DIR: process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR,
    PAPERCUSP_FS_MUTEX_TIMEOUT_MS: process.env.PAPERCUSP_FS_MUTEX_TIMEOUT_MS,
    PAPERCUSP_FS_MUTEX_RETRY_MS: process.env.PAPERCUSP_FS_MUTEX_RETRY_MS,
    PAPERCUSP_INSTALL_MUTEX_HELD: process.env.PAPERCUSP_INSTALL_MUTEX_HELD,
  };
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = join(repoRoot, "locks");
  process.env.PAPERCUSP_FS_MUTEX_TIMEOUT_MS = "25";
  process.env.PAPERCUSP_FS_MUTEX_RETRY_MS = "1";
  process.env.PAPERCUSP_INSTALL_MUTEX_HELD = repoLockName(repoRoot);

  try {
    const calls = [];
    await withFsMutex(repoLockName(repoRoot), async () => {
      await assert.doesNotReject(
        runCommandUnderInstallMutex({
          repoRoot,
          commandArgs: ["ptool", "events:status"],
          runCommand: (...args) => {
            calls.push(args);
            return { status: 0 };
          },
        }),
      );
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0][2].env.PAPERCUSP_INSTALL_MUTEX_HELD, repoLockName(repoRoot));
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("install readers keep reporting a held writer on the configured cadence", async (context) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "install-safe-reader-notices-"));
  const previousLockRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  const previousTimeout = process.env.PAPERCUSP_FS_MUTEX_TIMEOUT_MS;
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = join(repoRoot, "locks");
  process.env.PAPERCUSP_FS_MUTEX_TIMEOUT_MS = "180000";
  const originalError = console.error;
  let releaseWriter;
  let writerStarted;
  const writerReady = new Promise(resolve => { writerStarted = resolve; });
  const writer = withFsMutex(repoLockName(repoRoot), async () => {
    writerStarted();
    await new Promise(resolve => { releaseWriter = resolve; });
  });
  let reading;
  let noticeDeadline;
  try {
    await writerReady;
    let firstNotice;
    let nextNotice;
    const first = new Promise(resolve => { firstNotice = resolve; });
    const next = new Promise(resolve => { nextNotice = resolve; });
    const notices = [];
    const acquiredLines = [];
    console.error = message => {
      if (String(message).startsWith("NPM_INSTALL_SAFE reader waiting")) {
        notices.push(String(message));
        if (notices.length === 1) firstNotice();
        else nextNotice();
      }
      if (String(message).startsWith("NPM_INSTALL_SAFE_LOCK_ACQUIRED")) acquiredLines.push(String(message));
    };
    // Advance only the observed clock. Real filesystem operations and the
    // mutex retry timer continue to run, without waiting 30 seconds in CI.
    context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    let childEntered = false;
    reading = runCommandUnderInstallMutex({
      repoRoot,
      commandArgs: ["reader"],
      env: {},
      runCommand: () => { childEntered = true; return { status: 0 }; },
    });
    await first;
    context.mock.timers.tick(30_000);
    await Promise.race([next, new Promise((_, reject) => {
      noticeDeadline = setTimeout(() => reject(new Error("reader stopped reporting its held writer")), 1500);
    })]);
    assert.match(notices[0], /\(0s so far\)/);
    assert.match(notices[1], /\(30s so far\)/);
    assert.equal(childEntered, false);
    assert.deepEqual(acquiredLines, []);
    releaseWriter();
    await writer;
    assert.equal(await reading, 0);
    assert.equal(childEntered, true);
    // WI-10006385: the wait closes with ONE line naming its real length and budget.
    assert.equal(acquiredLines.length, 1);
    const [, waitedMs, budgetMs] =
      acquiredLines[0].match(/^NPM_INSTALL_SAFE_LOCK_ACQUIRED lock=reader waitedMs=(\d+) budgetMs=(\d+)$/) ?? [];
    assert.ok(Number(waitedMs) >= 30_000, acquiredLines[0]);
    assert.equal(Number(budgetMs), 180_000);
  } finally {
    clearTimeout(noticeDeadline);
    releaseWriter?.();
    await writer.catch(() => {});
    await reading?.catch(() => {});
    context.mock.timers.reset();
    console.error = originalError;
    if (previousLockRoot === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousLockRoot;
    if (previousTimeout === undefined) delete process.env.PAPERCUSP_FS_MUTEX_TIMEOUT_MS;
    else process.env.PAPERCUSP_FS_MUTEX_TIMEOUT_MS = previousTimeout;
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// WI-10004430: `npm cache verify` ends with `rm -rf <cache>/tmp`, so it must never run
// while another checkout reifies from the same user-level cache. The repo-keyed install
// mutex cannot provide that (different checkouts hash to different locks); only the
// host-wide package-cache lock can.

function setEnv(values) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function holdPackageCacheReader() {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  let release;
  const mayFinish = new Promise((resolve) => {
    release = resolve;
  });
  const done = withPackageCacheReadLease(async () => {
    started();
    await mayFinish;
  });
  return { ready, release, done };
}

test("install:safe verifies the npm cache exclusively, then resolves and reifies under shared cache leases", async () => {
  const root = mkdtempSync(join(tmpdir(), "install-safe-cache-order-"));
  const binDir = join(root, "bin");
  const repoRoot = join(root, "repo");
  const npmLog = join(root, "npm.log");
  mkdirSync(binDir);
  mkdirSync(repoRoot);
  // A fake npm that records, for each call, whether the host-wide package-cache WRITER
  // lock exists and how many READER leases are held at that instant.
  writeFileSync(
    join(binDir, "npm"),
    [
      "#!/usr/bin/env bash",
      'L="$PAPERCUSP_FS_MUTEX_LOCK_DIR"',
      'w=no; [ -d "$L/package-manager-cache.lock" ] && w=yes',
      'r=$(ls -A "$L/package-manager-cache.readers" 2>/dev/null | wc -l | tr -d " ")',
      'echo "$1 writer=$w readers=$r" >> "$FAKE_NPM_LOG"',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const restoreEnv = setEnv({
    ...NPM_FIXTURE_CONFIG_RESET,
    PAPERCUSP_FS_MUTEX_LOCK_DIR: join(root, "locks"),
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    FAKE_NPM_LOG: npmLog,
    PAPERCUSP_SKIP_DEP_VERIFY: "1",
    PAPERCUSP_SKIP_DEP_GENERATION: "1",
  });
  try {
    // NPM_INSTALL_SAFE_SUBJECT lets scripts/mutation-probe.sh point this guard at a copy.
    const subject = process.env.NPM_INSTALL_SAFE_SUBJECT;
    const runMain = subject
      ? (await import(pathToFileURL(subject).href)).main
      : main;
    assert.equal(await runMain(["--repo-root", repoRoot, "install"]), 0);
    assert.deepEqual(readFileSync(npmLog, "utf8").trim().split("\n"), [
      "cache writer=yes readers=0",
      "install writer=no readers=1",
      "install writer=no readers=1",
    ]);
  } finally {
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyNpmCacheExclusive waits for a concurrent install's cache lease before verifying", async () => {
  const root = mkdtempSync(join(tmpdir(), "install-safe-verify-wait-"));
  const restoreEnv = setEnv({ PAPERCUSP_FS_MUTEX_LOCK_DIR: join(root, "locks") });
  const reader = holdPackageCacheReader();
  try {
    await reader.ready;
    let verifyEntered = false;
    let waiting = false;
    const verifying = verifyNpmCacheExclusive({
      verify: () => {
        verifyEntered = true;
        return 0;
      },
      waitMs: 5_000,
      log: (line) => {
        if (line.includes("waiting for exclusive use")) waiting = true;
      },
    });
    for (let attempt = 0; attempt < 400 && !waiting; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(waiting, true);
    assert.equal(verifyEntered, false);

    reader.release();
    await reader.done;
    assert.equal(await verifying, 0);
    assert.equal(verifyEntered, true);
  } finally {
    reader.release();
    await reader.done.catch(() => {});
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyNpmCacheExclusive skips verify instead of failing the install when the cache stays busy", async () => {
  const root = mkdtempSync(join(tmpdir(), "install-safe-verify-skip-"));
  const restoreEnv = setEnv({ PAPERCUSP_FS_MUTEX_LOCK_DIR: join(root, "locks") });
  const reader = holdPackageCacheReader();
  try {
    await reader.ready;
    const lines = [];
    let verifyCalled = false;
    const status = await verifyNpmCacheExclusive({
      verify: () => {
        verifyCalled = true;
        return 1;
      },
      waitMs: 150,
      log: (line) => lines.push(line),
    });
    assert.equal(status, 0);
    assert.equal(verifyCalled, false);
    assert.ok(
      lines.some((line) => line.startsWith("NPM_INSTALL_SAFE_CACHE_VERIFY_SKIPPED")),
      `expected a loud skip line, got: ${JSON.stringify(lines)}`,
    );
  } finally {
    reader.release();
    await reader.done.catch(() => {});
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyNpmCacheExclusive reports verify's own failure instead of treating it as a skip", async () => {
  const acquire = async (_name, fn) => fn();
  assert.equal(
    await verifyNpmCacheExclusive({ verify: () => 3, acquire, log: () => {} }),
    3,
  );
  await assert.rejects(
    verifyNpmCacheExclusive({
      verify: () => {
        throw new Error("verify crashed");
      },
      acquire,
      log: () => {},
    }),
    /verify crashed/,
  );
});

test("install reader preserves real child signals and ordinary exit codes", async () => {
  for (const [program, expected, signal] of [
    ["process.kill(process.pid, 'SIGTERM')", 143, 'SIGTERM'],
    ["process.kill(process.pid, 'SIGKILL')", 137, 'SIGKILL'],
    ["process.exit(7)", 7, null],
    ["process.exit(0)", 0, null],
  ]) {
    const events = [];
    const result = await runCommandUnderInstallMutex({
      commandArgs: [process.execPath, '-e', program],
      acquireReadMutex: async (_name, run) => run(),
      env: {},
      log: (line) => events.push(line),
    });
    assert.equal(result, expected);
    if (signal) assert.match(events.join('\n'), new RegExp(`signal=${signal} exitCode=${expected}`));
    else assert.equal(events.length, 0);
  }
});

test("test:file reader-lock acquisition failure is NOT MEASURED before the child starts", async () => {
  const events = [];
  let childStarted = false;
  const lockFailure = Object.assign(new Error("ENOSPC creating reader lock"), { code: "ENOSPC" });
  const result = await runCommandUnderInstallMutex({
    commandArgs: ["node", "--import", "./scripts/lib/committed-source-loader.mjs", "scripts/test-files.mjs", "packages/operator-core/lib/example.test.ts"],
    acquireReadMutex: async () => { throw lockFailure; },
    runCommand: () => { childStarted = true; return { status: 0 }; },
    env: {},
    log: (line) => events.push(line),
  });

  assert.equal(childStarted, false);
  assert.equal(result, TEST_FILE_EXIT_NOT_MEASURED);
  assert.match(events.join("\n"), /NPM_INSTALL_SAFE_ERROR ENOSPC/);
  assert.match(events.join("\n"), /TEST_FILE_NOT_MEASURED reason=install-reader-lock-acquisition/);

  await assert.rejects(
    runCommandUnderInstallMutex({
      commandArgs: ["node", "scripts/build.mjs"],
      acquireReadMutex: async () => { throw lockFailure; },
      env: {},
      log: () => {},
    }),
    /ENOSPC creating reader lock/,
  );
});

test("test:file runs Vitest under the repo install reader mutex", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  // WI-10005802: both hops start under the committed-source loader, so the mutex wrapper and the
  // router run their committed (HEAD) bytes.
  assert.match(
    packageJson.scripts["test:file"],
    /bash scripts\/pc-heavy\.sh node --import \.\/scripts\/lib\/committed-source-loader\.mjs scripts\/npm-install-safe\.mjs --exec-under-lock -- node --import \.\/scripts\/lib\/committed-source-loader\.mjs scripts\/test-files\.mjs$/,
  );
  assert.match(
    packageJson.scripts["test:affected"],
    /bash scripts\/pc-heavy\.sh node --import \.\/scripts\/lib\/committed-source-loader\.mjs scripts\/npm-install-safe\.mjs --exec-under-lock -- node scripts\/affected-tests\.mjs$/,
  );
});

test("symlinked npm-install-safe CLI executes reader commands", () => {
  const root = mkdtempSync(join(tmpdir(), "npm-install-safe-symlink-"));
  const cliLink = join(root, "npm-install-safe.mjs");
  try {
    symlinkSync(
      fileURLToPath(new URL("./npm-install-safe.mjs", import.meta.url)),
      cliLink,
    );
    const result = spawnSync(
      process.execPath,
      [
        cliLink,
        "--repo-root",
        root,
        "--exec-under-lock",
        "--",
        process.execPath,
        "-e",
        'process.stdout.write("npm-install-safe-symlink-reader-ran")',
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PAPERCUSP_FS_MUTEX_LOCK_DIR: join(root, "locks"),
        },
        timeout: 10_000,
      },
    );

    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /NPM_INSTALL_SAFE guarding reader/);
    assert.match(result.stdout, /npm-install-safe-symlink-reader-ran/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// EI-24937341882865098: `--help` used to be rewritten to `npm install --help`, which first waited
// on the repo-keyed install mutex — a silent multi-minute hang that read like a real install.
test("parseCliArgs treats a leading --help / -h as a wrapper help request", () => {
  assert.deepEqual(parseCliArgs(["--help"]), { help: true });
  assert.deepEqual(parseCliArgs(["-h"]), { help: true });
  // Only the FIRST argument is the wrapper's: an explicit npm subcommand keeps npm's own help.
  assert.deepEqual(parseCliArgs(["install", "--help"]).npmArgs, ["install", "--help"]);
  // Calibration: an ordinary leading flag still gets the implicit install.
  assert.deepEqual(parseCliArgs(["--legacy-peer-deps"]).npmArgs, ["install", "--legacy-peer-deps"]);
});


test("the CLI prints usage for --help and exits 0 without spawning npm or taking the mutex", () => {
  const cli = fileURLToPath(new URL("./npm-install-safe.mjs", import.meta.url));
  // Keep git available to the committed-source loader, but no npm on PATH: if --help ever
  // reaches npm, the child fails immediately rather than hanging or running an install.
  const gitExecutable = process.env.PATH
    .split(delimiter)
    .map((dir) => join(dir, "git"))
    .find((path) => existsSync(path));
  assert.ok(gitExecutable, "git must be available to the committed-source loader");
  const binDir = mkdtempSync(join(tmpdir(), "npm-install-safe-help-path-"));
  try {
    symlinkSync(gitExecutable, join(binDir, "git"));
    const result = spawnSync(process.execPath, [cli, "--help"], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, PATH: binDir },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, USAGE);
    assert.match(USAGE, /^Usage: npm run install:safe/);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});
