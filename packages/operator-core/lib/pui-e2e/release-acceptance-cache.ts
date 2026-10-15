/** Exact, slot-locked retirement for the existing PUI acceptance cache. */
import { execFileSync } from 'node:child_process';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isCliEntry } from '../util/cli-entry';
import { scanProcHolders, type HolderScan } from '../release-cut-reclaim';

export interface RetireAcceptanceDependenciesOptions {
  checkout: string;
  expectedSha: string;
  /** Omit to retire the completed slot's conventional dependency trees. */
  trees?: string[];
  execute?: boolean;
  scan?: typeof scanProcHolders;
}

export async function retireAcceptanceDependencies(options: RetireAcceptanceDependenciesOptions) {
  if (!/^[0-9a-f]{40}$/.test(options.expectedSha)) throw new Error('exact source commit required');
  const checkout = resolve(options.checkout);
  if ((await realpath(checkout)) !== checkout) throw new Error('checkout must be a physical slot directory');
  const actualSha = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (actualSha !== options.expectedSha) throw new Error('slot source commit changed');
  const trees = options.trees ?? await discoverDependencyTrees(checkout);
  if ((options.trees && trees.length === 0) || trees.length > 50) throw new Error('name 1–50 dependency trees');
  const targets = [...new Set(trees)].map((tree) => {
    if (!/^(?:node_modules|(?:apps|packages|libs)\/[A-Za-z0-9._-]+\/node_modules)$/.test(tree)) {
      throw new Error(`not a dependency tree: ${tree}`);
    }
    return join(checkout, tree);
  });
  const identities = new Map<string, { dev: number; ino: number }>();
  for (const target of targets) {
    let value;
    try { value = await lstat(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!value.isDirectory() || value.isSymbolicLink() || (await realpath(target)) !== target) {
      throw new Error(`dependency tree is not a physical directory: ${target}`);
    }
    identities.set(target, { dev: value.dev, ino: value.ino });
  }
  const scan = options.scan ?? scanProcHolders;
  const assertIdle = (result: HolderScan) => {
    if (!result.verified) throw new Error(`process-use scan unverified: ${result.reason ?? 'unknown'}`);
    if ((result.holders.get(checkout) ?? []).length > 0) throw new Error('acceptance slot is in use');
  };
  assertIdle(await scan([{ key: checkout, prefixes: [checkout] }]));
  const removed: string[] = [];
  if (options.execute) {
    for (const [target, identity] of identities) {
      assertIdle(await scan([{ key: checkout, prefixes: [checkout] }]));
      const current = await lstat(target);
      if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino || await realpath(target) !== target) {
        throw new Error(`dependency tree changed during retirement: ${target}`);
      }
      await rm(target, { recursive: true, force: false });
      removed.push(target);
    }
  }
  return { checkout, sourceSha: actualSha, dryRun: !options.execute, candidates: [...identities.keys()], removed };
}

async function discoverDependencyTrees(checkout: string): Promise<string[]> {
  const trees = ['node_modules'];
  for (const scope of ['apps', 'packages', 'libs']) {
    const directory = join(checkout, scope);
    let entries;
    try {
      const value = await lstat(directory);
      if (!value.isDirectory() || value.isSymbolicLink() || await realpath(directory) !== directory) {
        throw new Error(`dependency scope is not a physical directory: ${directory}`);
      }
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!/^[A-Za-z0-9._-]+$/.test(entry.name)) continue;
      // A symlinked workspace is not an owned dependency-copy destination.
      if (entry.isSymbolicLink()) throw new Error(`dependency workspace is a symlink: ${join(directory, entry.name)}`);
      if (entry.isDirectory()) {
        const tree = `${scope}/${entry.name}/node_modules`;
        try {
          await lstat(join(checkout, tree));
          trees.push(tree);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
  }
  return trees;
}

if (isCliEntry(import.meta.url)) {
  const [checkout, expectedSha, ...args] = process.argv.slice(2);
  const execute = args.includes('--execute');
  const automatic = args.includes('--all-dependencies');
  const trees = args.filter((value) => value !== '--execute' && value !== '--all-dependencies');
  try {
    if (automatic && trees.length) throw new Error('automatic retirement cannot also name dependency trees');
    console.log(JSON.stringify(await retireAcceptanceDependencies({ checkout: checkout ?? '', expectedSha: expectedSha ?? '', trees: automatic ? undefined : trees, execute })));
  } catch (error) {
    console.error(`release-acceptance: retirement refused: ${String(error)}`);
    process.exitCode = 2;
  }
}
