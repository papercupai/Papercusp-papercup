/**
 * The git-sync content guard (git-sync-content-guard-2026-06-13 P-001/P-008).
 *
 * Pure + seam-injected (runGit, readText, detectors) — no real repo, no fs. Pins
 * the load-bearing behavior:
 *   - parses the `--porcelain -z -uall` dirty list (skips deletions, resolves
 *     rename pairs), runs only the detectors whose scope matches each path;
 *   - reads ONLY files at least one detector targets (no fs cost for the rest);
 *   - FAILS OPEN — a detector or a read that THROWS is skipped, never an offender
 *     (a content-check bug must never wedge the whole tree's commit).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  contentSnapshotHash,
  detectContentOffenders,
  detectUnscannedStagedOffenders,
  parseDirtyPaths,
} from './content-guard';
import {
  DEFAULT_CONTENT_DETECTORS,
  setContentLintExemptionLoader,
  type ContentDetector,
} from '../../content-lint/registry';
import type { RunGit } from './run-git-sync';
import type { RunGitStdin } from '../../sync/pot-git/storage';

/** A runGit that answers `status --porcelain -z -uall` with the given NUL-joined entries. */
const statusRunGit = (entries: string[]): RunGit =>
  async (args) =>
    args[0] === 'status'
      ? { code: 0, stdout: entries.join('\0') + (entries.length ? '\0' : ''), stderr: '' }
      : { code: 0, stdout: '', stderr: '' };

/** A detector that flags any file whose text contains `BROKEN`. */
const makeDetector = (over: Partial<ContentDetector> = {}): ContentDetector => ({
  key: 'fake',
  glob: '**/*.mdx',
  matches: (f) => f.endsWith('.mdx'),
  detect: (_f, text) => (text.includes('BROKEN') ? 'is broken' : null),
  fixerRole: 'content-fixer',
  ...over,
});

describe('parseDirtyPaths', () => {
  it('extracts dirty paths, skipping deletions and resolving -z rename pairs', () => {
    const z = [' M src/a.ts', '?? docs/x.mdx', ' D gone.ts', 'R  new.ts\0old.ts'].join('\0') + '\0';
    // The rename entry "R  new.ts" is followed by its origin "old.ts" as a separate
    // \0 field; parseDirtyPaths keeps `new.ts` and skips `old.ts` + the deletion.
    expect(parseDirtyPaths(z)).toEqual(['src/a.ts', 'docs/x.mdx', 'new.ts']);
  });

  it('returns [] for an empty porcelain output', () => {
    expect(parseDirtyPaths('')).toEqual([]);
  });
});

describe('detectContentOffenders', () => {
  const base = { repoPath: '/repo', detectors: [makeDetector()] };

  it('flags a dirty file the detector rejects, carrying file + key + error + fixerRole', async () => {
    const offenders = await detectContentOffenders({
      ...base,
      runGit: statusRunGit(['?? docs/bad.mdx', ' M docs/ok.mdx']),
      readText: async (rel) => (rel === 'docs/bad.mdx' ? 'this is BROKEN' : 'this is fine'),
    });
    expect(offenders).toEqual([
      {
        file: 'docs/bad.mdx',
        detectorKey: 'fake',
        error: 'is broken',
        fixerRole: 'content-fixer',
        contentHash: '7ef4b019b3468bd27eb670fd08ca39965538efad9f97b6b9d91d094d592dc16e',
        detectorResultHash: 'b7a9c0767ae3212039079344aa4e72bf4e41cb0e5b6063579f7d14f20591c407',
      },
    ]);
  });

  it('reads ONLY files a detector targets (no fs cost for the rest)', async () => {
    const readText = vi.fn(async () => 'clean');
    await detectContentOffenders({
      ...base,
      runGit: statusRunGit([' M src/a.ts', '?? docs/x.mdx', ' M src/b.tsx']),
      readText,
    });
    // only the .mdx matched the detector → only it was read
    expect(readText).toHaveBeenCalledTimes(1);
    expect(readText).toHaveBeenCalledWith('docs/x.mdx');
  });

  it('FAILS OPEN — a detector that THROWS is skipped, never an offender', async () => {
    const log = vi.fn();
    const offenders = await detectContentOffenders({
      ...base,
      detectors: [makeDetector({ detect: () => { throw new Error('detector bug'); } })],
      runGit: statusRunGit(['?? docs/x.mdx']),
      readText: async () => 'BROKEN',
      log,
    });
    expect(offenders).toEqual([]); // the throw did not become a blocking offender
    expect(log).toHaveBeenCalledWith(expect.stringContaining('threw'));
  });

  it('FAILS OPEN — a file that cannot be read is skipped (null), not an offender', async () => {
    const offenders = await detectContentOffenders({
      ...base,
      runGit: statusRunGit(['?? docs/x.mdx']),
      readText: async () => null, // gone / binary / permission
    });
    expect(offenders).toEqual([]);
  });

  it('runs MULTIPLE matching detectors over one file and collects every hit', async () => {
    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: [
        makeDetector({ key: 'a', detect: () => 'err-a' }),
        makeDetector({ key: 'b', detect: () => 'err-b' }),
      ],
      runGit: statusRunGit(['?? docs/x.mdx']),
      readText: async () => 'anything',
    });
    expect(offenders.map((o) => o.detectorKey).sort()).toEqual(['a', 'b']);
  });

  it('is a no-op (empty) when no detectors are registered', async () => {
    const readText = vi.fn(async () => 'x');
    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: [],
      runGit: statusRunGit(['?? docs/x.mdx']),
      readText,
    });
    expect(offenders).toEqual([]);
    expect(readText).not.toHaveBeenCalled();
  });

  it('fails open when `git status` itself errors (returns no offenders)', async () => {
    const offenders = await detectContentOffenders({
      ...base,
      runGit: async () => ({ code: 1, stdout: '', stderr: 'fatal' }),
      readText: async () => 'BROKEN',
    });
    expect(offenders).toEqual([]);
  });
});

