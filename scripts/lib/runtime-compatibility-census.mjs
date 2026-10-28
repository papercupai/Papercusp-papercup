/** Bun migration discovery, reusing the release import collector; never a readiness verdict. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { collectImports } = require('../../papercusp-desktop/bin/lib/runtime-import-census.cjs');
const ts = require('typescript');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SOURCE = /\.(?:[cm]?[jt]sx?|json|sh|bash|ps1|py|cmd|bat|desktop|plist|nsh|wxs|gyp|gypi|rs|toml|lock|sql|ya?ml|service)$/;
const CONTROL_FILE = /(?:^|\/)(?:Dockerfile(?:[.-][^/]*)?|[^/]+\.Dockerfile|CMakeLists\.txt)$/;
// Unit drop-ins override the base service's ExecStart and environment. Select
// whole launch-control directories so timer/socket units and unfamiliar drop-in
// suffixes cannot disappear merely because they are not JavaScript or .service.
const CONTROL_DIRECTORY = /(?:^|\/)(?:systemd|launchd|init\.d|rc\.d)\//;
const JS = /\.[cm]?[jt]sx?$/;
const SYSTEMD_UNIT = /\.(?:service|socket|timer|path|target|slice|scope)(?:\.(?:in|tmpl|template))?$/;
export const INVENTORY_GROUPS = ['launchers', 'guards', 'capabilities', 'platforms', 'proofs', 'mutators', 'persistence'];
const MATCHERS = {
  launchers: /child_process|worker_threads|^(?:spawn|spawnSync|execFile|execFileSync|fork|execPath|Worker|cluster|ExecStart|Command)$/,
  guards: /committed-source|bundle-host|immutable-artifact|artifact.*(?:digest|hash)|source.*guard/i,
  capabilities: /\.node$|sqlite|sodium|udx|rocksdb|onnx|sharp|node-pty|node:|^pg$/i,
  platforms: /(?:linux|darwin|macos|windows).*(?:arm64|aarch64|x64|x86_64|universal)|(?:arm64|aarch64|x64|x86_64).*(?:linux|darwin|windows)/i,
  proofs: /proof|test_runs|test_case_runs|fingerprint|dependency.generation|runtime.generation|cache/i,
  mutators: /lease|fenc|idempoten|scheduler|routine|outbox|queue/i,
  persistence: /postgres|sqlite|rocksdb|hypercore|writeFile|appendFile|persist|schema|migration/i,
};

function git(root, args, options = {}) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, ...options, timeout: 120_000 });
}

/** Exact blobs and pinned gitlinks, with unavailable checkouts explicitly retained. */
export function readCommittedSources(root, revision = 'HEAD', { runGit = git } = {}) {
  const sources = [], repositories = [], unresolved = [];
  const visit = (checkout, rev, prefix) => {
    let commit, entries;
    try {
      if (realpathSync(runGit(checkout, ['rev-parse', '--show-toplevel']).trim()) !== realpathSync(checkout)) {
        throw new Error('Requested repository is not an initialized checkout');
      }
      commit = runGit(checkout, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).trim();
      entries = runGit(checkout, ['ls-tree', '-rlz', '--full-tree', commit]).split('\0').filter(Boolean).map((line) => {
        const tab = line.indexOf('\t'); const [mode, type, oid, size] = line.slice(0, tab).trim().split(/\s+/);
        return { mode, type, oid, size: Number(size), path: line.slice(tab + 1) };
      });
    } catch (error) {
      unresolved.push({ repository: prefix || '.', revision: rev, reason: 'pinned-repository-unavailable', error: error.message });
      return;
    }
    repositories.push({ path: prefix || '.', commit });
    // Installed commands often have no extension. The executable mode is part
    // of the committed tree, so include it without inspecting mutable disk bytes.
    const candidates = entries.filter((entry) => entry.type === 'blob'
      && (entry.mode === '100755' || entry.mode === '120000' || SOURCE.test(entry.path)
        || CONTROL_FILE.test(entry.path) || CONTROL_DIRECTORY.test(entry.path)));
    const selected = candidates.filter((entry) => /^(?:100644|100755)$/.test(entry.mode)
      && Number.isSafeInteger(entry.size) && entry.size <= 2 * 1024 * 1024);
    for (const entry of candidates.filter((entry) => !selected.includes(entry))) {
      unresolved.push({ path: prefix ? `${prefix}/${entry.path}` : entry.path,
        commit, blobOid: entry.oid, reason: 'nonregular-or-over-budget-source' });
    }
    // Each blob is bounded above; sixteen blobs keep the actual batch below
    // 32MiB rather than buffering the entire repository in a single child call.
    for (let start = 0; start < selected.length; start += 16) {
      const chunk = selected.slice(start, start + 16);
      const batch = runGit(checkout, ['cat-file', '--batch'], { encoding: null,
        input: Buffer.from(chunk.map((entry) => entry.oid).join('\n') + '\n') });
      let offset = 0;
      for (const entry of chunk) {
        const end = batch.indexOf(10, offset);
        const [oid, type, size] = batch.subarray(offset, end).toString().split(' '); const length = Number(size);
        if (end < 0 || oid !== entry.oid || type !== 'blob' || !Number.isSafeInteger(length) || length < 0
            || end + 1 + length >= batch.length || batch[end + 1 + length] !== 10) throw new Error('Git object stream mismatch');
        const bytes = batch.subarray(end + 1, end + 1 + length); offset = end + 2 + length;
        sources.push({ path: prefix ? `${prefix}/${entry.path}` : entry.path,
          repository: prefix || '.', commit, blobOid: oid, bytes });
      }
      if (offset !== batch.length) throw new Error('Unexpected trailing Git object bytes');
    }
    for (const entry of entries.filter((entry) => entry.type === 'commit')) {
      visit(resolve(checkout, entry.path), entry.oid, prefix ? `${prefix}/${entry.path}` : entry.path);
    }
  };
  visit(resolve(root), revision, '');
  return { sources, repositories, unresolved };
}

