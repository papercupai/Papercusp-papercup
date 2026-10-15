/**
 * Build the FrontierSWE v2 corpus (tasks.jsonl + manifest.json) from a vendored checkout pinned at a commit.
 * Plan benchmark-coverage-frontierswe-v2-2026-10-10 P-002 / D-002. The checkout is read as DATA ONLY.
 *
 *   npx tsx scripts/frontier-swe-ingest.ts --root <checkout> [--out <dir>] [--v1-corpus <v1 tasks.jsonl>]
 *
 * The commit is read from the checkout's own `.git` HEAD, never typed by hand, so the manifest cannot claim a
 * pin the files did not come from. An unresolvable HEAD fails the ingest's full-SHA check. `--v1-corpus` writes
 * the old corpus beside it as `v1-history.jsonl`, labelled v1 with a retiredInV2 flag per row (R-1).
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  FrontierSweIngestError,
  defaultFrontierSweCorpusDir,
  ingestFrontierSweCorpus,
  labelV1History,
  nodeIngestFs,
  parseFrontierSweJsonl,
  readCheckoutHead,
  writeFrontierSweCorpus,
} from '../packages/operator-core/lib/external-bench/frontier-swe-ingest';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const rootArg = arg('root');
  if (!rootArg) {
    console.error('usage: npx tsx scripts/frontier-swe-ingest.ts --root <checkout> [--out <dir>] [--v1-corpus <jsonl>]');
    return 2;
  }
  const root = resolve(rootArg);
  const out = resolve(arg('out') ?? defaultFrontierSweCorpusDir());
  const v1Path = arg('v1-corpus');
  const fs = nodeIngestFs();
  const commitSha = (await readCheckoutHead(root, fs)) ?? '<unresolved HEAD>';
  try {
    const result = await ingestFrontierSweCorpus({ root, commitSha }, fs);
    const v1History = v1Path
      ? labelV1History(parseFrontierSweJsonl(await readFile(resolve(v1Path), 'utf8')), result.rows)
      : undefined;
    await writeFrontierSweCorpus(out, result, v1History);
    const retired = v1History?.filter((r) => r.retiredInV2).length;
    console.log(
      `FRONTIER_SWE_INGEST ok commit=${commitSha} tasks=${result.manifest.taskCount} ` +
        `license=${result.manifest.licenseStatus} out=${out}` +
        (v1History ? ` v1History=${v1History.length} retiredInV2=${retired}` : ''),
    );
    return 0;
  } catch (e) {
    if (e instanceof FrontierSweIngestError) {
      console.error(`FRONTIER_SWE_INGEST refused commit=${commitSha}`);
      for (const p of e.problems) console.error(`  - ${p}`);
      return 1;
    }
    throw e;
  }
}

main().then((code) => process.exit(code));