/**
 * WI-6683 — the sweep-level proof, run against the REAL production registry
 * rather than a fake detector: a file that does not PARSE is quarantined out of
 * the auto-commit while every healthy file in the same dirty set still commits.
 *
 * This is the property that was missing when two unparseable projection modules
 * were auto-committed to `staging` on 2026-08-01 and hard-failed every other
 * agent's typecheck. Asserted through the real registry on purpose: a test that
 * injected its own detector would still pass if the detector were never
 * REGISTERED, which is precisely the failure mode here (a guard that exists but
 * runs on no blocking path is not a guard).
 */
describe('detectContentOffenders — the real registry quarantines an unparseable .ts (WI-6683)', () => {
  // Built from single-quoted lines so this test file itself always parses.
  const BROKEN_TS = [
    'export const q = sql`',
    '  select id from things',
    '  -- filter on the `kind` column',
    '`;',
    'export function stillHere() { return 1; }',
  ].join('\n');
  const HEALTHY_TS = 'export function fine(): number {\n  return 1;\n}\n';

  const sweep = (files: Record<string, string>) =>
    detectContentOffenders({
      repoPath: '/repo',
      detectors: DEFAULT_CONTENT_DETECTORS,
      runGit: statusRunGit(Object.keys(files).map((f) => ` M ${f}`)),
      readText: async (rel) => files[rel] ?? null,
    });

  it('excludes ONLY the unparseable file, and reports why', async () => {
    const offenders = await sweep({
      'packages/operator-core/lib/broken.ts': BROKEN_TS,
      'packages/operator-core/lib/healthy.ts': HEALTHY_TS,
    });
    // The healthy file is untouched by the guard — it still commits this tick.
    const excluded = [...new Set(offenders.map((o) => o.file))];
    expect(excluded).toEqual(['packages/operator-core/lib/broken.ts']);

    const hit = offenders.find((o) => o.detectorKey === 'ts-parse');
    expect(hit).toBeDefined();
    expect(hit!.error).toContain('TypeScript parse error');
    expect(hit!.fixerRole).toBe('content-fixer');
  });

  it('leaves a dirty set of healthy .ts/.tsx entirely alone (no false quarantine)', async () => {
    const offenders = await sweep({
      'packages/operator-core/lib/a.ts': HEALTHY_TS,
      'apps/operator/components/B.tsx': 'export const B = () => <div>ok</div>;\n',
      // Parses fine, would fail tsc — must NOT be quarantined (syntactic-only).
      'packages/operator-core/lib/c.ts': "import { gone } from './nowhere';\nexport const n: number = gone;\n",
    });
    expect(offenders).toEqual([]);
  });
});

/**
 * EI-19393386475030577 — the RECURRENCE GUARD for the raw-NUL class.
 *
 * The NUL check itself was never missing; it existed, was tree-wide, and was
 * green throughout. What was missing is that its only firing point was the
 * green-checkpoint suite ~55min downstream, so one author's typo red-pinned the
 * shared gate for the whole fleet (measured 2026-08-03: ~1h blocked, and six
 * prior instances documented in the class header).
 *
 * These tests run against the REAL production registry for the same reason
 * WI-6683's do: a test injecting its own detector would still pass if the
 * detector were never REGISTERED — which is exactly the regression to prevent
 * here. If someone drops `nulBytesDetector` from DEFAULT_CONTENT_DETECTORS, the
 * class silently reverts to gate-only and this fails.
 */
