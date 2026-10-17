/** Local data-flow evidence from an admitted maintained analyzer, separate from call topology. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import pinnedManifest from './semgrep-runtime-manifest.json';

let executeMemo: typeof execFile.__promisify__ | null = null;
const execute = ((...args: unknown[]) =>
  Reflect.apply((executeMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;
export const SEMGREP_VERSION = '1.180.0';
export const SEMGREP_CORE_SHA256 = 'cd95f3b3838b4830b387af722f9d65831854a415cfee124a8841158a5eb12ff2';
export const SEMGREP_WHEEL_SHA256 = '16db2e2706ab814a975eeec25debfad49abba846b7c513d88e041447152f8447';
const LICENSE_SHA256 = '20c17d8b8c48a600800dfd14f95d5cb9ff47066a9641ddeab48dc54aec96e331';
const CORE_PATH = 'semgrep-1.180.0.data/purelib/semgrep/bin/semgrep-core';
export const SEMGREP_RUNTIME_MANIFEST = pinnedManifest;
export const SEMGREP_VENDOR_DIR = join(homedir(), '.papercusp', 'vendor', 'semgrep', SEMGREP_VERSION);
const LANGUAGES: Record<string, { analyzer: string; extensions: string[] }> = {
  ts: { analyzer: 'typescript', extensions: ['.ts'] }, js: { analyzer: 'javascript', extensions: ['.js'] },
  python: { analyzer: 'python', extensions: ['.py'] }, go: { analyzer: 'go', extensions: ['.go'] },
  rust: { analyzer: 'rust', extensions: ['.rs'] },
};
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const LIMITATIONS = [
  'Findings are inferred local static data-flow under caller-declared source, sink and sanitizer patterns.',
  'Runtime execution, inter-file flow, callback targets, reflection and generated consumers remain unknown.',
  'An empty finding set is not proof of safety or repository completeness; this is not a vulnerability verdict.',
];
export interface TaintPatterns { sources: string[]; sinks: string[]; sanitizers?: string[] }
export interface TaintAnswer {
  schemaVersion: 1;
  analysisKind: 'local-taint';
  backend: 'semgrep-oss';
  findings: Array<{ path: string; line1: number; ruleId: string; knowledge: 'inferred'; runtimeExecution: 'unknown' }>;
  sources: Array<{ path: string; contentHash: string; language: string }>;
  analyzer: { version: string; binarySha256: string; manifestSha256: string; license: string } | null;
  ruleSha256: string | null;
  scanCoverage: { requested: number; scanned: number; complete: boolean };
  freshness: { health: 'healthy' | 'unknown'; staleVsDisk: boolean | null };
  truncation: { truncated: boolean; totalAvailable: number };
  sourceCompleteness: 'unverified';
  dynamicBoundary: 'unknown';
  limitations: string[];
  error: string | null;
}

/** The installed manifest is a receipt, not an authority for substituting libraries. */
export function assertSemgrepManifest(manifest: typeof pinnedManifest): void {
  for (const key of ['schemaVersion', 'name', 'version', 'wheelSha256', 'corePath', 'coreSha256',
    'sourceCommit', 'license', 'licenseSha256', 'localEvaluationAdmission', 'distributionAdmission'] as const) {
    if (manifest?.[key] !== pinnedManifest[key]) throw new Error('semgrep_runtime_not_admitted: ' + key);
  }
  const entries = Object.entries(manifest.libraryFiles ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const expected = Object.entries(pinnedManifest.libraryFiles).sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(entries) !== JSON.stringify(expected)) throw new Error('semgrep_runtime_library_closure_mismatch');
}

