/** D-345: same bounded private artifact reader, executable by plain Node. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join, relative } from 'node:path';

const digestBytes = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

// Node has no posix_fadvise binding. Inherit the parent's already-open file
// description; opening its pathname again would advise a different description.
// Python isolation avoids importing site hooks or PYTHONPATH from the caller.
// Record actual isolated Python imports and native-map file pins; preserve explicit
// startup/mapped-memory observation limits instead of treating a version as proof.
const privateArtifactReadAdvice = [
  "import hashlib, json, os, stat, sys",
  "s = os.fstat(3)",
  "assert [str(s.st_dev), str(s.st_ino), str(s.st_size)] == sys.argv[1:]",
  "os.posix_fadvise(3, 0, 0, os.POSIX_FADV_RANDOM)",
  "def mapped_files():",
  "    paths = set()",
  "    with open(\"/proc/self/maps\") as maps:",
  "        for line in maps:",
  "            fields = line.rstrip(\"\\n\").split(None, 5)",
  "            if len(fields) == 6 and fields[5].startswith(\"/\"):",
  "                path = fields[5]",
  "                assert \"\\\\\" not in path and not path.endswith(\" (deleted)\")",
  "                paths.add(os.path.realpath(path))",
  "    return paths",
  "modules = []",
  "paths = {os.path.realpath(sys.executable), os.readlink(\"/proc/self/exe\")}",
  "for name, module in sorted(sys.modules.copy().items()):",
  "    spec = getattr(module, \"__spec__\", None)",
  "    origin = getattr(spec, \"origin\", None)",
  "    bindings = []",
  "    if origin not in (\"built-in\", \"frozen\"):",
  "        for path in (getattr(module, \"__file__\", None), getattr(module, \"__cached__\", None)):",
  "            if path and os.path.isfile(path):",
  "                resolved = os.path.realpath(path)",
  "                paths.add(resolved)",
  "                bindings.append([path, resolved])",
  "        assert origin is None or bindings, \"Unresolved imported Python module: \" + name",
  "    modules.append(dict(name=name, origin=origin, files=bindings))",
  "assert len(modules) <= 512, \"Python module ceiling exceeded\"",
  "mapped = mapped_files()",
  "paths.update(mapped)",
  "assert 0 < len(paths) <= 256, \"Python dependency file ceiling exceeded\"",
  "dependencies = []",
  "total = 0",
  "def identity(st):",
  "    return (st.st_dev, st.st_ino, st.st_mode, st.st_size, st.st_mtime_ns, st.st_ctime_ns)",
  "for path in sorted(paths):",
  "    before = os.stat(path, follow_symlinks=False)",
  "    assert stat.S_ISREG(before.st_mode), \"Python dependency is not a regular file\"",
  "    total += before.st_size",
  "    assert total <= 256 * 1024 ** 2, \"Python dependency byte ceiling exceeded\"",
  "    h = hashlib.sha256()",
  "    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)",
  "    count = 0",
  "    try:",
  "        assert identity(before) == identity(os.fstat(fd))",
  "        while True:",
  "            chunk = os.read(fd, 1024 ** 2)",
  "            if not chunk: break",
  "            count += len(chunk)",
  "            assert count <= before.st_size",
  "            h.update(chunk)",
  "        assert count == before.st_size",
  "        assert identity(before) == identity(os.fstat(fd))",
  "        assert identity(before) == identity(os.stat(path, follow_symlinks=False))",
  "    finally:",
  "        os.close(fd)",
  "    dependencies.append(dict(path=path, size=count, mode=stat.S_IMODE(before.st_mode),",
  "        sha256=h.hexdigest(), identity=[str(x) for x in identity(before)]))",
  "assert mapped_files() == mapped, \"Python mapped dependencies changed\"",
  "for dep in dependencies:",
  "    assert [str(x) for x in identity(os.stat(dep[\"path\"], follow_symlinks=False))] == dep[\"identity\"]",
  "closure = dict(schemaVersion=\"private-artifact-python-inputs-v1\",",
  "    scope=\"isolated-python-imports-and-native-maps\", executable=sys.executable,",
  "    resolvedExecutable=os.readlink(\"/proc/self/exe\"), version=sys.version, modules=modules,",
  "    limitations=[\"startup-file-opens-unobserved\", \"mapped-memory-bytes-unobserved\"],",
  "    files=[{k: v for k, v in dep.items() if k != \"identity\"} for dep in dependencies])",
  "dependencySha256 = hashlib.sha256(json.dumps(closure, sort_keys=True, separators=(\",\", \":\")).encode()).hexdigest()",
  "print(json.dumps(dict(dev=str(s.st_dev), ino=str(s.st_ino), size=str(s.st_size),",
  "    executable=sys.executable, version=sys.version, advice=\"POSIX_FADV_RANDOM\",",
  "    dependencies=closure, dependencySha256=dependencySha256)))",
].join('\n');

export interface PrivateArtifactReadAdvice {
  path: string;
  dev: string;
  ino: string;
  size: string;
  executable: string;
  version: string;
  advice: 'POSIX_FADV_RANDOM';
  helperSha256: string;
  dependencySha256: string;
  dependencies: {
    schemaVersion: 'private-artifact-python-inputs-v1';
    scope: 'isolated-python-imports-and-native-maps';
    executable: string;
    resolvedExecutable: string;
    version: string;
    modules: Array<{ name: string; origin: string | null; files: string[][] }>;
    files: Array<{ path: string; size: number; mode: number; sha256: string }>;
    limitations: string[];
  };
}

/** Full installed-runtime census for private preparation, including large model
 * files. Read advice changes only this open description's readahead policy;
 * every byte is still hashed. Linux requires Python3's stdlib fadvise support.
 * This is source preparation evidence, never loaded-host or acceptance proof.
 */