describe('detectContentOffenders — raw NUL is repaired at git-sync, not at the gate (EI-19393386475030577)', () => {
  // Built numerically so THIS test file never contains a raw NUL of its own
  // (a literal here would trip the very lint under test).
  const NUL = String.fromCharCode(0);
  const withNul = `export const key = \`\${a}${NUL}\${b}\`;\n`;
  const repaired = 'export const key = `${a}\\x00${b}`;\n';

  it('AUTO-REPAIRS the file in place so it commits this tick — no offender, no LLM fixer', async () => {
    const files: Record<string, string> = { 'packages/operator-core/lib/keys.ts': withNul };
    const writes: Array<{ file: string; text: string }> = [];

    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: DEFAULT_CONTENT_DETECTORS,
      runGit: statusRunGit([' M packages/operator-core/lib/keys.ts']),
      readText: async (rel) => files[rel] ?? null,
      writeText: async (rel, text) => {
        writes.push({ file: rel, text });
        files[rel] = text;
      },
    });

    // Repaired, not quarantined — the whole point: the author's tick still commits.
    expect(offenders).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toBe(repaired);
    // And the repair is real: no NUL survives anywhere in the written content.
    expect(writes[0].text.includes(NUL)).toBe(false);
  });

  it('QUARANTINES with an actionable message when auto-repair is unavailable (no writeText)', async () => {
    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: DEFAULT_CONTENT_DETECTORS,
      runGit: statusRunGit([' M packages/operator-core/lib/keys.ts']),
      readText: async () => withNul,
    });

    const hit = offenders.find((o) => o.detectorKey === 'nul-bytes');
    expect(hit).toBeDefined();
    expect(hit!.file).toBe('packages/operator-core/lib/keys.ts');
    expect(hit!.error).toContain('NUL byte');
    // Names the line so the fix is one jump away, and prescribes the escape.
    expect(hit!.error).toContain('line 1');
    expect(hit!.error).toContain('\\x00');
    expect(hit!.fixerRole).toBe('content-fixer');
  });

  it('covers `_retired/`, which the sibling detectors deliberately exclude', async () => {
    // The CI script and the gate lint both scan _retired/ (no retired-tree
    // exclusion in either). If the guard excluded it, a NUL there would slip
    // through git-sync and STILL red the shared gate — the exact gap being closed.
    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: DEFAULT_CONTENT_DETECTORS,
      runGit: statusRunGit([' M _retired/papercup/keys.ts']),
      readText: async () => withNul,
    });
    expect(offenders.some((o) => o.detectorKey === 'nul-bytes')).toBe(true);
  });

  it('skips fixture/snapshot dirs, where a NUL is legitimate test data', async () => {
    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: DEFAULT_CONTENT_DETECTORS,
      runGit: statusRunGit([
        ' M packages/operator-core/lib/__fixtures__/binary.ts',
        ' M packages/operator-core/lib/fixtures/sample.json',
      ]),
      readText: async () => withNul,
    });
    expect(offenders.filter((o) => o.detectorKey === 'nul-bytes')).toEqual([]);
  });

  it('leaves clean sources alone (no false quarantine, no spurious write)', async () => {
    const writeText = vi.fn(async () => {});
    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: DEFAULT_CONTENT_DETECTORS,
      runGit: statusRunGit([' M packages/operator-core/lib/ok.ts', ' M docs/ok.md']),
      readText: async () => 'export const k = `${a}\\x00${b}`;\n',
      writeText,
    });
    expect(offenders.filter((o) => o.detectorKey === 'nul-bytes')).toEqual([]);
    expect(writeText).not.toHaveBeenCalled();
  });
});