/** Check the complete pinned library closure, not just a PATH name or version exit code. */
export async function semgrepIdentity(vendor = SEMGREP_VENDOR_DIR) {
  const root = await fs.realpath(vendor);
  const bytes = await fs.readFile(join(root, 'manifest.json'));
  const manifest = JSON.parse(bytes.toString());
  assertSemgrepManifest(manifest);
  const measured = async (path: string, expected: string) => {
    const absolute = await fs.realpath(resolve(root, path));
    const rel = relative(root, absolute);
    if (isAbsolute(path) || rel === '..' || rel.startsWith('../') || !/^[a-f0-9]{64}$/.test(expected) ||
        hash(await fs.readFile(absolute)) !== expected) throw new Error('semgrep_runtime_identity_mismatch: ' + path);
    return absolute;
  };
  const bin = await measured(CORE_PATH, SEMGREP_CORE_SHA256);
  await measured('LICENSE', LICENSE_SHA256);
  const libraries = pinnedManifest.libraryFiles;
  const installedNames = (await fs.readdir(join(root, dirname(Object.keys(libraries)[0])))).sort();
  if (JSON.stringify(installedNames) !== JSON.stringify(Object.keys(libraries).map(path => basename(path)).sort())) {
    throw new Error('semgrep_runtime_library_closure_mismatch: unexpected or missing packaged library');
  }
  for (const [path, expected] of Object.entries(libraries)) await measured(path, String(expected));
  const version = await execute(bin, ['-version'], { timeout: 10_000, maxBuffer: 4096 });
  if (!/^semgrep-core version: 1\.180\.0(?:\s|$)/.test(version.stdout.trim())) throw new Error('semgrep_runtime_version_mismatch');
  return { bin, version: SEMGREP_VERSION, binarySha256: SEMGREP_CORE_SHA256,
    manifestSha256: hash(bytes), license: 'LGPL-2.1-or-later' };
}

/** Reuse the provisioning command; download upstream bytes, never ship a vendor binary in the tree. */
export async function provisionSemgrepRuntime(vendor = SEMGREP_VENDOR_DIR) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('semgrep_runtime_platform_unsupported: Linux x86_64 required');
  try {
    await fs.lstat(vendor);
    // Refuse to overwrite an existing unrecognized installation.
    return { ...(await semgrepIdentity(vendor)), reused: true, distributionAdmission: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // ENOENT inside an existing installation is also a refusal, not replacement authority.
    try { await fs.lstat(vendor); throw new Error('semgrep_runtime_existing_incomplete: inspect before replacement'); }
    catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing; }
  }
  const parent = dirname(vendor);
  await fs.mkdir(parent, { recursive: true });
  const scratch = await fs.mkdtemp(join(parent, '.semgrep-admission-'));
  try {
    const download = async (url: string, expected: string, maxBytes: number) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error('semgrep_download_failed: ' + response.status);
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of response.body!) {
        total += chunk.length;
        if (total > maxBytes) throw new Error('semgrep_download_budget_exceeded');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (hash(bytes) !== expected) throw new Error('semgrep_download_identity_mismatch');
      return bytes;
    };
    const wheel = await download(pinnedManifest.wheelUrl, SEMGREP_WHEEL_SHA256, 80 * 1024 * 1024);
    const { default: Zip } = await import('adm-zip');
    const archive = new Zip(wheel);
    for (const [path, expected] of Object.entries({ [CORE_PATH]: SEMGREP_CORE_SHA256, ...pinnedManifest.libraryFiles })) {
      const member = archive.getEntry(path);
      if (!member || archive.getEntries().filter(entry => entry.entryName === path).length !== 1) {
        throw new Error('semgrep_archive_member_missing_or_duplicate: ' + path);
      }
      const bytes = member.getData();
      if (hash(bytes) !== expected) throw new Error('semgrep_archive_member_identity_mismatch: ' + path);
      await fs.mkdir(dirname(join(scratch, path)), { recursive: true });
      await fs.writeFile(join(scratch, path), bytes, { mode: path === CORE_PATH ? 0o755 : 0o644 });
    }
    await fs.writeFile(join(scratch, 'LICENSE'), await download(pinnedManifest.licenseUrl, LICENSE_SHA256, 64 * 1024));
    await fs.writeFile(join(scratch, 'manifest.json'), JSON.stringify(pinnedManifest, null, 2) + '\n');
    await semgrepIdentity(scratch);
    // Claim the destination without replacing even a concurrent installation.
    await fs.mkdir(vendor);
    try {
      for (const name of await fs.readdir(scratch)) await fs.rename(join(scratch, name), join(vendor, name));
    } catch (error) {
      throw new Error('semgrep_provision_incomplete: inspect ' + vendor, { cause: error });
    }
    return { ...(await semgrepIdentity(vendor)), reused: false, distributionAdmission: false };
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

