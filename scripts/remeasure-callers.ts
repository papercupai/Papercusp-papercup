/** EI-25266055698618523 — real graph:query handler + semantic AND literal census.
 * node --import tsx scripts/remeasure-callers.ts [sampledName ...]
 * node --import tsx scripts/remeasure-callers.ts --name=EventKey --paths=packages/operator-core/lib
 * Emits one JSON row per question, then a summary. Does not alter fixtures,
 * pair outcomes or routing; those still require reviewed evidence/Decisions.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import graphQuery from '../packages/operator-core/lib/agent-tools/gitnexus/query';
import { anchorForRoot, callerIdentOf, parseGrepAtom } from '../packages/operator-core/lib/bash-substitution/pairs/code-search';
import { remeasureCallers } from '../packages/operator-core/lib/code-intelligence/callers-remeasure';
import type { FirstPartyCallersAnswer } from '../packages/operator-core/lib/code-intelligence/first-party-callers';
import { LSP_VENDOR_DIR } from '../packages/operator-core/lib/code-intelligence/lsp-adapter';
import { loadVendoredTypescript } from '../packages/operator-core/lib/code-intelligence/typescript-service';
import { isCliEntry } from '../packages/operator-core/lib/util/cli-entry';

export async function main(args: string[]): Promise<number> {
  const root = process.cwd();
  const ts = loadVendoredTypescript(LSP_VENDOR_DIR);
  const nameArg = args.find((arg) => arg.startsWith('--name='))?.slice(7);
  const pathsArg = args.find((arg) => arg.startsWith('--paths='))?.slice(8);
  if (args.some((arg) => arg.startsWith('--') && !arg.startsWith('--name=') && !arg.startsWith('--paths='))) throw new Error('unknown option');
  const wanted = args.filter((arg) => !arg.startsWith('--'));
  if ((nameArg !== undefined) !== (pathsArg !== undefined) || (nameArg !== undefined && wanted.length > 0)) throw new Error('use --name and --paths together, or sampled names');
  const fixture = nameArg === undefined ? JSON.parse(readFileSync('packages/operator-core/lib/bash-substitution/fixtures/code-search.callers-lookup.sample.json', 'utf8')) as { sample: { atom: string }[] } : null;
  const rows = fixture ? fixture.sample.map(({ atom }) => {
    const name = callerIdentOf(atom);
    if (!name) throw new Error(`fixture atom is not a caller question: ${atom}`);
    return { atom, name, roots: [...new Set(parseGrepAtom(atom).paths.map(anchorForRoot))] };
  }).filter((row) => wanted.length === 0 || wanted.includes(row.name)) : [{ atom: null, name: nameArg!, roots: pathsArg!.split(',').filter(Boolean) }];
  if (rows.length === 0 || wanted.some((name) => !rows.some((row) => row.name === name))) throw new Error('requested sample name not found');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  let failed = 0;
  for (const row of rows) {
    const started = performance.now();
    try {
      if (row.roots.length === 0) throw new Error('explicit search roots required');
      const parsed = graphQuery.args.parse({ op: 'callers', name: row.name, paths: row.roots, limit: 500 });
      const out = await graphQuery.handler(parsed, { projectDir: root } as never) as { data: FirstPartyCallersAnswer };
      const result = remeasureCallers({ ts, root, name: row.name, paths: row.roots, answer: out.data });
      if (result.error || result.truncated || result.noLine > 0 || result.suspicious.length > 0 || result.partialNameSearch) failed += 1;
      console.log(JSON.stringify({ step: 'remeasure', head, plane: 'current-working-tree-real-handler', ...row, result, ms: Math.round(performance.now() - started) }));
    } catch (error) {
      failed += 1;
      console.log(JSON.stringify({ step: 'remeasure', head, ...row, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  console.log(JSON.stringify({ step: 'summary', questions: rows.length, failed }));
  return failed > 0 ? 1 : 0;
}

if (isCliEntry(import.meta.url)) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { console.error(error); process.exitCode = 1; });
