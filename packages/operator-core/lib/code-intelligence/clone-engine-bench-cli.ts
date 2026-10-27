/** Run with tsx and --out <new evidence directory> --engines <install root>.
 * --run is explicit: without it only prepares the source-containing sample.
 * No server, index singleton, dependency installation or current-tree scan.
 */
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as ts from 'typescript';
import { extractCloneFile } from './clone-index';
import { CLONE_BENCH_POLICY, minhashTreeSimilarity, parseJscpd, parseSimilarityTs, runCloneBench,
  type CloneBenchPair, type CloneEngine } from './clone-engine-bench';

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL('./__fixtures__/clone-corpus-20261021/', import.meta.url));
const repo = resolve(fixture, '../../../../../..');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const hash = (source: string) => createHash('sha256').update(source).digest('hex');

/** Fetch immutable objects named by the approved historical manifest, including
 * submodule object stores. Never substitute today's file contents on a miss.
 */
export async function historicalPairs(): Promise<CloneBenchPair[]> {
  const manifest = await json(join(fixture, 'candidate-manifest-v3.json')) as {
    candidateCommit: string; submodules: { path: string; sha: string }[];
    files: { path: string; sha256: string; gitBlobSha1: string }[];
  };
  const labels = await json(join(fixture, 'original-filtered-family-labels.json')) as { families: string[][] };
  const indices = [0, 1, 3, 4, 5];
  const pairs: CloneBenchPair[] = [];
  for (const index of indices) {
    const family = labels.families[index]!;
    const snippets: string[] = [];
    for (const label of family.slice(0, 2)) {
      const match = /^(.*):(\d+) (.*) m=(\d+)$/.exec(label);
      if (!match) throw new Error(`bad historical label: ${label}`);
      const path = match[1]!, line = Number(match[2]), row = manifest.files.find(f => f.path === path);
      if (!row) throw new Error(`missing historical manifest row: ${path}`);
      const module = [...manifest.submodules].sort((a, b) => b.path.length - a.path.length).find(m => path.startsWith(`${m.path}/`));
      const source = execFileSync('git', ['cat-file', 'blob', row.gitBlobSha1], {
        cwd: module ? join(repo, module.path) : repo, encoding: 'utf8', maxBuffer: 4 << 20,
      });
      if (hash(source) !== row.sha256) throw new Error(`historical source hash mismatch: ${path}`);
      const fn = extractCloneFile({ path, source }).functions.find(f => f.line === line && f.name === match[3]);
      if (!fn) throw new Error(`historical function not found: ${label}`);
      snippets.push(source.slice(fn.start, fn.end));
    }
    const evidence = `D-012 reconstructed historical output (original input UNPROVEN; census 36185 vs 36183); ${manifest.candidateCommit}; family ${index}; ${family.slice(0, 2).join(' | ')}`;
    pairs.push({ id: `historical-${index}`, left: snippets[0]!, right: snippets[1]!, positive: true,
      stratum: 'historical-renamed', evidence });
    // Known synthetic insertion; not falsely attributed to archived Type-3 labels.
    const source = ts.createSourceFile('sample.ts', snippets[0]!, ts.ScriptTarget.Latest, true);
    let body: ts.Block | undefined;
    const visit = (n: ts.Node) => { if (!body && ts.isBlock(n)) body = n; if (!body) ts.forEachChild(n, visit); };
    visit(source);
    if (!body) throw new Error('historical sample has no function body');
    const offset = (body as ts.Block).getStart(source) + 1;
    const right = snippets[0]!.slice(0, offset) + '\nif (Date.now() < 0) { throw new Error("benchmark clock guard"); }\n' + snippets[0]!.slice(offset);
    pairs.push({ id: `near-miss-${index}`, left: snippets[0]!, right, positive: true,
      stratum: 'authored-near-miss', evidence: `${evidence}; authored insertion of one guarded throw at function-body entry; syntax clone, no behavioral-equivalence claim` });
  }
  const historical = pairs.filter(p => p.stratum === 'historical-renamed');
  // Explicit reviewable negative labels, not an assumption that all unlabelled
  // cross-family pairs are negative. The saved sample includes both bodies.
  for (const [a, b, note] of [
    [0, 1, 'extract message content versus advance a seeded random generator'],
    [1, 2, 'advance a seeded random generator versus decode base64 bytes'],
    [2, 3, 'decode base64 bytes versus validate a dock layout tree'],
    [3, 4, 'validate a dock layout tree versus resolve and load an ONNX native binding'],
    [4, 0, 'resolve and load an ONNX native binding versus extract message content'],
  ] as const) pairs.push({ id: `negative-${a}-${b}`, left: historical[a]!.left, right: historical[b]!.left,
    positive: false, stratum: 'checked-negative', evidence: `Source-reviewed distinct syntax/operation: ${note}; source identities: ${historical[a]!.evidence}; ${historical[b]!.evidence}` });
  return pairs;
}

