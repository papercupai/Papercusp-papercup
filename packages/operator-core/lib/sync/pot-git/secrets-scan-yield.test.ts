// WI-10005476: bg-host's secrets scans held the main thread for seconds, because
// both blocking-publish callers scanned a whole read (a 32 MB chunk, or every
// text blob of a commit) in one turn of the event loop. Each caller now yields
// between files once a time slice is spent.
//
// The property under test is OBSERVABLE, not structural: a macrotask that becomes
// pending while the scan is running must get to run BEFORE the scan finishes.
// Without a yield it cannot — the fake git below resolves on microtasks only, so
// nothing but an explicit yield lets a macrotask in. Each file's scan busy-waits
// longer than the default slice, so a correct implementation yields between files.
// Findings and their order must be unchanged.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const git = vi.hoisted(() => ({ store: new Map<string, Buffer>() }));

vi.mock('./storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage')>();
  return {
    ...actual,
    // `cat-file --batch` over the in-memory store: `<oid> blob <size>\n<body>\n`.
    defaultRunGitStdin: vi.fn(async (_args: string[], _cwd: string, stdin: string) => {
      const parts: Buffer[] = [];
      for (const oid of stdin.split('\n').filter(Boolean)) {
        const body = git.store.get(oid);
        if (!body) parts.push(Buffer.from(`${oid} missing\n`));
        else parts.push(Buffer.from(`${oid} blob ${body.length}\n`), body, Buffer.from('\n'));
      }
      return { code: 0, stdout: Buffer.concat(parts), stderr: '' };
    }),
  };
});

vi.mock('./secrets-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secrets-guard')>();
  return { ...actual, scanForSecrets: vi.fn(actual.scanForSecrets) };
});

import { scanForSecrets } from './secrets-guard';
import { resetBlobScanCacheForTests, scanTextBlobsChunked, type BlobEntry } from './chunked-blob-scan';
import { resolveSafeEgressSha } from './github-egress';

const SCAN_MS = 15; // > DEFAULT_TIME_SLICE_MS (10)
// Split so this file does not itself carry a scannable key (not ...EXAMPLE, which is exempt).
const LEAK = `AWS_ACCESS_KEY_ID=${'AKIA' + 'J7QK3RTZ2WLPX4NA'}\n`;

let nextOid = 1;
function put(content: string): string {
  const oid = (nextOid++).toString(16).padStart(40, '0');
  git.store.set(oid, Buffer.from(content, 'utf8'));
  return oid;
}

/** Make every scanForSecrets call burn SCAN_MS of main-thread time and log 'scan:<path>'.
 *  The first call schedules a macrotask that logs 'tick' when it runs. */
async function instrumentScans(events: string[]): Promise<void> {
  const { scanForSecrets: real } = await vi.importActual<typeof import('./secrets-guard')>('./secrets-guard');
  let armed = false;
  vi.mocked(scanForSecrets).mockImplementation((files) => {
    if (!armed) {
      armed = true;
      setImmediate(() => events.push('tick'));
    }
    const until = performance.now() + SCAN_MS;
    while (performance.now() < until) {
      /* busy: stands in for scanning a large text blob */
    }
    for (const f of files) events.push(`scan:${f.path}`);
    return real(files);
  });
}

beforeEach(() => {
  git.store.clear();
  resetBlobScanCacheForTests();
  vi.mocked(scanForSecrets).mockReset();
});

describe('WI-10005476: secrets scans yield the main thread between files', () => {
  it('scanTextBlobsChunked lets a pending macrotask run mid-chunk, with unchanged findings', async () => {
    const events: string[] = [];
    await instrumentScans(events);

    const paths = ['a.ts', 'leak.env', 'b.ts', 'c.ts'];
    const blobs: BlobEntry[] = paths.map((p) => {
      const content = p === 'leak.env' ? LEAK : `export const x = '${p}';\n`;
      return { oid: put(content), path: p, bytes: Buffer.byteLength(content) };
    });

    const res = await scanTextBlobsChunked(blobs, '/fake/pot-git.git', 32 * 1024 * 1024);

    expect(res.error).toBeNull();
    expect(res.findings.map((f) => [f.path, f.rule])).toEqual([['leak.env', 'aws-access-key-id']]);
    const scans = events.filter((e) => e.startsWith('scan:'));
    expect(scans).toEqual(paths.map((p) => `scan:${p}`)); // order preserved
    // The macrotask ran BEFORE the last file was scanned: the chunk was not one turn.
    expect(events.indexOf('tick')).toBeGreaterThan(-1);
    expect(events.indexOf('tick')).toBeLessThan(events.lastIndexOf(scans[scans.length - 1]));
  });

  it('resolveSafeEgressSha lets a pending macrotask run mid-commit, and still blocks on the leak', async () => {
    const events: string[] = [];
    await instrumentScans(events);

    const paths = ['a.ts', 'b.ts', 'leak.env', 'c.ts'];
    const oids = paths.map((p) => put(p === 'leak.env' ? LEAK : `export const x = '${p}';\n`));
    const commit = 'c'.repeat(40);
    const zero = '0'.repeat(40);
    const diffTree = paths.map((p, i) => `:000000 100644 ${zero} ${oids[i]} A\t${p}`).join('\n') + '\n';

    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-list') return { code: 0, stdout: `${commit}\n`, stderr: '' };
      if (args[0] === 'diff-tree') return { code: 0, stdout: diffTree, stderr: '' };
      return { code: 1, stdout: '', stderr: `unexpected git ${args.join(' ')}` };
    });
    const runGitStdin = vi.fn(async (args: string[], _cwd: string, stdin: string) => {
      const ids = stdin.split('\n').filter(Boolean);
      if (args[1]?.startsWith('--batch-check')) {
        const lines = ids.map((id) => `${id} blob ${git.store.get(id)!.length}`).join('\n') + '\n';
        return { code: 0, stdout: Buffer.from(lines), stderr: '' };
      }
      const parts = ids.flatMap((id) => {
        const body = git.store.get(id)!;
        return [Buffer.from(`${id} blob ${body.length}\n`), body, Buffer.from('\n')];
      });
      return { code: 0, stdout: Buffer.concat(parts), stderr: '' };
    });

    const res = await resolveSafeEgressSha({
      repoPath: '/fake/pot-git.git',
      base: null,
      target: commit,
      maxFiles: 1000,
      runGit: runGit as never,
      runGitStdin: runGitStdin as never,
    });

    expect(res.error).toBeUndefined();
    expect(res.safeSha).toBeNull();
    expect(res.blocked?.commit).toBe(commit);
    expect(res.blocked?.findings.map((f) => [f.path, f.rule])).toEqual([['leak.env', 'aws-access-key-id']]);
    const scans = events.filter((e) => e.startsWith('scan:'));
    expect(scans).toEqual(paths.map((p) => `scan:${p}`));
    expect(events.indexOf('tick')).toBeGreaterThan(-1);
    expect(events.indexOf('tick')).toBeLessThan(events.lastIndexOf(scans[scans.length - 1]));
  });
});
