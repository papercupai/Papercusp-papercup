#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const SCHEMA_VERSION = "bundle-host-freshness-v2";

function parseArgs(argv) {
  const [operation, ...rest] = argv;
  const values = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith("--") || value === undefined)
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    values[key.slice(2)] = value;
  }
  return { operation, values };
}

function required(values, key) {
  const value = values[key];
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

// The default bound is a hang guard for cheap plumbing calls (rev-parse).
// `status --ignore-submodules=none` is different: on a freshly created staging
// candidate the index is cold, so git must re-stat (and re-hash racily clean
// entries of) the whole tree. Measured 2026-10-02 at load average ~120: the
// stamp step took ~20s on a fresh candidate against 0.7s on a warm tree, and an
// 11:38Z run crossed the old flat 30s cap. bundle-host.sh then skipped the
// freshness proof, and staging-sync refused the finished generation
// (EI-24867768475421999). The status bound stays finite so a hung git still fails.
const GIT_TIMEOUT_MS = 30_000;
const GIT_STATUS_TIMEOUT_MS = 300_000;

function git(repoRoot, args, timeoutMs = GIT_TIMEOUT_MS) {
  const started = Date.now();
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    }).trim();
  } catch (error) {
    // Name the command, the elapsed time and the bound: a bare
    // "spawnSync git ETIMEDOUT" cannot say which call failed or how close it came.
    const cause =
      error?.code ??
      (error?.signal ? `signal ${error.signal}` : `exit ${error?.status}`);
    const stderr = String(error?.stderr ?? "")
      .trim()
      .split("\n")
      .slice(-2)
      .join(" | ");
    throw new Error(
      `git ${args.join(" ")} failed after ${Date.now() - started}ms ` +
        `(timeout ${timeoutMs}ms): ${cause}${stderr ? ` — ${stderr}` : ""}`,
    );
  }
}

function sourceIdentity(repoRoot) {
  const resolvedRoot = realpathSync(repoRoot);
  const gitRoot = realpathSync(
    git(resolvedRoot, ["rev-parse", "--show-toplevel"]),
  );
  if (gitRoot !== resolvedRoot)
    throw new Error(
      `repo root mismatch: requested ${resolvedRoot}, git reports ${gitRoot}`,
    );
  const dirty = git(
    resolvedRoot,
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=no",
      "--ignore-submodules=none",
    ],
    GIT_STATUS_TIMEOUT_MS,
  );
  if (dirty)
    throw new Error(
      "tracked source tree is dirty; a commit SHA cannot prove bundle freshness",
    );
  const headSha = git(resolvedRoot, ["rev-parse", "HEAD^{commit}"]);
  if (!/^[0-9a-f]{40}$/.test(headSha))
    throw new Error(`git returned an invalid HEAD: ${headSha}`);
  return { repoRoot: resolvedRoot, headSha };
}

// HEAD describes the requested dependencies, not the installed realization.
// Pin npm's installed lock AND the actual package manifests/resolution paths:
// a copied/stale hidden lock alone must not bless a physically different SDK.
// Walk package boundaries only (including nested/workspace node_modules), not
// caches or every dependency file; package-content integrity is npm's job.
function dependencyIdentity(repoRoot, entry) {
  const installedLock = join(repoRoot, "node_modules", ".package-lock.json");
  if (!existsSync(installedLock))
    throw new Error(`installed dependency lock is missing: ${installedLock}`);
  const rows = [];
  const seen = new Set();
  const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const visit = (modules) => {
    if (!existsSync(modules)) {
      rows.push({ path: modules, absent: true });
      return;
    }
    const actual = realpathSync(modules);
    rows.push({
      path: modules,
      actual,
      lockSha256: existsSync(join(actual, ".package-lock.json"))
        ? digest(join(actual, ".package-lock.json"))
        : null,
    });
    if (seen.has(actual)) return;
    seen.add(actual);
    const packages = [];
    for (const name of readdirSync(actual).sort()) {
      if (name.startsWith(".")) continue;
      const path = join(actual, name);
      if (name.startsWith("@")) {
        for (const child of readdirSync(path).sort())
          packages.push(join(path, child));
      } else {
        packages.push(path);
      }
    }
    for (const path of packages) {
      const target = realpathSync(path);
      rows.push({ path, actual: target, manifestSha256: digest(join(target, "package.json")) });
      visit(join(target, "node_modules"));
    }
  };
  // Include local resolution roots even if this entry's workspace is not linked
  // from root node_modules. A realpath set terminates workspace/symlink cycles.
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    visit(join(dir, "node_modules"));
    if (dir === repoRoot) break;
    if (dirname(dir) === dir) throw new Error("entry is outside repo root");
  }
  return {
    sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
  };
}