async function main() {
  const args = process.argv.slice(2), option = (key: string) => args[args.indexOf(key) + 1];
  if (!args.includes('--out') || !args.includes('--engines')) throw new Error('required: --out <new evidence directory> --engines <pinned install root> [--run]');
  const output = resolve(option('--out')!), install = resolve(option('--engines')!);
  await mkdir(output, { recursive: false });
  const pairs = await historicalPairs();
  await writeFile(join(output, 'sample.json'), JSON.stringify(pairs, null, 2));
  if (!args.includes('--run')) { console.log(JSON.stringify({ prepared: output, pairs: pairs.length })); return; }
  const writeJson = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx' });
  const versions: Record<string, string> = {};
  const engines: CloneEngine[] = [];
  for (const [id, binary, expected, dependencyCount] of [
    ['jscpd', join(install, 'node_modules/.bin/jscpd'), '5.4.2', 2],
    ['similarity-ts', join(install, 'similarity-ts'), '0.5.0', 1],
  ] as const) {
    let unavailable: string | null = null;
    try {
      const version = (await exec(binary, ['--version'], { timeout: 30000 })).stdout.trim();
      if (!version.includes(expected)) throw new Error(`version mismatch: ${version}`);
      versions[id] = version;
    } catch (e) { unavailable = String(e); versions[id] = `required-${expected}`; }
    const bytes = await stat(binary).then(s => s.size, () => null);
    const attempts = new Map<string, number>();
    engines.push({ id, version: `${versions[id]};policy=${hash(JSON.stringify(CLONE_BENCH_POLICY))}`, dependencyCount,
      dependencyEvidence: `${id} ${expected}; ${dependencyCount} added package/executable artifacts; executable bytes=${bytes}; libc/native requirements not counted as npm dependencies; isolated installation, no product dependency added`,
      unavailable,
      compare: async pair => {
        const rep = (attempts.get(pair.id) ?? 0) + 1; attempts.set(pair.id, rep);
        const dir = join(output, 'raw', id, pair.id, String(rep)), source = join(dir, 'source');
        await mkdir(source, { recursive: true });
        await writeFile(join(source, 'a.ts'), pair.left); await writeFile(join(source, 'b.ts'), pair.right);
        const command = id === 'jscpd'
          ? [source, `--similarity=${CLONE_BENCH_POLICY.similarity}`, '--min-nodes', '20', '--min-lines', '1', '--min-tokens', '1', '--reporters', 'json', '--output', dir, '--no-colors', '--no-gitignore', '--workers', '1']
          : [source, '--threshold', String(CLONE_BENCH_POLICY.similarity), '--min-lines', '1', '--no-types', '--no-fast', '--rename-cost', '0.3'];
        // Process startup and report parsing are included in guardedArm latency.
        try {
          const result = await exec(binary, command, { cwd: dir, timeout: 30000, maxBuffer: 4 << 20, env: { ...process.env, NO_COLOR: '1' } });
          await writeJson(join(dir, 'command.json'), { binary, args: command });
          await writeFile(join(dir, 'stdout.txt'), result.stdout); await writeFile(join(dir, 'stderr.txt'), result.stderr);
          return id === 'jscpd' ? parseJscpd(await json(join(dir, 'jscpd-report.json')),
            [pair.left.split('\n').length, pair.right.split('\n').length]) : parseSimilarityTs(result.stdout);
        } catch (e) {
          await writeFile(join(dir, 'error.txt'), String(e)); throw e;
        }
      } });
  }
  engines.push({ id: 'minhash-tree-edit', version: `v1;typescript-${ts.version};policy=${hash(JSON.stringify(CLONE_BENCH_POLICY))}`,
    dependencyCount: 0, dependencyEvidence: 'zero new packages; reuses repository TypeScript parser; ordered subtree edit (not APTED); 32 seeded MinHash values, 8 bands of 4, 3-kind shingles', unavailable: null,
    compare: async pair => { const result = minhashTreeSimilarity(pair.left, pair.right); return result.candidate && result.similarity! >= CLONE_BENCH_POLICY.similarity; } });
  const report = await runCloneBench(pairs, engines,
    registration => writeJson(join(output, 'preregistration.json'), registration),
    run => writeJson(join(output, `${run.capabilities.armId}.run.json`), run));
  await writeJson(join(output, 'report.json'), report);
  console.log(JSON.stringify({ output, selected: report.selected, residue: report.residue, ranking: report.ranking }, null, 2));
  if (!report.selected) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error); process.exitCode = 1; });