function syntaxTokens(text, file) {
  // A standalone scanner cannot rescan template tails/regex/JSX context. Walk
  // the parsed tree so an interpolated template cannot consume later imports.
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.getScriptKindFromFileName(file));
  const result = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      result.push({ value: node.text, offset: node.getStart(tree) });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return result;
}

/**
 * Preserve unit assignments for launch review, including empty list resets.
 * This is source evidence, not an effective-unit evaluator: installation paths,
 * prefix drop-ins, environment files and manager expansion still need proof.
 */
export function collectSystemdDirectives(path, text) {
  if (!SYSTEMD_UNIT.test(path) && !(CONTROL_DIRECTORY.test(path) && path.endsWith('.conf'))) return null;
  const directives = [], unresolved = [];
  let section = null, pending = null;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], trimmed = line.trim();
    // systemd ignores comment lines even inside a continued assignment.
    if (!trimmed || /^[#;]/.test(trimmed)) continue;
    const firstLine = pending?.firstLine ?? index + 1;
    const joined = (pending?.text ?? '') + line;
    const trailing = joined.match(/\\+$/)?.[0].length ?? 0;
    if (trailing % 2 === 1) {
      pending = { firstLine, text: joined.slice(0, -1) + ' ' };
      continue;
    }
    pending = null;
    const statement = joined.trim(), heading = statement.match(/^\[([^\]]+)\]$/);
    if (heading) { section = heading[1]; continue; }
    const assignment = statement.match(/^([A-Za-z][A-Za-z0-9]*)\s*=(.*)$/);
    if (!assignment || !section) {
      unresolved.push({ firstLine, lastLine: index + 1, reason: 'unparsed-systemd-statement', text: joined });
      continue;
    }
    directives.push({ section, key: assignment[1], value: assignment[2].trim(), firstLine, lastLine: index + 1 });
  }
  if (pending) unresolved.push({ firstLine: pending.firstLine, lastLine: lines.length,
    reason: 'unterminated-systemd-continuation', text: pending.text });
  return { format: 'systemd', directives, unresolved, effectiveConfigurationVerified: false };
}

