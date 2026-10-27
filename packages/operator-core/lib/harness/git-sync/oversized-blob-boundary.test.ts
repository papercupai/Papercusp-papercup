import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  declaresGeneratedBanner,
  findBulkDirtyExcess,
  bulkArtifactMinBytes,
  findOversizedDirtyFiles,
  type RunGit,
} from './run-git-sync';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

// G22 (test-coverage-gap): existing oversized tests use sizes clearly over the
// limit (e.g. 2048 vs 1024). None pin the EXACT boundary. The comparison is
// strict `>` (run-git-sync.ts: `st.size > maxBytes`), so a file of exactly
// maxBytes must be INCLUDED in the commit — a `>`→`>=` slip would needlessly
// exclude files at the limit. This test exercises maxBytes-1 / maxBytes / maxBytes+1.

const MAX = 64;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'oversize-boundary-'));
  writeFileSync(join(dir, 'under'), Buffer.alloc(MAX - 1)); // < MAX → included
  writeFileSync(join(dir, 'at-limit'), Buffer.alloc(MAX)); //   = MAX → included (NOT > MAX)
  writeFileSync(join(dir, 'over'), Buffer.alloc(MAX + 1)); //   > MAX → excluded
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Mock git status: report all three files as untracked (porcelain -z -uall).
const runGit: RunGit = async (args) => {
  if (args[0] === 'status') {
    return { code: 0, stdout: '?? under\0?? at-limit\0?? over\0', stderr: '' };
  }
  return { code: 0, stdout: '', stderr: '' };
};