/**
 * EI-21230011589307899 — the RECURRENCE GUARD for the commit-time SECRETS class.
 *
 * The third sibling of the two blocks above, and the one whose miss is the only
 * UNRECOVERABLE one here. ts-parse and nul-bytes guard a BUILD: a miss ships a
 * broken file and the fix is another commit. This guards git HISTORY — a
 * credential-shaped blob that lands in a commit freezes this pot's p2p egress
 * permanently, because pot-git's own-head publish guard re-scans `(baseline,
 * head]` and its baseline never advances past a refused range. Editing the file
 * afterwards does not remove the earlier blob; only a path exemption clears it.
 *
 * ⚠ WHY THIS BLOCK EXISTS AT ALL, given secrets.test.ts already has wiring tests.
 * Those assert the detector is present in the `DEFAULT_CONTENT_DETECTORS` ARRAY.
 * That is a weaker claim than it looks: it would still pass if the guard consumed
 * a different list, or if the credential shape never survived the guard's own
 * path filtering and read seam. The claim that actually matters is END-TO-END —
 * a credential-shaped DIRTY FILE, swept by the real `detectContentOffenders`
 * with the real registry, comes back excluded from the commit. Only this block
 * makes that claim, which is the same reason WI-6683's and EI-19393386475030577's
 * blocks run against the production registry rather than an injected detector.
 *
 * ⚠ EVERY CREDENTIAL-SHAPED FIXTURE HERE IS ASSEMBLED AT RUNTIME — the same
 * load-bearing technique as secrets.test.ts. A literal shape in this file's TEXT
 * would be caught by the very scanner under test the moment git-sync swept the
 * tree, freezing egress at this blob. Keeping it split means this file needs no
 * exemption entry, and an exemption is a permanent security waiver where this is
 * only a formatting choice.
 */
describe('detectContentOffenders — a credential shape is quarantined before it enters history (EI-21230011589307899)', () => {
  /** AWS-access-key-shaped, assembled so this file's own text never carries the
   *  contiguous shape. NOT suffixed `EXAMPLE`: the scanner treats AWS's reserved
   *  docs suffix as a documented example, which would make this silently non-matching. */
  const awsShape = (): string => 'AK' + 'IA' + 'QRSTUVWXYZ234567';
  const CREDENTIAL_TS = `export const id = '${awsShape()}';\n`;
  const CLEAN_TS = 'export const id = process.env.AWS_ACCESS_KEY_ID;\n';
  const DIRTY = 'apps/operator/lib/thing.ts';

  /** The guard reaches the runtime exemption reader through the detector, so it is
   *  stubbed for determinism — unstubbed it would issue a real database read. */
  const withExemptions = (paths: string[] = []) =>
    setContentLintExemptionLoader(async () => new Set(paths));

  afterEach(() => setContentLintExemptionLoader());

  const sweep = (
    files: Record<string, string>,
    detectors = DEFAULT_CONTENT_DETECTORS,
    writeText?: (relPath: string, text: string) => Promise<void>,
  ) =>
    detectContentOffenders({
      repoPath: '/repo',
      detectors,
      runGit: statusRunGit(Object.keys(files).map((f) => ` M ${f}`)),
      readText: async (rel) => files[rel] ?? null,
      writeText,
    });

  it('QUARANTINES the credential-shaped file, naming the class and the fixer', async () => {
    withExemptions();
    const offenders = await sweep({ [DIRTY]: CREDENTIAL_TS });

    const hit = offenders.find((o) => o.detectorKey === 'secrets');
    expect(hit).toBeDefined();
    expect(hit!.file).toBe(DIRTY);
    expect(hit!.error).toContain('credential-shaped content would enter git history');
    expect(hit!.error).toContain('aws-access-key-id');
    expect(hit!.fixerRole).toBe('content-fixer');
  });

  /**
   * The NEGATIVE CONTROL, and the reason the assertion above is not self-fulfilling.
   *
   * It runs the identical sweep with `secrets` filtered OUT of the real registry
   * and asserts the same file comes back clean. That pins the quarantine to THIS
   * detector's registration rather than to some sibling incidentally flagging the
   * file — the failure mode a positive-only test cannot distinguish. It is also
   * this block's falsifiability proof: it demonstrates in-file, permanently, and
   * on every run that the assertion above has teeth, without mutating tracked
   * source on an auto-committing tree, where there is no safe temporary mutation.
   */
  it('CONTROL: the same file is NOT quarantined once `secrets` is dropped from the registry', async () => {
    withExemptions();
    const withoutSecrets = DEFAULT_CONTENT_DETECTORS.filter((d) => d.key !== 'secrets');
    // The control must actually remove something, or it passes vacuously.
    expect(withoutSecrets).toHaveLength(DEFAULT_CONTENT_DETECTORS.length - 1);

    expect(await sweep({ [DIRTY]: CREDENTIAL_TS }, withoutSecrets)).toEqual([]);
  });

  it('NEVER auto-repairs — a credential-shaped rewrite must be read before it is applied', async () => {
    withExemptions();
    const writeText = vi.fn(async () => {});
    const offenders = await sweep({ [DIRTY]: CREDENTIAL_TS }, DEFAULT_CONTENT_DETECTORS, writeText);

    // Unlike nul-bytes above, this class has no autoFix: quarantine, never rewrite.
    expect(offenders.some((o) => o.detectorKey === 'secrets')).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('honours a RUNTIME path exemption through the whole guard, not just direct detect()', async () => {
    // Proves the exemption reader is reachable at the seam that actually commits.
    // If it were not, an exempted file would be quarantined from commit forever.
    withExemptions(['apps/operator/lib/']);
    expect(await sweep({ [DIRTY]: CREDENTIAL_TS })).toEqual([]);
  });

  it('leaves clean sources alone (no false quarantine of ordinary credential-ADJACENT code)', async () => {
    withExemptions();
    const offenders = await sweep({
      [DIRTY]: CLEAN_TS,
      'docs/runbook.md': 'Set `AWS_ACCESS_KEY_ID` in the environment before running.\n',
    });
    expect(offenders.filter((o) => o.detectorKey === 'secrets')).toEqual([]);
  });

  it('covers a NON-source path too — the shape is not a property of a file type', async () => {
    // The historical instances were a .test.ts, a .mjs hook and a test harness;
    // no suffix filter would have caught all three, so the guard must not have one.
    withExemptions();
    const offenders = await sweep({ 'apps/operator/scripts/hooks/cc/thing.mjs': CREDENTIAL_TS });
    expect(offenders.some((o) => o.detectorKey === 'secrets')).toBe(true);
  });
});

/**
 * EI-5240 — the sweep-level proof for the esbuild-only transform class.
 *
 * Multiple default exports are accepted by TypeScript's parser and are filtered
 * out of the parse detector's type-level diagnostics, but esbuild refuses to
 * transform the module. Running the REAL registry through the REAL guard seam
 * prevents a wiring regression where the detector exists but is never applied
 * to a dirty file.
 */
describe('detectContentOffenders — the real registry quarantines an esbuild-only transform failure (EI-5240)', () => {
  const ESBUILD_ONLY_BROKEN_TS = ['export default 1;', 'export default 2;'].join('\n');

  it('excludes the transform-invalid file and reports the esbuild diagnostic', async () => {
    const file = 'packages/operator-core/lib/duplicate-default.ts';
    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: DEFAULT_CONTENT_DETECTORS,
      runGit: statusRunGit([` M ${file}`]),
      readText: async () => ESBUILD_ONLY_BROKEN_TS,
    });

    expect([...new Set(offenders.map((o) => o.file))]).toEqual([file]);
    const hit = offenders.find((o) => o.detectorKey === 'esbuild-transform');
    expect(hit).toBeDefined();
    expect(hit!.error).toMatch(/esbuild transform error at line 2/i);
    expect(hit!.error).toContain('Multiple exports with the same name');
    expect(hit!.fixerRole).toBe('content-fixer');
  });

  it('leaves the same source clean when the esbuild detector is removed', async () => {
    const file = 'packages/operator-core/lib/duplicate-default.ts';
    const withoutEsbuild = DEFAULT_CONTENT_DETECTORS.filter((d) => d.key !== 'esbuild-transform');
    expect(withoutEsbuild).toHaveLength(DEFAULT_CONTENT_DETECTORS.length - 1);
    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: withoutEsbuild,
      runGit: statusRunGit([` M ${file}`]),
      readText: async () => ESBUILD_ONLY_BROKEN_TS,
    });
    expect(offenders).toEqual([]);
  });
});

