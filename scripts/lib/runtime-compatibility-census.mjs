/** Bun migration discovery, reusing the release import collector; never a readiness verdict. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { collectImports } = require('../../papercusp-desktop/bin/lib/runtime-import-census.cjs');
const ts = require('typescript');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SOURCE = /\.(?:[cm]?[jt]sx?|json|sh|bash|ps1|rs|toml|lock|sql|ya?ml|service)$/;
const JS = /\.[cm]?[jt]sx?$/;
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
    maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, ...options });
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
    const candidates = entries.filter((entry) => entry.type === 'blob' && SOURCE.test(entry.path));
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
      const signals = candidates.filter((item) => matcher.test(item.value));
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('usage: runtime-compatibility-census.mjs <repository> [revision]');
  process.stdout.write(JSON.stringify(inventorySources(readCommittedSources(process.argv[2], process.argv[3] ?? 'HEAD'))) + '\n');
}