/** Candidate leads require explicit reachability classification before the population is frozen. */
export function inventorySources(snapshot) {
  const groups = Object.fromEntries(INVENTORY_GROUPS.map((name) => [name, []]));
  const files = [], unresolved = [...(snapshot.unresolved ?? [])];
  for (const source of [...snapshot.sources].sort((a, b) => a.path.localeCompare(b.path))) {
    const text = source.bytes.toString('utf8'), sourceSha256 = hash(source.bytes);
    const file = { path: source.path, repository: source.repository, commit: source.commit, blobOid: source.blobOid, sourceSha256,
      sourceKind: /(?:^|\/)(?:test|tests|__tests__|fixtures)\/|\.(?:test|spec)\./.test(source.path) ? 'test-or-fixture' : 'source', imports: [] };
    files.push(file);
    if (!Buffer.from(text).equals(source.bytes) || source.bytes.length > 2 * 1024 * 1024) {
      unresolved.push({ path: source.path, reason: 'non-utf8-or-over-parser-budget' }); continue;
    }
    const launchControl = collectSystemdDirectives(source.path, text);
    if (launchControl) {
      file.launchControl = launchControl;
      unresolved.push(...launchControl.unresolved.map((row) => ({ path: source.path, ...row })));
    }
    if (JS.test(source.path)) {
      try {
        file.imports = collectImports(source.path, source.bytes).imports;
        for (const site of file.imports.filter((site) => !site.typeOnly && (site.specifier === null || site.kind === 'generated-code'))) {
          unresolved.push({ path: source.path, reason: 'dynamic-or-generated-module', byteStart: site.byteStart });
        }
      } catch (error) { unresolved.push({ path: source.path, reason: 'parser-failed', error: error.message }); }
    }
    const parsed = JS.test(source.path);
    const candidates = parsed ? syntaxTokens(text, source.path) : text.split('\n').map((value, index) => ({ value, line: index + 1 }));
    for (const [group, matcher] of Object.entries(MATCHERS)) {
      const signals = candidates.filter((item) => matcher.test(item.value)
        || (group === 'launchers' && !parsed
          && /\b(?:exec|spawn|node|bun|tsx|npx|npm|python[23]?|ExecStart(?:Pre|Post)?|ENTRYPOINT|CMD|Command)\b/.test(item.value)));
      // Every value import is a capability discovery lead, including packages
      // with no native name. Native addon seeds never establish completeness.
      if (group === 'capabilities') signals.push(...file.imports.filter((site) => !site.typeOnly).map((site) => ({ specifier: site.specifier, byteStart: site.byteStart })));
      if (signals.length) groups[group].push({ id: source.path, sourceSha256, classification: 'unreviewed',
        evidenceKind: parsed ? 'syntax-candidate' : 'line-candidate', signals });
    }
  }
  return { schema: 'papercusp-runtime-migration-inventory-v1', repositories: snapshot.repositories,
    sourceFingerprint: hash(JSON.stringify({ repositories: snapshot.repositories, unresolved,
      files: files.map((file) => [file.path, file.commit, file.sourceSha256]) })),
    files, groups, unresolved, closureAccepted: false,
    limitations: ['Discovery only: classify required/unreachable/external using source reachability proof.',
      'Token and shell/config line candidates do not establish behavior or a complete platform matrix.',
      'Freeze product/OS/arch cells from release producers; unavailable capacity never removes a supported cell.'] };
}

/** Read static ELF metadata without loading the candidate into this process. */
export function parseElfDependencies(text) {
  const elfClass = text.match(/^\s*Class:\s*(\S+)/m)?.[1];
  const machine = text.match(/^\s*Machine:\s*(.+)/m)?.[1]?.trim();
  if (!elfClass || !machine) throw new Error('Incomplete ELF header');
  const values = (tag) => [...text.matchAll(new RegExp(`\\(${tag}\\).*?\\[([^\\]]+)\\]`, 'g'))].map((match) => match[1]);
  return { elfClass, machine, needed: values('NEEDED'), rpath: values('RPATH'), runpath: values('RUNPATH'), soname: values('SONAME') };
}