export function censusPrivateRuntimeArtifact(root: string, options: {
  /** The caller's continuous setup deadline can only shorten our 120s ceiling. */
  deadlineMs?: number;
  /** Prospective fixture pin; absence only records the observed Python inputs. */
  expectedReadAdviceDependencySha256?: string;
  /** Retain advice evidence even if a subsequent identity/stability check fails. */
  onReadAdvice?: (record: PrivateArtifactReadAdvice) => void;
} = {}) {
  const started = Date.now();
  assert.ok(options.deadlineMs === undefined || Number.isFinite(options.deadlineMs), 'Invalid artifact deadline');
  if (options.expectedReadAdviceDependencySha256 !== undefined)
    assert.match(options.expectedReadAdviceDependencySha256, /^[a-f0-9]{64}$/, 'Invalid Python dependency pin');
  const deadline = Math.min(started + 120_000, options.deadlineMs ?? Infinity);
  const digest = createHash('sha256');
  const inventory: Array<{ path: string; kind: 'directory' | 'file'; dev: string; ino: string;
    mtimeNs: string; ctimeNs: string; mode: number; size?: number; sha256?: string }> = [];
  const readAdvice: PrivateArtifactReadAdvice[] = [];
  let files = 0, bytes = 0;
  const withinBudget = () => assert.ok(Date.now() <= deadline, 'Artifact census time ceiling exceeded');
  const stable = (before: import('node:fs').BigIntStats, after: import('node:fs').BigIntStats) => {
    for (const key of ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'] as const)
      assert.equal(after[key], before[key], `Artifact changed during census: ${key}`);
  };
  function walk(dir: string) {
    withinBudget();
    const before = lstatSync(dir, { bigint: true });
    assert.ok(before.isDirectory(), 'Artifact directory cannot be a link or special object');
    assert.ok(inventory.length < 50_000, 'Artifact object ceiling exceeded');
    inventory.push({ path: relative(root, dir), kind: 'directory', dev: String(before.dev),
      ino: String(before.ino), mode: Number(before.mode) & 0o777,
      mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs) });
    for (const name of readdirSync(dir).sort()) {
      withinBudget();
      const file = join(dir, name), st = lstatSync(file, { bigint: true });
      if (st.isDirectory()) { walk(file); continue; }
      assert.ok(st.isFile(), 'Artifact cannot contain a link or special object');
      assert.ok(inventory.length < 50_000, 'Artifact object ceiling exceeded');
      assert.ok(st.size <= BigInt(8 * 1024 ** 3 - bytes), 'Artifact byte ceiling exceeded');
      // NONBLOCK prevents a racing replacement with a FIFO from hanging
      // before fstat. Never follow a replacement symlink.
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const hash = createHash('sha256');
      let readBytes = 0;
      try {
        const opened = fstatSync(fd, { bigint: true });
        assert.ok(opened.isFile(), 'Opened artifact is not a regular file');
        stable(st, opened);
        if (process.platform === 'linux' && st.size >= BigInt(16 * 1024 ** 2)) {
          withinBudget();
          const record: PrivateArtifactReadAdvice = {
            ...JSON.parse(execFileSync('python3', ['-I', '-S', '-B', '-c', privateArtifactReadAdvice,
              String(st.dev), String(st.ino), String(st.size)], {
              stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8', maxBuffer: 512 * 1024,
              timeout: Math.max(1, Math.min(5_000, deadline - Date.now())),
            })),
            path: relative(root, file), helperSha256: digestBytes(privateArtifactReadAdvice),
          };
          for (const key of ['dev', 'ino', 'size'] as const) assert.equal(record[key], String(st[key]));
          assert.equal(record.advice, 'POSIX_FADV_RANDOM');
          assert.ok(record.executable && record.version, 'Read advice interpreter evidence missing');
          assert.equal(record.dependencies.schemaVersion, 'private-artifact-python-inputs-v1');
          assert.equal(record.dependencies.scope, 'isolated-python-imports-and-native-maps');
          assert.match(record.dependencySha256, /^[a-f0-9]{64}$/);
          if (options.expectedReadAdviceDependencySha256 !== undefined)
            assert.equal(record.dependencySha256, options.expectedReadAdviceDependencySha256, 'Python advice dependencies differ from fixture pin');
          if (readAdvice.length) assert.equal(record.dependencySha256, readAdvice[0].dependencySha256,
            'Python advice dependencies changed during artifact census');
          readAdvice.push(record);
          options.onReadAdvice?.({ ...record });
          stable(st, fstatSync(fd, { bigint: true }));
        }
        const chunk = Buffer.allocUnsafe(Math.min(4 * 1024 ** 2, Math.max(1, Number(st.size))));
        let count: number;
        while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
          readBytes += count;
          assert.ok(readBytes <= Number(st.size), 'Artifact grew during census');
          hash.update(chunk.subarray(0, count));
          withinBudget();
        }
        assert.equal(readBytes, Number(st.size), 'Artifact byte count changed during census');
        stable(st, fstatSync(fd, { bigint: true }));
        stable(st, lstatSync(file, { bigint: true }));
      } finally { closeSync(fd); }
      const sha256 = hash.digest('hex'), path = relative(root, file), mode = Number(st.mode) & 0o777;
      digest.update(JSON.stringify([path, mode, sha256]));
      files++; bytes += readBytes;
      inventory.push({ path, kind: 'file', mode, size: readBytes, sha256, dev: String(st.dev),
        ino: String(st.ino), mtimeNs: String(st.mtimeNs), ctimeNs: String(st.ctimeNs) });
    }
    stable(before, lstatSync(dir, { bigint: true }));
    withinBudget();
  }
  walk(root);
  return { root, files, bytes, objects: inventory.length, sha256: digest.digest('hex'),
    elapsedMs: Date.now() - started, inventory, readAdvice,
    advicePlatform: process.platform === 'linux' ? 'linux-same-open-description' : 'not-applicable' };
}