describe('dirty-file size guards — bounded filesystem work', () => {
  it.each(['oversized', 'bulk'] as const)('%s sizes multiple files without serial per-file waits or unbounded fan-out', async (mode) => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const sizedFile = await actual.lstat(join(dir, 'over'));
    const paths = Array.from({ length: 19 }, (_, i) => `candidate-${i}`);
    const status: RunGit = async () => ({ code: 0,
      stdout: paths.map(path => `?? ${path}\0`).join(''), stderr: '' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started = 0;
    let inFlight = 0;
    let peak = 0;
    vi.mocked(lstat).mockImplementation(async () => {
      started++;
      peak = Math.max(peak, ++inFlight);
      await gate;
      inFlight--;
      return sizedFile;
    });
    const scanning = mode === 'oversized'
      ? findOversizedDirtyFiles(status, dir, MAX)
      : findBulkDirtyExcess(status, dir, MAX);
    try {
      await vi.waitFor(() => expect(started).toBeGreaterThan(0));
      expect(inFlight).toBe(16);
      expect(started).toBe(16);
    } finally {
      release();
      await scanning;
      vi.mocked(lstat).mockImplementation(actual.lstat);
    }
    expect(peak).toBe(16);
    expect((await scanning).map(file => file.path)).toEqual(paths);
  });
});

describe('findOversizedDirtyFiles — exact maxBytes boundary (strict >, not >=)', () => {
  it('excludes only files strictly OVER maxBytes; a file AT the limit is committed', async () => {
    const oversized = await findOversizedDirtyFiles(runGit, dir, MAX);
    const paths = oversized.map((f) => f.path);
    expect(paths).toContain('over'); // MAX+1 → excluded
    expect(paths).not.toContain('at-limit'); // exactly MAX → INCLUDED
    expect(paths).not.toContain('under'); // MAX-1 → included
    expect(oversized).toHaveLength(1);
    expect(oversized[0]?.sizeBytes).toBe(MAX + 1);
  });

  it('with maxBytes one smaller, the at-limit file flips to excluded (boundary is load-bearing)', async () => {
    const oversized = await findOversizedDirtyFiles(runGit, dir, MAX - 1);
    const paths = oversized.map((f) => f.path);
    expect(paths).toContain('over');
    expect(paths).toContain('at-limit'); // now MAX > MAX-1 → excluded
    expect(paths).not.toContain('under'); // MAX-1 == limit → still included
  });
});

// WI-3595: a real repro (throwaway git repo, `git status --porcelain -z -uall`
// vs `git check-ignore`) confirmed a gitignored oversized file is ALREADY
// excluded — plain `git status` (without `--ignored`) never lists it, so
// findOversizedDirtyFiles never sees it to begin with; there is no separate
// fs-walk fallback that could rediscover it independently of git status. The
// bug this item reported does not reproduce against the current
// implementation. This test pins the two facts that make that true, so a
// future edit can't silently reintroduce it: (1) the exact args passed to
// `git status` never include `--ignored`, and (2) a gitignored oversized file
// that (correctly) never appears in `git status`'s output is never surfaced
// as oversized — the scan has no independent fs-walk path around `git status`.
describe('findOversizedDirtyFiles — WI-3595 gitignored paths never surface as oversized', () => {
  it('invokes `git status` WITHOUT --ignored (so gitignored paths are never candidates)', async () => {
    const calls: string[][] = [];
    const spyRunGit: RunGit = async (args) => {
      calls.push(args);
      if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    await findOversizedDirtyFiles(spyRunGit, dir, MAX);
    const statusCall = calls.find((a) => a[0] === 'status');
    expect(statusCall).toBeDefined();
    expect(statusCall).not.toContain('--ignored');
  });

  it('a gitignored oversized file (absent from `git status --porcelain` output, matching real git behavior) is never reported oversized — no fs-walk fallback rediscovers it', async () => {
    // `.wi3388-cargo-target/big.bin` mirrors the exact WI-3595 repro path/shape:
    // present on disk, oversized, but git-ignored — so a real `git status`
    // never lists it. This mock reproduces that real behavior (empty status)
    // rather than asserting anything about our own parsing of a fabricated line.
    const bigFileDir = join(dir, '.wi3388-cargo-target');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(bigFileDir, { recursive: true });
    writeFileSync(join(bigFileDir, 'big.bin'), Buffer.alloc(MAX + 1));
    try {
      const ignoredStatusRunGit: RunGit = async (args) => {
        if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }; // real git: ignored path never listed
        return { code: 0, stdout: '', stderr: '' };
      };
      const oversized = await findOversizedDirtyFiles(ignoredStatusRunGit, dir, MAX);
      expect(oversized.map((f) => f.path)).not.toContain('.wi3388-cargo-target/big.bin');
      expect(oversized).toHaveLength(0);
    } finally {
      rmSync(bigFileDir, { recursive: true, force: true });
    }
  });
});

/**
 * WI-5738 — the CUMULATIVE gate.
 *
 * The 2026-07-20 wedge got past `findOversizedDirtyFiles` because every single
 * file in an extracted AppImage was under the per-file cap (largest 90.3 MB vs
 * a 95 MB cap) — while the set totalled 2,261 MB. It committed cleanly, and the
 * aggregate then breached the publish guard's 500 MB TOTAL cap downstream,
 * where the only response was a terminal refusal that froze all p2p publishing
 * for five days.
 */
describe('findBulkDirtyExcess — the cumulative cap the per-file cap cannot see', () => {
  const sizedRunGit = (files: Record<string, number>): RunGit =>
    (async (args: string[]) => {
      if (args[0] === 'status') {
        return { code: 0, stdout: Object.keys(files).map((f) => `?? ${f}`).join('\0') + '\0', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    }) as unknown as RunGit;

  it('excludes nothing when the cumulative set fits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bulk-ok-'));
    writeFileSync(join(dir, 'a.bin'), Buffer.alloc(100));
    writeFileSync(join(dir, 'b.bin'), Buffer.alloc(100));
    const out = await findBulkDirtyExcess(sizedRunGit({ 'a.bin': 100, 'b.bin': 100 }), dir, 1000);
    expect(out).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('the incident shape: many individually-fine files that TOGETHER bust the cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bulk-incident-'));
    // Four 400-byte "artifacts" + one small source edit, cap 1000. Every file is
    // individually fine; only the SUM is the accident — the 2026-07-20 shape.
    const files: Record<string, number> = {};
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(dir, `artifact${i}.bin`), Buffer.alloc(400));
      files[`artifact${i}.bin`] = 400;
    }
    writeFileSync(join(dir, 'src.ts'), Buffer.alloc(20));
    files['src.ts'] = 20;

    const out = await findBulkDirtyExcess(sizedRunGit(files), dir, 1000);
    expect(out.length).toBeGreaterThan(0);
    const excludedPaths = out.map((f) => f.path);
    // The genuine source edit still commits this tick — quarantine, don't stall.
    expect(excludedPaths).not.toContain('src.ts');
    expect(excludedPaths.every((p) => p.startsWith('artifact'))).toBe(true);
    expect(out.every((f) => f.exclusionReason === 'cumulative-limit')).toBe(true);
    const remaining = 1620 - out.reduce((n, f) => n + f.sizeBytes, 0);
    expect(remaining).toBeLessThanOrEqual(1000);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not double-count files already excluded by the per-file cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bulk-dedup-'));
    writeFileSync(join(dir, 'huge.bin'), Buffer.alloc(900));
    writeFileSync(join(dir, 'small.bin'), Buffer.alloc(50));
    // huge.bin is already excluded upstream, so its bytes are NOT being
    // committed and must not drive a second exclusion.
    const out = await findBulkDirtyExcess(
      sizedRunGit({ 'huge.bin': 900, 'small.bin': 50 }),
      dir,
      100,
      new Set(['huge.bin']),
    );
    expect(out).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * EI-21906459740652039 — the peel's ORDER, not its threshold.
 *
 * The guard above was correct and still starved this repo, because it peeled purely
 * largest-first on the premise that "a bulk accident is dominated by a few big
 * artifacts while genuine source edits are small". The largest dirty-file class here
 * is not an accident: it is the generated docs mirror (measured 2026-08-30: 81 of 95
 * dirty files, and all 20 of the largest). So every time the cap tripped, largest-
 * first peeled essentially the whole mirror — a `npm run docs:rebuild` sat uncommitted
 * for 13h while git-sync reported success and the served docs went stale under every
 * agent that read them.
 *
 * These pin BOTH directions, because a fix that only stopped peeling generated output
 * would have disarmed the guard: an unexpected artifact must still be peeled FIRST,
 * and a generated projection must still be peeled when peeling every unexpected
 * artifact leaves the set over the cap.
 */
describe('findBulkDirtyExcess — a declared generated projection is peeled LAST', () => {
  const DOCS = 'apps/operator/public/internal/docs';
  const runGitFor = (files: string[]): RunGit =>
    (async (args: string[]) => {
      if (args[0] === 'status') return { code: 0, stdout: files.map((f) => `?? ${f}`).join('\0') + '\0', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    }) as unknown as RunGit;

  const put = (root: string, rel: string, bytes: number, head = ''): string => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    const banner = Buffer.from(head, 'utf8');
    writeFileSync(join(root, rel), Buffer.concat([banner, Buffer.alloc(Math.max(0, bytes - banner.length))]));
    return rel;
  };

  it('peels the UNEXPECTED artifacts and leaves the generated docs mirror committable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bulk-generated-'));
    // The measured shape: the mirror files are the LARGEST, so largest-first takes
    // them first. Peeling the three unexpected artifacts (600B) is enough on its own
    // to bring 1820B under the 1400B cap, so the mirror must survive untouched.
    const files = [
      put(root, `${DOCS}/agent-insights-index.html`, 400),
      put(root, `${DOCS}/performance.html`, 400),
      put(root, `${DOCS}/pagefind/fragment/en_1a2b3c.pf_fragment`, 400),
      put(root, 'artifact-a.bin', 200),
      put(root, 'artifact-b.bin', 200),
      put(root, 'artifact-c.bin', 200),
      put(root, 'src.ts', 20),
    ];
    const out = await findBulkDirtyExcess(runGitFor(files), root, 1400);
    const peeled = out.map((f) => f.path);
    expect([...peeled].sort()).toEqual(['artifact-a.bin', 'artifact-b.bin', 'artifact-c.bin']);
    expect(peeled.some((p) => p.startsWith(DOCS))).toBe(false);
    expect(out.every((f) => f.exclusionReason === 'cumulative-limit')).toBe(true);
    // The cap is still honoured — this reorders the peel, it does not shrink it.
    expect(1820 - out.reduce((n, f) => n + f.sizeBytes, 0)).toBeLessThanOrEqual(1400);
    rmSync(root, { recursive: true, force: true });
  });

  it('STILL peels a generated projection when peeling every unexpected artifact is not enough', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bulk-generated-insufficient-'));
    // 1300B against a 500B cap with only 100B of unexpected artifact: the guard's real
    // purpose (never bake an unpushable range) outranks the mirror's convenience.
    const files = [
      put(root, `${DOCS}/a.html`, 400),
      put(root, `${DOCS}/b.html`, 400),
      put(root, `${DOCS}/c.html`, 400),
      put(root, 'artifact.bin', 100),
    ];
    const out = await findBulkDirtyExcess(runGitFor(files), root, 500);
    const peeled = out.map((f) => f.path);
    expect(peeled[0]).toBe('artifact.bin'); // unexpected first, always
    expect(peeled.filter((p) => p.startsWith(DOCS)).length).toBe(2);
    expect(1300 - out.reduce((n, f) => n + f.sizeBytes, 0)).toBeLessThanOrEqual(500);
    rmSync(root, { recursive: true, force: true });
  });

  it('peels a projection BEFORE small hand-written source when the mirror alone fills the cap (WI-10004416)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bulk-small-source-'));
    // The measured 2026-09-30 shape, scaled: a docs rebuild larger than the cap on
    // its own, plus ordinary source edits. Cap 250_000 → artifact threshold 1_000B.
    const cap = 250_000;
    const docs = [0, 1, 2].map((i) => put(root, `${DOCS}/page-${i}.html`, 100_000));
    const source = Array.from({ length: 10 }, (_, i) => put(root, `packages/x/src-${i}.ts`, 500));
    const out = await findBulkDirtyExcess(runGitFor([...docs, ...source]), root, cap);
    const peeled = out.map((f) => f.path);
    expect(peeled.filter((p) => p.startsWith('packages/'))).toEqual([]);
    expect(peeled.filter((p) => p.startsWith(DOCS)).length).toBe(1);
    expect(305_000 - out.reduce((n, f) => n + f.sizeBytes, 0)).toBeLessThanOrEqual(cap);
    rmSync(root, { recursive: true, force: true });
  });

  it('still peels an ARTIFACT-sized non-projection before any projection (the WI-5738 accident class)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bulk-artifact-first-'));
    const cap = 250_000;
    const docs = [0, 1].map((i) => put(root, `${DOCS}/page-${i}.html`, 100_000));
    const artifact = put(root, 'extracted/blob.bin', 80_000);
    const source = put(root, 'packages/x/src.ts', 500);
    // 280_500 total: peeling the 80_000B artifact alone brings it under the cap.
    const out = await findBulkDirtyExcess(runGitFor([...docs, artifact, source]), root, cap);
    expect(out.map((f) => f.path)).toEqual([artifact]);
    rmSync(root, { recursive: true, force: true });
  });

  it('pins the artifact threshold to ~1MB at the production 250MB cap', () => {
    expect(bulkArtifactMinBytes(250 * 1024 * 1024)).toBe(Math.floor((250 * 1024 * 1024) / 250));
    expect(bulkArtifactMinBytes(250 * 1024 * 1024)).toBeGreaterThan(900 * 1024);
    expect(bulkArtifactMinBytes(1)).toBe(1);
  });

  it('is SELF-ARMING: a file whose own header declares it generated is deprioritised too', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bulk-generated-banner-'));
    const files = [
      put(root, 'packages/x/tokens.css', 400, '/* GENERATED by style-dictionary — DO NOT EDIT. */\n'),
      put(root, 'artifact.bin', 300),
      put(root, 'hand-written.ts', 300),
    ];
    // 1000B, cap 500 → shed 500. The two hand-written files are exactly enough.
    const out = await findBulkDirtyExcess(runGitFor(files), root, 500);
    expect(out.map((f) => f.path).sort()).toEqual(['artifact.bin', 'hand-written.ts']);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('declaresGeneratedBanner', () => {
  it('needs BOTH tokens on ONE line', () => {
    expect(declaresGeneratedBanner('// GENERATED FILE — DO NOT EDIT\n')).toBe(true);
    expect(declaresGeneratedBanner("# Generated by gen:borrowable. Don't edit.\n")).toBe(true);
    // "do not edit" alone is prose about something else; "generated" alone is any file
    // that merely discusses generation.
    expect(declaresGeneratedBanner('// do not edit this test without reading the plan\n')).toBe(false);
    expect(declaresGeneratedBanner('// this module is generated at runtime from the registry\n')).toBe(false);
  });

  it('ignores a banner buried inside a long minified line (the .js.map false positive)', () => {
    const minified = `{"version":3,"sourcesContent":["${'x'.repeat(400)} GENERATED — DO NOT EDIT ${'y'.repeat(400)}"]}`;
    expect(minified.length).toBeGreaterThan(300);
    expect(declaresGeneratedBanner(minified)).toBe(false);
  });

  it('only looks at the HEAD of the file', () => {
    expect(declaresGeneratedBanner(`${'\n'.repeat(40)}// GENERATED — DO NOT EDIT\n`)).toBe(false);
  });
});
