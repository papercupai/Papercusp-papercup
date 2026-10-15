import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildJoinBody, parseMintArgs, REPO_ROOT, refuseInRepo } from './mint-join-body';

// WI-10006697: the soak JOIN_BODY is minted from the product (resolveHiveMemberJoinLinks, unit-tested
// in packages/operator-core/lib/hive-publish-from-repo.test.ts); these cover the script's own rails.

const parse = (url: string) => {
  const m = /^link:([^/]+)\/(.+)$/.exec(url);
  return m ? { github: `${m[1]}/${m[2]}` } : null;
};
const mem = (github: string, slug = github.split('/')[1] + '-local') => ({ slug, link: `link:${github}` });

describe('mint-join-body argument parsing', () => {
  it('requires --hive and --out, defaults workspace and allowUnbound', () => {
    expect(parseMintArgs(['--out', '/tmp/x'])).toEqual({ error: '--hive <hive slug> is required' });
    expect(parseMintArgs(['--hive', 'h'])).toEqual({ error: '--out <file outside the repo> is required' });
    expect(parseMintArgs(['--hive', 'h', '--out', '/tmp/x'])).toEqual({
      hive: 'h',
      out: '/tmp/x',
      workspace: 'papercusp-workspace',
      allowUnbound: false,
    });
  });

  it('rejects an unknown flag and a flag missing its value', () => {
    expect(parseMintArgs(['--hive', 'h', '--out', '/tmp/x', '--bogus'])).toEqual({ error: 'unknown argument --bogus' });
    expect(parseMintArgs(['--hive', '--out', '/tmp/x'])).toEqual({ error: '--hive needs a value' });
  });
});

describe('mint-join-body refuses to write the join link inside the repository', () => {
  it('refuses a path inside the repo, accepts one outside', () => {
    expect(refuseInRepo(path.join(REPO_ROOT, '.papercusp/scratch/jb.json'))).toMatch(/inside the repository/);
    expect(refuseInRepo(REPO_ROOT)).toMatch(/inside the repository/);
    expect(refuseInRepo('/tmp/agent-capacity/jb.json')).toBeNull();
    expect(refuseInRepo(`${REPO_ROOT}-sibling/jb.json`)).toBeNull();
  });

  it('the CLI exits 2 on an in-repo --out before touching any hive state', () => {
    const r = spawnSync(
      'npx',
      ['tsx', 'scripts/agent-capacity/vm/mint-join-body.ts', '--hive', 'h', '--out', '.papercusp/scratch/jb.json'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^REFUSED: .*inside the repository/m);
  });
});

describe('mint-join-body member selection', () => {
  it('one member: uses it, slug defaults to the member registry slug (not the repo name)', () => {
    expect(buildJoinBody([mem('acme/shop')], {}, parse)).toEqual({
      body: { harnessLinkUrl: 'link:acme/shop', slug: 'shop-local' },
      github: 'acme/shop',
    });
    expect(buildJoinBody([mem('acme/shop')], { slug: 'mine' }, parse)).toMatchObject({
      body: { slug: 'mine' },
    });
  });

  it('several members: --repo picks one (case-insensitive); without it, refuses and names them', () => {
    const links = [mem('acme/shop'), mem('acme/docs')];
    expect(buildJoinBody(links, { repo: 'ACME/docs' }, parse)).toMatchObject({
      body: { harnessLinkUrl: 'link:acme/docs', slug: 'docs-local' },
    });
    expect(buildJoinBody(links, {}, parse)).toEqual({
      error: 'the hive has 2 members; pass --repo one of: acme/shop, acme/docs',
      code: 2,
    });
    expect(buildJoinBody(links, { repo: 'acme/nope' }, parse)).toMatchObject({ code: 2 });
  });

  it('no parseable link: exit code 3', () => {
    expect(buildJoinBody([], {}, parse)).toMatchObject({ code: 3 });
    expect(buildJoinBody([{ slug: 'x', link: 'garbage' }], {}, parse)).toMatchObject({ code: 3 });
  });
});