/** A parser/timeout/error must never be reported as a clean empty static result. */
export function decodeTaintOutput(stdout: string, captured: Map<string, string>): TaintAnswer['findings'] {
  const output = JSON.parse(stdout);
  if (!Array.isArray(output.results) || !Array.isArray(output.errors) || output.errors.length) {
    throw new Error('semgrep_analysis_incomplete: ' + JSON.stringify(output.errors ?? 'malformed result').slice(0, 500));
  }
  const scanned = output.paths?.scanned;
  if (output.version !== SEMGREP_VERSION || !Array.isArray(scanned) || scanned.length !== captured.size ||
      new Set(scanned).size !== captured.size || scanned.some((path: unknown) => typeof path !== 'string' || !captured.has(path)) ||
      (output.paths.skipped !== undefined && (!Array.isArray(output.paths.skipped) || output.paths.skipped.length)) ||
      (output.skipped_rules !== undefined && (!Array.isArray(output.skipped_rules) || output.skipped_rules.length))) {
    throw new Error('semgrep_analysis_incomplete: scanned source population, rules or version mismatch');
  }
  return output.results.map((row: { path?: string; check_id?: string; start?: { line?: number } }) => {
    const path = typeof row.path === 'string' ? captured.get(row.path) : undefined;
    if (!path || row.check_id !== 'native-local-taint' || !Number.isInteger(row.start?.line) || row.start!.line! < 1) {
      throw new Error('semgrep_uncited_finding: unknown path, rule or source location');
    }
    return { path, line1: row.start!.line!, ruleId: row.check_id, knowledge: 'inferred', runtimeExecution: 'unknown' };
  });
}