function transientOutputName(path, manifestPath, outfile) {
  const name = basename(path);
  return (
    resolve(path) === resolve(manifestPath) ||
    name === ".bundle-stale.json" ||
    name.endsWith(".build.lock") ||
    name.endsWith(".build-error.log") ||
    // bundle-host.sh stamps before its EXIT trap removes the esbuild tmp
    // metafile. It is build-private state, not part of the runnable output
    // tree, so its later cleanup must not invalidate an otherwise exact proof.
    name.startsWith(`${basename(outfile)}.tmp.`) ||
    name.startsWith(`${basename(manifestPath)}.tmp.`) ||
    // WI-10007018: bundle-host.sh keeps the restricted-hold gate's PID-suffixed
    // esbuild metafiles (.restricted-gate-meta.$$) and last-known-good snapshot
    // (.restricted-lkg.$$) inside OUTDIR, stamps, and only then lets its EXIT
    // trap delete them. Hashing them made every stamp unverifiable.
    name.startsWith(".restricted-gate-meta.") ||
    name.startsWith(".restricted-lkg.")
  );
}

function outputTreeIdentity(outfile, manifestPath) {
  const resolvedOutfile = realpathSync(outfile);
  const outDir = realpathSync(dirname(resolvedOutfile));
  const rows = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolute = join(dir, entry.name);
      if (transientOutputName(absolute, manifestPath, resolvedOutfile))
        continue;
      const rel = relative(outDir, absolute).split("\\").join("/");
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isSymbolicLink()) {
        rows.push({
          path: rel,
          kind: "symlink",
          target: readlinkSync(absolute),
        });
      } else if (entry.isFile()) {
        const bytes = readFileSync(absolute);
        rows.push({
          path: rel,
          kind: "file",
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  };
  visit(outDir);
  const sha256 = createHash("sha256")
    .update(JSON.stringify(rows))
    .digest("hex");
  return { outfile: resolvedOutfile, fileCount: rows.length, sha256 };
}

function normalizedInputs(values) {
  const repoRoot = required(values, "repo-root");
  const entry = required(values, "entry");
  const outfile = required(values, "outfile");
  const manifest = resolve(required(values, "manifest"));
  if (!existsSync(entry)) throw new Error(`entry does not exist: ${entry}`);
  if (!existsSync(outfile))
    throw new Error(`bundle does not exist: ${outfile}`);
  if (!lstatSync(outfile).isFile())
    throw new Error(`bundle is not a regular file: ${outfile}`);
  return {
    source: sourceIdentity(repoRoot),
    entry: realpathSync(entry),
    outfile: realpathSync(outfile),
    manifest,
  };
}

function stamp(values) {
  const inputs = normalizedInputs(values);
  const dependencies = dependencyIdentity(inputs.source.repoRoot, inputs.entry);
  const outputTree = outputTreeIdentity(inputs.outfile, inputs.manifest);
  const record = {
    schemaVersion: SCHEMA_VERSION,
    repoRoot: inputs.source.repoRoot,
    headSha: inputs.source.headSha,
    entry: inputs.entry,
    outfile: inputs.outfile,
    dependencies,
    outputTree,
    stampedAt: new Date().toISOString(),
  };
  const tmp = `${inputs.manifest}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(tmp, inputs.manifest);
  process.stdout.write(`${inputs.source.headSha}\n`);
}

function check(values) {
  const inputs = normalizedInputs(values);
  if (!existsSync(inputs.manifest))
    throw new Error(`freshness manifest does not exist: ${inputs.manifest}`);
  const record = JSON.parse(readFileSync(inputs.manifest, "utf8"));
  if (record?.schemaVersion !== SCHEMA_VERSION)
    throw new Error("freshness manifest schema mismatch");
  if (record.repoRoot !== inputs.source.repoRoot)
    throw new Error("freshness manifest repo root mismatch");
  if (record.headSha !== inputs.source.headSha)
    throw new Error("freshness manifest HEAD mismatch");
  if (record.entry !== inputs.entry)
    throw new Error("freshness manifest entry mismatch");
  if (record.outfile !== inputs.outfile)
    throw new Error("freshness manifest outfile mismatch");
  const dependencies = dependencyIdentity(inputs.source.repoRoot, inputs.entry);
  if (record.dependencies?.sha256 !== dependencies.sha256)
    throw new Error("freshness manifest installed-dependency mismatch");
  const outputTree = outputTreeIdentity(inputs.outfile, inputs.manifest);
  if (
    record.outputTree?.fileCount !== outputTree.fileCount ||
    record.outputTree?.sha256 !== outputTree.sha256
  ) {
    throw new Error("freshness manifest output-tree mismatch");
  }
  process.stdout.write(`${inputs.source.headSha}\n`);
}

try {
  const { operation, values } = parseArgs(process.argv.slice(2));
  if (operation === "stamp") stamp(values);
  else if (operation === "check") check(values);
  else
    throw new Error(
      `expected operation check|stamp, got ${operation ?? "<missing>"}`,
    );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[bundle-freshness] ${message}\n`);
  try {
    const { values } = parseArgs(process.argv.slice(2));
    const manifest = values.manifest ? resolve(values.manifest) : null;
    const tmp = manifest ? `${manifest}.tmp.${process.pid}` : null;
    if (tmp && existsSync(tmp)) unlinkSync(tmp);
  } catch {}
  process.exitCode = 1;
}