/**
 * EI-23381057036304308 — shell output redirected into a repo-root filename is
 * not covered by the extension-scoped source detectors. Keep the exact status
 * artifact and ordinary paths as a production-registry guard.
 */
describe('detectContentOffenders — suspicious root redirect filenames', () => {
  const artifact = 'VERDICT: WORKING (cpu is being consumed)';

  it('quarantines extensionless root-level shell output artifacts', async () => {
    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: DEFAULT_CONTENT_DETECTORS,
      runGit: statusRunGit([`?? ${artifact}`]),
      readText: async (file) => (file === artifact ? '1.02067' : null),
    });

    expect([...new Set(offenders.map((o) => o.file))]).toEqual([artifact]);
    const hit = offenders.find((o) => o.detectorKey === 'root-redirect-artifact');
    expect(hit).toBeDefined();
    expect(hit!.error).toMatch(/root-level.*shell output|shell output.*root-level/i);
    expect(hit!.fixerRole).toBe('content-fixer');
  });

  it('does not quarantine normal files or nested status-like paths', async () => {
    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: DEFAULT_CONTENT_DETECTORS,
      runGit: statusRunGit([
        '?? CPU: report.md',
        '?? logs/VERDICT: WORKING (cpu is being consumed)',
      ]),
      readText: async () => 'ordinary text',
    });

    expect(offenders).toEqual([]);
  });
});