export async function semgrepTaint(args: { language: string; rootPath: string; paths?: string[]; patterns?: TaintPatterns; limit?: number }): Promise<TaintAnswer> {
  const answer: TaintAnswer = { schemaVersion: 1, analysisKind: 'local-taint', backend: 'semgrep-oss', findings: [],
    sources: [], analyzer: null, ruleSha256: null, scanCoverage: { requested: args.paths?.length ?? 0, scanned: 0, complete: false },
    freshness: { health: 'unknown', staleVsDisk: null },
    truncation: { truncated: false, totalAvailable: 0 }, sourceCompleteness: 'unverified', dynamicBoundary: 'unknown',
    limitations: [...LIMITATIONS], error: null };
  let scratch: string | undefined;
  try {
    const language = LANGUAGES[args.language];
    if (!language) throw new Error('unsupported local-taint grammar: ' + args.language);
    if (!args.paths?.length || args.paths.length > 16) throw new Error('local-taint requires 1..16 explicit source files');
    const patterns = args.patterns;
    if (!patterns?.sources?.length || !patterns.sinks?.length) throw new Error('local-taint requires declared source and sink patterns');
    for (const list of [patterns.sources, patterns.sinks, patterns.sanitizers ?? []]) {
      if (list.length > 8 || list.some(pattern => typeof pattern !== 'string' || !pattern.trim() || pattern.length > 2000)) {
        throw new Error('local-taint pattern budget exceeded');
      }
    }
    const root = await fs.realpath(args.rootPath);
    // Capture source bytes before invoking the analyzer; dynamic dependencies are not followed.
    const inputs: Array<{ path: string; absolute: string; bytes: Buffer }> = [];
    for (const requested of [...new Set(args.paths)].sort()) {
      const absolute = await fs.realpath(resolve(root, requested));
      const path = relative(root, absolute).split('\\').join('/');
      if (!path || isAbsolute(path) || path.split('/').includes('..')) throw new Error('local-taint input outside source scope');
      if (path.split('/').some(part => ['node_modules', 'vendor', 'dist', 'build', 'target', 'coverage', '.git'].includes(part))) {
        throw new Error('local-taint generated/vendor source excluded');
      }
      const stat = await fs.stat(absolute);
      if (!stat.isFile() || stat.size > 1024 * 1024 || !language.extensions.some(extension => path.endsWith(extension))) {
        throw new Error('local-taint requires grammar-matched files no larger than 1 MiB');
      }
      const bytes = await fs.readFile(absolute);
      if (/@generated|DO NOT EDIT|Code generated/.test(bytes.toString('utf8', 0, 500))) throw new Error('local-taint generated source excluded');
      inputs.push({ path, absolute, bytes });
    }
    const identity = await semgrepIdentity();
    answer.analyzer = { version: identity.version, binarySha256: identity.binarySha256,
      manifestSha256: identity.manifestSha256, license: identity.license };
    answer.sources = inputs.map(input => ({ path: input.path, contentHash: hash(input.bytes), language: args.language }));
    const rule = { rules: [{ id: 'native-local-taint', languages: [language.analyzer], mode: 'taint',
      message: 'Declared source flows to the declared sink.', severity: 'INFO',
      'pattern-sources': patterns.sources.map(pattern => ({ pattern })),
      'pattern-sinks': patterns.sinks.map(pattern => ({ pattern })),
      ...((patterns.sanitizers?.length ?? 0) ? { 'pattern-sanitizers': patterns.sanitizers!.map(pattern => ({ pattern })) } : {}),
    }] };
    const ruleBytes = JSON.stringify(rule);
    answer.ruleSha256 = hash(ruleBytes);
    scratch = await fs.mkdtemp(join(tmpdir(), 'native-local-taint-'));
    const captured = new Map<string, string>();
    const targets = [];
    for (const [index, input] of inputs.entries()) {
      const path = join(scratch, `input-${index}${language.extensions[0]}`);
      await fs.writeFile(path, input.bytes);
      captured.set(path, input.path);
      targets.push(['CodeTarget', { path: { fpath: path, ppath: '/' + input.path }, analyzer: language.analyzer, products: ['sast'] }]);
    }
    const rulesPath = join(scratch, 'rules.json'), targetsPath = join(scratch, 'targets.json');
    await fs.writeFile(rulesPath, ruleBytes);
    await fs.writeFile(targetsPath, JSON.stringify(['Targets', targets]));
    // The maintained machine-output mode suppresses progress dots at their
    // source. Do not strip arbitrary diagnostics into an apparently valid JSON.
    const result = await execute(identity.bin, ['-json_nodots', '-rules', rulesPath, '-targets', targetsPath,
      '-j', '1', '-timeout', '5', '-max_memory', '512', '-max_match_per_file', '1000'],
    { cwd: scratch, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
    const findings = decodeTaintOutput(result.stdout, captured);
    for (const input of inputs) {
      if (hash(await fs.readFile(input.absolute)) !== hash(input.bytes)) {
        answer.freshness.staleVsDisk = true;
        throw new Error('local-taint source changed during analysis: ' + input.path);
      }
    }
    const limit = Math.max(1, Math.min(args.limit ?? 100, 100));
    answer.findings = findings.slice(0, limit);
    answer.scanCoverage = { requested: inputs.length, scanned: inputs.length, complete: true };
    answer.truncation = { truncated: findings.length > limit, totalAvailable: findings.length };
    answer.freshness = { health: 'healthy', staleVsDisk: false };
  } catch (error) {
    answer.error = error instanceof Error ? error.message : String(error);
    answer.findings = [];
  } finally {
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  }
  return answer;
}