const NATIVE_NAME = /(?:\.node|\.dll|\.dylib|\.wasm|\.so(?:\.[\w.-]+)?)$/i;
function binaryFormat(bytes) {
  const magic = bytes.subarray(0, 4).toString('hex');
  if (magic === '7f454c46') return 'elf';
  if (magic === '0061736d') return 'wasm';
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return 'pe';
  if (['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic)) return 'mach-o-candidate';
  return null;
}
const sameFile = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => a[key] === b[key]);
const inspectElf = (path) => execFileSync('readelf', ['--file-header', '--dynamic', '--wide', '--', path],
  { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });

/**
 * Join existing byte/ELF evidence to package declarations and caller edges.
 * Target names are selection hints, not binary validation or reachability proof.
 * In particular, a foreign prebuild or optional provider is never discarded.
 */
export function classifyNativeInventory(inventory, elfInventory, { packages, platformCells, host }) {
  if (!Array.isArray(packages) || new Set(packages.map((pkg) => pkg.key)).size !== packages.length
      || !Array.isArray(platformCells) || !host?.os || !host?.arch) throw new Error('Unique package contexts, platform cells and host target required');
  const contexts = new Map(packages.map((pkg) => [pkg.key, pkg]));
  const callers = new Map();
  for (const pkg of packages) for (const edge of pkg.edges ?? []) {
    if (!edge.to) continue;
    if (!callers.has(edge.to)) callers.set(edge.to, []);
    callers.get(edge.to).push({ from: pkg.key, field: edge.field, optional: edge.optional === true });
  }
  const osAliases = { windows: 'win32', macos: 'darwin' };
  const archAliases = { aarch64: 'arm64', x86_64: 'x64', x86: 'ia32' };
  const hints = (text, pattern, aliases) => [...text.matchAll(pattern)].map((match) => aliases[match[1]] ?? match[1]);
  const unique = (values) => [...new Set(values)];
  const single = (values) => values.length === 1 ? values[0] : null;
  const osPattern = /(?:^|[\/_.-])(android|linux|darwin|win32|windows|macos|ios)(?=$|[\/_.-])/g;
  const archPattern = /(?:^|[\/_.-])(x86_64|aarch64|arm64|x64|ia32|x86|arm|universal)(?=$|[\/_.-])/g;
  const machineArch = { 'Advanced Micro Devices X86-64': 'x64', AArch64: 'arm64', ARM: 'arm', 'Intel 80386': 'ia32' };
  const rows = inventory.files.map((file) => {
    const pkg = contexts.get(file.packageId), lock = pkg?.lock ?? {};
    const osHints = unique(hints(file.path, osPattern, osAliases));
    const archHints = unique(hints(file.path, archPattern, archAliases));
    const declaredOs = Array.isArray(lock.os) ? lock.os : [];
    const declaredArch = Array.isArray(lock.cpu) ? lock.cpu : [];
    const name = file.packageId.split('node_modules/').at(-1);
    const os = single(osHints) ?? single(declaredOs.filter((value) => !value.startsWith('!')))
      ?? single(unique(hints(name, osPattern, osAliases)));
    const binaryArch = machineArch[file.elf?.machine] ?? null;
    const arch = binaryArch ?? single(archHints) ?? single(declaredArch.filter((value) => !value.startsWith('!')))
      ?? single(unique(hints(name, archPattern, archAliases)));
    const text = `${file.path}/${name}`;
    const libcHints = unique([...(lock.libc ?? []),
      ...(/(?:^|[\/_.-])musl(?:$|[\/_.-])/.test(text) || file.elf?.needed.some((value) => value.includes('musl')) ? ['musl'] : []),
      ...(/(?:^|[\/_.-])gnu(?:$|[\/_.-])/.test(text) || file.elf?.needed.includes('libc.so.6') ? ['glibc'] : []),
      ...(os === 'android' ? ['bionic'] : [])]);
    const libc = single(libcHints);
    const conflicts = [];
    if (osHints.length > 1 || archHints.length > 1 || libcHints.length > 1) conflicts.push('conflicting-target-hints');
    if (binaryArch && archHints.length && !archHints.includes(binaryArch)) conflicts.push('path-elf-architecture-mismatch');
    const allows = (values, value) => !values.includes(`!${value}`)
      && (!values.some((entry) => !entry.startsWith('!')) || values.includes(value));
    if (os && !allows(declaredOs, os)) conflicts.push('package-os-mismatch');
    if (arch && !allows(declaredArch, arch)) conflicts.push('package-cpu-mismatch');
    if (file.format === 'pe' && os && os !== 'win32') conflicts.push('format-os-mismatch');
    if (file.format === 'elf' && ['darwin', 'win32', 'ios'].includes(os)) conflicts.push('format-os-mismatch');
    if (file.format === 'mach-o-candidate' && os && !['darwin', 'ios'].includes(os)) conflicts.push('format-os-mismatch');
    const portable = file.format === 'wasm';
    const candidateCells = platformCells.filter((cell) => portable || (os === (osAliases[cell.os] ?? cell.os)
      && (arch === cell.arch || arch === 'universal'))).map((cell) => cell.id);
    const hostRelation = conflicts.length ? 'conflicting-evidence' : portable ? 'portable-wasm-candidate'
      : os && os !== host.os ? 'different-os' : arch && arch !== host.arch && arch !== 'universal' ? 'different-arch'
        : os === host.os && arch === host.arch ? (libc && host.libc && libc !== host.libc ? 'different-libc' : 'same-os-arch') : 'unknown';
    const operationalRole = file.path.endsWith('.bare') ? 'bare-addon-candidate'
      : file.path.endsWith('.node') ? 'node-addon-candidate' : portable ? 'wasm-candidate'
        : /\.(?:dll|dylib|so(?:\.[\w.-]+)?)$/.test(file.path) ? 'shared-library-candidate' : 'executable-candidate';
    return { packageId: file.packageId, path: file.path, realPath: file.realPath, sha256: file.sha256,
      target: { os, arch, libc, osHints, archHints, declaredOs, declaredArch, binaryArch, conflicts },
      candidateCells, hostRelation, operationalRole, packageContextAvailable: !!pkg,
      selectorVerified: false, runtimeAcceptance: 'not-measured' };
  });
  const byPath = new Map(rows.map((row) => [row.realPath, row]));
  const gaps = [...inventory.unresolved.map((gap) => ({ ...gap, evidencePlane: 'package-bytes',
    file: rows.find((row) => row.packageId === gap.packageId && row.path === gap.path) ?? null })),
  ...(elfInventory?.unresolved ?? []).map((gap) => ({ ...gap, evidencePlane: 'elf-candidates', file: byPath.get(gap.path) ?? null }))];
  const result = { schema: 'papercusp-native-target-review-v1', inputFingerprints: {
    native: inventory.fingerprint, elf: elfInventory?.fingerprint ?? null }, host, platformCells,
  packages: inventory.roots.map((root) => ({ id: root.id, manifestSha256: root.manifestSha256 ?? null,
    contextAvailable: contexts.has(root.id), declaration: contexts.get(root.id)?.lock ?? null,
    callerEdges: callers.get(root.id) ?? [], seedEvidence: contexts.get(root.id)?.seedEvidence ?? [] })),
  rows, gaps, closureAccepted: false, actualLoaderResolutionVerified: false,
  limitations: ['Package/path target hints and static ELF metadata do not prove a loader selector or operational reachability.',
    'Caller edges preserve optionality; missing packages and foreign targets remain obligations, not runtime failures or exclusions.',
    'Platform candidate cells are discovery mappings only; no cell receives acceptance from this review.'] };
  return { ...result, fingerprint: hash(JSON.stringify(result)) };
}

/**
 * Fingerprint the installed bytes under an explicit, reviewed package population.
 * Nested node_modules must be supplied as their own package roots. Symlinks that
 * escape a package stay gaps; a package walk cannot certify the system loader's
 * resolution, foreign platforms, generated code, or runtime capability behavior.
 */
export async function inventoryNativePackages(packages, { maxEntries = 500_000,
  readelf = inspectElf } = {}) {
  if (!Array.isArray(packages) || packages.some((pkg) => !pkg.id || !isAbsolute(pkg.path))
      || new Set(packages.map((pkg) => pkg.id)).size !== packages.length) throw new Error('Unique package IDs and absolute paths required');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('Positive entry budget required');
  const roots = [], files = [], links = [], excluded = [], unresolved = [];
  let entriesRead = 0;
  for (const pkg of [...packages].sort((a, b) => a.id.localeCompare(b.id))) {
    const root = { id: pkg.id, path: pkg.path }; roots.push(root);
    const gap = (path, reason, error) => unresolved.push({ packageId: pkg.id, path, reason, ...(error ? { error: error.code ?? error.message } : {}) });
    try {
      root.realPath = await fs.realpath(pkg.path);
      root.manifestSha256 = hash(await fs.readFile(join(root.realPath, 'package.json')));
      if (!/^[a-f0-9]{64}$/.test(pkg.manifestSha256 ?? '') || root.manifestSha256 !== pkg.manifestSha256) {
        gap('package.json', 'manifest-pin-mismatch'); continue;
      }
    } catch (error) { gap('package.json', 'package-unavailable', error); continue; }
    const seen = new Set();
    const walk = async (path) => {
      const rel = relative(root.realPath, path);
      try {
        const resolved = await fs.realpath(path), target = relative(root.realPath, resolved);
        if (target === '..' || target.startsWith(`..${sep}`) || isAbsolute(target)) {
          links.push({ packageId: pkg.id, path: rel, target: resolved }); gap(rel, 'external-symlink'); return;
        }
        const stat = await fs.stat(resolved);
        if ((await fs.lstat(path)).isSymbolicLink()) links.push({ packageId: pkg.id, path: rel, target });
        if (stat.isDirectory()) {
          if (seen.has(resolved)) return;
          seen.add(resolved);
          for (const child of (await fs.readdir(resolved)).sort()) {
            if (child === 'node_modules') { excluded.push({ packageId: pkg.id, path: relative(root.realPath, join(resolved, child)), reason: 'separate-package-roots-required' }); continue; }
            if (entriesRead >= maxEntries) { gap(rel, 'entry-budget'); return; }
            entriesRead++;
            await walk(join(resolved, child));
          }
          return;
        }
        if (!stat.isFile()) { gap(rel, 'nonregular-file'); return; }
        const handle = await fs.open(resolved, 'r');
        const header = Buffer.alloc(8);
        try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
        const format = binaryFormat(header);
        if (!format && !NATIVE_NAME.test(rel)) return;
        const digest = createHash('sha256');
        for await (const chunk of createReadStream(resolved)) digest.update(chunk);
        const row = { packageId: pkg.id, path: rel, realPath: resolved, bytes: stat.size, sha256: digest.digest('hex'), format: format ?? 'unknown' };
        files.push(row);
        if (!sameFile(stat, await fs.stat(resolved)) || await fs.realpath(path) !== resolved) { gap(rel, 'file-changed-during-read'); return; }
        if (format === 'elf') {
          try { row.elf = parseElfDependencies(await readelf(resolved)); }
          catch (error) { gap(rel, 'elf-inspection-failed', error); }
          if (!sameFile(stat, await fs.stat(resolved))) gap(rel, 'file-changed-during-inspection');
        } else if (format !== 'wasm') gap(rel, format ? 'platform-inspection-unavailable' : 'unrecognized-native-file');
      } catch (error) { gap(rel, 'file-unavailable', error); }
    };
    await walk(root.realPath);
    try {
      if (hash(await fs.readFile(join(root.realPath, 'package.json'))) !== root.manifestSha256) gap('package.json', 'manifest-changed-during-walk');
    } catch (error) { gap('package.json', 'manifest-unavailable-after-walk', error); }
  }
  const result = { schema: 'papercusp-native-package-inventory-v1', roots, files, links, excluded, unresolved, entriesRead,
    closureAccepted: false, limitations: ['Static package byte discovery only; not a runtime or supported-platform acceptance verdict.',
      'DT_NEEDED names and search paths do not prove actual system-library resolution or dynamically opened libraries.',
      'Nested node_modules are excluded and require explicit package roots; generated and external files require separate evidence.'] };
  return { ...result, fingerprint: hash(JSON.stringify(result)) };
}

/**
 * Follow static DT_NEEDED candidates without executing or loading their bytes.
 * Cache entries and environment directories are explicit, fingerprinted inputs.
 * This deliberately does not choose a loader winner: inherited RPATH, hwcaps,
 * namespaces, preloads and dlopen require separate runtime evidence.
 */
export async function inventoryElfLibraryCandidates(files, { libraryCache = [], environmentDirectories = [],
  maxLibraries = 4096, readelf = inspectElf } = {}) {
  if (!Array.isArray(files) || files.some((file) => !isAbsolute(file.realPath ?? '') || !/^[a-f0-9]{64}$/.test(file.sha256 ?? ''))
      || !Array.isArray(libraryCache) || libraryCache.some((row) => !row.name || !isAbsolute(row.path ?? ''))
      || !Array.isArray(environmentDirectories) || environmentDirectories.some((path) => !isAbsolute(path))
      || !Number.isSafeInteger(maxLibraries) || maxLibraries < 1) throw new Error('Pinned files, absolute library inputs and positive budget required');
  const libraries = [], edges = [], unresolved = [], inspected = new Map(), pending = [], traversed = new Set();
  const gap = (path, reason, extra = {}) => unresolved.push({ path, reason, ...extra });
  const inspect = async (path) => {
    let realPath;
    try { realPath = await fs.realpath(path); }
    catch (error) { gap(path, 'library-unavailable', { error: error.code ?? error.message }); return null; }
    if (inspected.has(realPath)) return inspected.get(realPath);
    inspected.set(realPath, null);
    if (inspected.size > maxLibraries) { gap(path, 'library-budget'); return null; }
    try {
      const before = await fs.stat(realPath);
      if (!before.isFile()) throw new Error('Not a regular library');
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(realPath)) digest.update(chunk);
      const elf = parseElfDependencies(await readelf(realPath));
      if (!sameFile(before, await fs.stat(realPath)) || await fs.realpath(path) !== realPath) {
        gap(path, 'library-changed-during-inspection'); return null;
      }
      const row = { realPath, bytes: before.size, sha256: digest.digest('hex'), elf };
      libraries.push(row); inspected.set(realPath, row); return row;
    } catch (error) { gap(path, 'library-inspection-failed', { error: error.code ?? error.message }); return null; }
  };
  for (const file of files) {
    const row = await inspect(file.realPath);
    if (row && row.sha256 !== file.sha256) gap(file.realPath, 'source-pin-mismatch');
    else if (row) pending.push(row);
  }
  for (let index = 0; index < pending.length; index++) {
    const source = pending[index];
    if (traversed.has(source.realPath)) continue;
    traversed.add(source.realPath);
    const directories = [...environmentDirectories];
    for (const value of [...source.elf.rpath, ...source.elf.runpath].flatMap((value) => value.split(':'))) {
      const path = value.replace(/\$\{ORIGIN\}|\$ORIGIN\b/g, () => dirname(source.realPath));
      if (!path || path.includes('$') || !isAbsolute(path)) gap(source.realPath, 'unsupported-library-search-path', { value });
      else directories.push(path);
    }
    for (const name of source.elf.needed) {
      const edge = { from: source.realPath, name, candidates: [], incompatible: [], searched: [] };
      edges.push(edge);
      if (name.includes('/') && !isAbsolute(name)) { gap(source.realPath, 'relative-needed-path', { name }); continue; }
      const paths = isAbsolute(name) ? [name] : [...directories.map((directory) => join(directory, name)),
        ...libraryCache.filter((row) => row.name === name).map((row) => row.path)];
      for (const path of [...new Set(paths)]) {
        edge.searched.push(path);
        try { await fs.lstat(path); }
        catch (error) { if (error.code !== 'ENOENT') gap(path, 'library-search-failed', { error: error.code ?? error.message }); continue; }
        const target = await inspect(path);
        if (!target) continue;
        if (target.elf.elfClass !== source.elf.elfClass || target.elf.machine !== source.elf.machine) {
          edge.incompatible.push(target.realPath); continue;
        }
        if (!edge.candidates.includes(target.realPath)) edge.candidates.push(target.realPath);
        pending.push(target);
      }
      if (!edge.candidates.length) gap(source.realPath, 'needed-library-unresolved', { name });
      else if (edge.candidates.length > 1) gap(source.realPath, 'ambiguous-library-candidates', { name });
    }
  }
  const result = { schema: 'papercusp-elf-library-candidates-v1', inputs: { files, libraryCache, environmentDirectories, maxLibraries },
    libraries, edges, unresolved, closureAccepted: false, actualLoaderResolutionVerified: false,
    limitations: ['Static matching candidates only; search order and the actual loaded library are not verified.',
      'Inherited search paths, default directories absent from supplied cache, hwcaps, namespaces, preloads and dlopen remain separate obligations.',
      'Current host evidence does not establish foreign-platform or immutable release-candidate acceptance.'] };
  return { ...result, fingerprint: hash(JSON.stringify(result)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('usage: runtime-compatibility-census.mjs <repository> [revision]');
  process.stdout.write(JSON.stringify(inventorySources(readCommittedSources(process.argv[2], process.argv[3] ?? 'HEAD'))) + '\n');
}