/**
 * EI-21230011589307899 — the SCAN→STAGE race. The pre-stage pass judges the dirty set,
 * then other guards and the lock census run, then `git add -A` stages whatever is dirty
 * by THEN. A file created in that window was committed unscanned: on 2026-10-13 a
 * secret-shaped test fixture reached HEAD this way and the own-head publish guard froze
 * git egress. The post-stage rescan judges exactly the staged blobs the pass never saw.
 */
describe('detectUnscannedStagedOffenders — staged blobs the pre-stage pass never judged (EI-21230011589307899)', () => {
  /** Assembled so this file's own text never carries the contiguous shape (see above). */
  const awsShape = (): string => 'AK' + 'IA' + 'QRSTUVWXYZ234567';
  const CREDENTIAL_TS = `export const id = '${awsShape()}';\n`;
  const CLEAN_TS = 'export const a = 1;\n';
  const LATE = 'packages/operator-core/lib/late-fixture.test.ts';

  /** A runner bound to a fake index: `show :<path>` answers from `index`; an absent path
   *  fails the way a staged deletion does. `status` answers the pre-stage dirty list. */
  const fakeRepo = (index: Record<string, string>, dirty: string[] = []): RunGit =>
    async (args) => {
      if (args[0] === 'show') {
        const path = args[1].slice(1);
        return path in index
          ? { code: 0, stdout: index[path], stderr: '' }
          : { code: 128, stdout: '', stderr: `fatal: path '${path}' exists on disk, but not in the index` };
      }
      if (args[0] === 'status') {
        return { code: 0, stdout: dirty.map((f) => ` M ${f}`).join('\0') + (dirty.length ? '\0' : ''), stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };

  afterEach(() => setContentLintExemptionLoader());

  it('holds a credential-shaped file staged after the pre-stage scan, with the production registry', async () => {
    setContentLintExemptionLoader(async () => new Set());
    const scanned = new Map<string, string>();
    // Pre-stage: only the clean file is dirty, so only it is judged.
    const pre = await detectContentOffenders({
      repoPath: '/repo',
      detectors: DEFAULT_CONTENT_DETECTORS,
      runGit: fakeRepo({}, ['src/clean.ts']),
      readText: async () => CLEAN_TS,
      scanned,
    });
    expect(pre).toEqual([]);
    expect(scanned).toEqual(new Map([['src/clean.ts', contentSnapshotHash(CLEAN_TS)]]));

    // The fixture lands before `git add -A`, which stages it alongside the clean file.
    const offenders = await detectUnscannedStagedOffenders({
      repoPath: '/repo',
      detectors: DEFAULT_CONTENT_DETECTORS,
      staged: ['src/clean.ts', LATE],
      scanned,
      runGit: fakeRepo({ 'src/clean.ts': CLEAN_TS, [LATE]: CREDENTIAL_TS }),
    });
    const hit = offenders.find((o) => o.detectorKey === 'secrets');
    expect(hit).toBeDefined();
    expect(hit!.file).toBe(LATE);
    expect(hit!.contentHash).toBe(contentSnapshotHash(CREDENTIAL_TS));
    expect(offenders.every((o) => o.file === LATE)).toBe(true);
  });

  it('CONTROL: the same staged set yields no secrets finding once `secrets` is dropped from the registry', async () => {
    setContentLintExemptionLoader(async () => new Set());
    const offenders = await detectUnscannedStagedOffenders({
      repoPath: '/repo',
      detectors: DEFAULT_CONTENT_DETECTORS.filter((d) => d.key !== 'secrets'),
      staged: [LATE],
      scanned: new Map(),
      runGit: fakeRepo({ [LATE]: CREDENTIAL_TS }),
    });
    expect(offenders.filter((o) => o.detectorKey === 'secrets')).toEqual([]);
  });

  it('does not re-judge a staged blob identical to the text the pre-stage pass judged', async () => {
    const detect = vi.fn((_f: string, text: string) => (text.includes('BROKEN') ? 'is broken' : null));
    const offenders = await detectUnscannedStagedOffenders({
      repoPath: '/repo',
      detectors: [makeDetector({ detect })],
      staged: ['docs/a.mdx'],
      scanned: new Map([['docs/a.mdx', contentSnapshotHash('fine')]]),
      runGit: fakeRepo({ 'docs/a.mdx': 'fine' }),
    });
    expect(offenders).toEqual([]);
    expect(detect).not.toHaveBeenCalled();
  });

  it('re-judges a path whose content changed between the scan and the add', async () => {
    const offenders = await detectUnscannedStagedOffenders({
      repoPath: '/repo',
      detectors: [makeDetector()],
      staged: ['docs/a.mdx'],
      scanned: new Map([['docs/a.mdx', contentSnapshotHash('fine')]]),
      runGit: fakeRepo({ 'docs/a.mdx': 'now BROKEN' }),
    });
    expect(offenders.map((o) => [o.file, o.detectorKey, o.error])).toEqual([['docs/a.mdx', 'fake', 'is broken']]);
  });

  it('judges the INDEX blob, not the working tree', async () => {
    // Clean on disk is irrelevant: the commit records the index.
    const offenders = await detectUnscannedStagedOffenders({
      repoPath: '/repo',
      detectors: [makeDetector()],
      staged: ['docs/a.mdx'],
      scanned: new Map(),
      runGit: fakeRepo({ 'docs/a.mdx': 'staged BROKEN' }),
    });
    expect(offenders.map((o) => o.file)).toEqual(['docs/a.mdx']);
  });

  it('skips staged deletions and paths no detector targets', async () => {
    const detect = vi.fn(() => 'would flag');
    const offenders = await detectUnscannedStagedOffenders({
      repoPath: '/repo',
      detectors: [makeDetector({ detect })],
      staged: ['docs/deleted.mdx', 'src/a.ts'],
      scanned: new Map(),
      runGit: fakeRepo({ 'src/a.ts': 'x' }),
    });
    expect(offenders).toEqual([]);
    expect(detect).not.toHaveBeenCalled();
  });

  it('FAILS OPEN — a detector that throws on a staged blob is logged, never an offender', async () => {
    const log = vi.fn();
    const offenders = await detectUnscannedStagedOffenders({
      repoPath: '/repo',
      detectors: [makeDetector({ detect: () => { throw new Error('boom'); } })],
      staged: ['docs/a.mdx'],
      scanned: new Map(),
      runGit: fakeRepo({ 'docs/a.mdx': 'BROKEN' }),
      log,
    });
    expect(offenders).toEqual([]);
    expect(log.mock.calls.flat().join('\n')).toMatch(/threw on staged docs\/a\.mdx/);
  });
});

describe('detectUnscannedStagedOffenders — bounded byte-safe private-index batches', () => {
  const files = [
    { file: 'docs/line\nbreak.mdx', oid: 'a'.repeat(40), bytes: Buffer.from('clean α\n') },
    { file: 'docs/late.mdx', oid: 'b'.repeat(40), bytes: Buffer.concat([Buffer.from('\0BROKEN\n'), Buffer.from([0xff])]) },
  ];

  const runGit: RunGit = async (args) => {
    if (args[0] === 'ls-files') {
      const requested = args.slice(args.indexOf('--') + 1);
      const rows = files.filter((entry) => requested.includes(entry.file));
      return {
        code: 0,
        stdout: rows.map((entry) => `100644 ${entry.oid} 0\t${entry.file}\0`).join(''),
        stderr: '',
      };
    }
    if (args[0] === 'show') {
      const entry = files.find((candidate) => `:${candidate.file}` === args[1]);
      return entry
        ? { code: 0, stdout: entry.bytes.toString('utf8'), stderr: '' }
        : { code: 128, stdout: '', stderr: 'missing staged path' };
    }
    return { code: 1, stdout: '', stderr: `unexpected git ${args.join(' ')}` };
  };

  const batchRunner = (calls: string[], failCheck = false): RunGitStdin => async (args, _cwd, input) => {
    calls.push(args.slice(1).join(' '));
    const oids = input.slice(0, -1).split('\n');
    if (args[1]?.startsWith('--batch-check=')) {
      if (failCheck) return { code: 1, stdout: Buffer.alloc(0), stderr: 'batch-check failed' };
      const rows = oids.map((oid) => {
        const entry = files.find((candidate) => candidate.oid === oid)!;
        return `${oid} blob ${entry.bytes.length}`;
      });
      return { code: 0, stdout: Buffer.from(`${rows.join('\n')}\n`), stderr: '' };
    }
    if (args[1] === '--batch') {
      const frames = oids.map((oid) => {
        const entry = files.find((candidate) => candidate.oid === oid)!;
        return Buffer.concat([Buffer.from(`${oid} blob ${entry.bytes.length}\n`), entry.bytes, Buffer.from('\n')]);
      });
      return { code: 0, stdout: Buffer.concat(frames), stderr: '' };
    }
    return { code: 1, stdout: Buffer.alloc(0), stderr: 'unexpected cat-file command' };
  };

  it('uses one byte-framed batch for newline paths and content containing NUL/invalid UTF-8', async () => {
    const calls: string[] = [];
    const offenders = await detectUnscannedStagedOffenders({
      runGit,
      runGitStdin: batchRunner(calls),
      repoPath: '/repo',
      staged: files.map((entry) => entry.file),
      scanned: new Map(),
      detectors: [makeDetector({ matches: () => true })],
    });

    expect(offenders.map((entry) => entry.file)).toEqual(['docs/late.mdx']);
    expect(offenders[0]?.contentHash).toBe(contentSnapshotHash(files[1]!.bytes.toString('utf8')));
    expect(calls).toEqual(['--batch-check=%(objectname) %(objecttype) %(objectsize)', '--batch --buffer']);
  });

  it('retains per-file reads when the stdin batch preflight fails', async () => {
    const calls: string[] = [];
    const shown: string[] = [];
    const fallbackRunGit: RunGit = async (args, cwd, options) => {
      if (args[0] === 'show') shown.push(args[1]!.slice(1));
      return runGit(args, cwd, options);
    };
    const offenders = await detectUnscannedStagedOffenders({
      runGit: fallbackRunGit,
      runGitStdin: batchRunner(calls, true),
      repoPath: '/repo',
      staged: files.map((entry) => entry.file),
      scanned: new Map(),
      detectors: [makeDetector({ matches: () => true })],
    });

    expect(offenders.map((entry) => entry.file)).toEqual(['docs/late.mdx']);
    expect(shown.sort()).toEqual(files.map((entry) => entry.file).sort());
    expect(calls).toEqual(['--batch-check=%(objectname) %(objecttype) %(objectsize)']);
  });

  it('keeps the 1,402-path scan bounded instead of spawning one git show per path', async () => {
    const count = 1402;
    const entries = Array.from({ length: count }, (_, index) => ({
      file: `docs/batch-${String(index).padStart(4, '0')}.md`,
      oid: index.toString(16).padStart(40, '0'),
      bytes: Buffer.from('safe\n'),
    }));
    const byPath = new Map(entries.map((entry) => [entry.file, entry]));
    const byOid = new Map(entries.map((entry) => [entry.oid, entry]));
    const indexBatchSizes: number[] = [];
    const checkBatchSizes: number[] = [];
    const blobBatchSizes: number[] = [];
    const shown: string[] = [];

    const manyPathRunGit: RunGit = async (args) => {
      if (args[0] === 'ls-files') {
        const paths = args.slice(args.indexOf('--') + 1);
        indexBatchSizes.push(paths.length);
        const stdout = paths
          .map((file) => byPath.get(file))
          .filter((entry): entry is (typeof entries)[number] => entry !== undefined)
          .map((entry) => `100644 ${entry.oid} 0\t${entry.file}\0`)
          .join('');
        return { code: 0, stdout, stderr: '' };
      }
      if (args[0] === 'show') {
        shown.push(args[1]!.slice(1));
        return { code: 1, stdout: '', stderr: 'unexpected per-file staged read' };
      }
      return { code: 1, stdout: '', stderr: `unexpected git ${args.join(' ')}` };
    };
    const manyPathRunGitStdin: RunGitStdin = async (args, _cwd, input) => {
      const oids = input.split('\n').filter(Boolean);
      if (args[1]?.startsWith('--batch-check=')) {
        checkBatchSizes.push(oids.length);
        const rows = oids.map((oid) => `${oid} blob ${byOid.get(oid)!.bytes.length}`);
        return { code: 0, stdout: Buffer.from(`${rows.join('\n')}\n`), stderr: '' };
      }
      if (args[1] === '--batch') {
        blobBatchSizes.push(oids.length);
        const frames = oids.map((oid) => {
          const entry = byOid.get(oid)!;
          return Buffer.concat([Buffer.from(`${oid} blob ${entry.bytes.length}\n`), entry.bytes, Buffer.from('\n')]);
        });
        return { code: 0, stdout: Buffer.concat(frames), stderr: '' };
      }
      return { code: 1, stdout: Buffer.alloc(0), stderr: 'unexpected cat-file command' };
    };

    const offenders = await detectUnscannedStagedOffenders({
      runGit: manyPathRunGit,
      runGitStdin: manyPathRunGitStdin,
      repoPath: '/repo',
      staged: entries.map((entry) => entry.file),
      scanned: new Map(),
      detectors: [makeDetector({ matches: () => true })],
    });

    expect(offenders).toEqual([]);
    expect(indexBatchSizes).toEqual([256, 256, 256, 256, 256, 122]);
    expect(checkBatchSizes).toEqual([1024, 378]);
    expect(blobBatchSizes).toEqual([1402]);
    expect(shown).toEqual([]);
  });
});
