/**
 * mint-join-body — write the JOIN_BODY that vm/p2p-join-soak.sh POSTs to a joiner's
 * /api/harness/join-link: `{"harnessLinkUrl": "<member join link>", "slug": "<member slug>"}`.
 *
 * WI-10006697. The link is minted by the PRODUCT: resolveHiveMemberJoinLinks in
 * packages/operator-core/lib/hive-publish-from-repo.ts, the same builder the hive directory
 * announce uses, reading this box's harness registry, hive keypair and device identity. It
 * used to come from a scratch script that hard-coded one pot's topic, pubkeys and repo ids.
 *
 * Run it on the box that OWNS the hive, as the operator's user:
 *   npx tsx scripts/agent-capacity/vm/mint-join-body.ts --hive <hive slug> --out <file>
 *       [--repo <owner/name>] [--slug <member slug>] [--workspace <id>] [--allow-unbound]
 *
 * --repo picks a member when the hive has more than one; --slug defaults to the member's
 * registry slug. The product never emits a link to the hive HOME (D-047), only to members. The link grants a join, so --out must be OUTSIDE the repository (a path inside
 * it is refused) and the file is written mode 0600. Prints JOIN_BODY_MINTED on success.
 *
 * Exit: 0 written · 2 usage / refused --out / ambiguous member · 3 no joinable link
 *       · 4 link lacks the D-007 owner binding (a joiner would fall back to the announce
 *         beacon, a different path from the one the soak measures; --allow-unbound accepts it).
 */
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

export interface MintArgs {
  hive: string;
  out: string;
  repo?: string;
  slug?: string;
  workspace: string;
  allowUnbound: boolean;
}

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function parseMintArgs(argv: string[]): MintArgs | { error: string } {
  const out: Partial<MintArgs> = { workspace: 'papercusp-workspace', allowUnbound: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      if (a === '--hive') out.hive = val();
      else if (a === '--out') out.out = val();
      else if (a === '--repo') out.repo = val();
      else if (a === '--slug') out.slug = val();
      else if (a === '--workspace') out.workspace = val();
      else if (a === '--allow-unbound') out.allowUnbound = true;
      else return { error: `unknown argument ${a}` };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
  if (!out.hive) return { error: '--hive <hive slug> is required' };
  if (!out.out) return { error: '--out <file outside the repo> is required' };
  return out as MintArgs;
}

/** The JOIN_BODY grants a join: refuse to write it anywhere git-sync could commit it. */
export function refuseInRepo(outPath: string, repoRoot: string = REPO_ROOT): string | null {
  const abs = path.resolve(outPath);
  const rel = path.relative(repoRoot, abs);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    return `--out ${abs} is inside the repository (${repoRoot}); the link grants a join, write it outside (e.g. ~/.cache/agent-capacity/<run>/join-body.json)`;
  }
  return null;
}

/** Pick one member link (by --repo when there are several) and build the body. */
export function buildJoinBody(
  members: Array<{ slug: string; link: string }>,
  args: Pick<MintArgs, 'repo' | 'slug'>,
  parse: (url: string) => { github: string } | null,
): { body: { harnessLinkUrl: string; slug: string }; github: string } | { error: string; code: 2 | 3 } {
  const parsed = members
    .map((m) => ({ url: m.link, slug: m.slug, link: parse(m.link) }))
    .filter((x): x is { url: string; slug: string; link: { github: string } } => x.link !== null);
  if (parsed.length === 0) return { error: 'the hive has no joinable member link', code: 3 };
  const pick = args.repo
    ? parsed.filter((x) => x.link.github.toLowerCase() === args.repo!.toLowerCase())
    : parsed;
  if (pick.length === 0) {
    return { error: `no member link for --repo ${args.repo}; members: ${parsed.map((x) => x.link.github).join(', ')}`, code: 2 };
  }
  if (pick.length > 1) {
    return { error: `the hive has ${pick.length} members; pass --repo one of: ${pick.map((x) => x.link.github).join(', ')}`, code: 2 };
  }
  return {
    body: { harnessLinkUrl: pick[0].url, slug: args.slug ?? pick[0].slug },
    github: pick[0].link.github,
  };
}

async function main(): Promise<number> {
  const args = parseMintArgs(process.argv.slice(2));
  if ('error' in args) {
    console.error(`USAGE: ${args.error}\n  npx tsx scripts/agent-capacity/vm/mint-join-body.ts --hive <hive slug> --out <file> [--repo <owner/name>] [--slug <member slug>] [--workspace <id>] [--allow-unbound]`);
    return 2;
  }
  const refused = refuseInRepo(args.out);
  if (refused) {
    console.error(`REFUSED: ${refused}`);
    return 2;
  }
  const { resolveHiveMemberJoinLinks } = await import('../../../packages/operator-core/lib/hive-publish-from-repo');
  const { parseHarnessLink } = await import('../../../packages/operator-core/lib/harness/url-scheme');
  const res = await resolveHiveMemberJoinLinks({ workspaceId: args.workspace, potSlug: args.hive });
  if (!res.hivePubkey) {
    console.error(`JOIN_BODY_NONE hive=${args.hive} workspace=${args.workspace}: no hive pubkey on this box (not the owner, or not a hive slug)`);
    return 3;
  }
  const built = buildJoinBody(res.members, args, parseHarnessLink);
  if ('error' in built) {
    console.error(`JOIN_BODY_NONE hive=${args.hive}: ${built.error}`);
    return built.code;
  }
  if (!res.ownerBound && !args.allowUnbound) {
    console.error(`JOIN_BODY_UNBOUND hive=${args.hive}: the owner identity did not resolve, so the link lacks the D-007 binding; pass --allow-unbound to accept it`);
    return 4;
  }
  writeFileSync(args.out, `${JSON.stringify(built.body)}\n`, { mode: 0o600 });
  chmodSync(args.out, 0o600);
  console.log(`JOIN_BODY_MINTED out=${path.resolve(args.out)} hive=${args.hive} repo=${built.github} slug=${built.body.slug} ownerBound=${res.ownerBound}`);
  return 0;
}

if (isCliEntry(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`JOIN_BODY_ERROR ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
