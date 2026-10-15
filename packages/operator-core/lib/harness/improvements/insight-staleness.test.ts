/**
 * insight-staleness tests (learning-system-audit-improvements-2026-06-09 P-051).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';
import {
  extractCitedPaths,
  scanInsightStaleness,
  makeCitationResolver,
  makeRepoPathResolver,
  makeRepoBasenameResolver,
  listIgnoredPaths,
  collectInsightStalenessSignals,
  DEFAULT_INSIGHT_RESOLUTION_COOLDOWN_MS,
} from './insight-staleness';

const insight = (slug: string, raw: string, status = 'active') => ({ slug, status, raw });

// Keep the real filesystem/Git assertion without crossing the production
// process-admission seam, whose ledger opens Postgres (forbidden in unit tests).
const runLocalGit: typeof import('../../fleet/git-via-sidecar').execFileViaSidecar =
  (command, args, opts) => promisify(execFile)(command, args, { timeout: opts.timeoutMs });

describe('extractCitedPaths — conservative repo-file extraction', () => {
  it('keeps anchored repo files with extensions; drops globs, placeholders, URLs, dirs', () => {
    const raw = [
      'Read `packages/operator-core/lib/gym/loop.ts` and `apps/operator/lib/x.tsx`.',
      'Not these: `lib/unanchored.ts`, `packages/operator-core/lib/**`, `apps/<slug>/y.ts`,',
      '`https://example.com/a.ts`, `packages/operator-core/lib/gym` (no extension),',
      '`npm run test:affected`, `a b.ts`.',
    ].join('\n');
    expect(extractCitedPaths(raw).sort()).toEqual([
      'apps/operator/lib/x.tsx',
      'packages/operator-core/lib/gym/loop.ts',
    ]);
  });

  it('dedups repeated citations', () => {
    expect(extractCitedPaths('`libs/flags/src/types.ts` then `libs/flags/src/types.ts`')).toHaveLength(1);
  });

  it('Class 1 (EI-510): skips a path whose own line carries a removal/move marker', () => {
    expect(extractCitedPaths('The routes moved off `apps/operator/app/api/_hono/mobile.ts` onto device/*.')).toEqual([]);
    expect(extractCitedPaths('This used to live at `packages/x/old-home.ts`.')).toEqual([]);
    expect(extractCitedPaths('`packages/x/gone.ts` was removed in the migration.')).toEqual([]);
    expect(extractCitedPaths('Formerly `libs/old/thing.ts`, now elsewhere.')).toEqual([]);
    // a live citation on a clean line is still kept
    expect(extractCitedPaths('See `packages/x/live.ts` for the impl.')).toEqual(['packages/x/live.ts']);
    // a removal marker on a DIFFERENT line does not suppress a clean-line citation
    expect(extractCitedPaths('An old file was removed.\nSee `packages/x/live.ts`.')).toEqual(['packages/x/live.ts']);
  });

  it('Class 1 (EI-20565868233772131): "are all gone" is a removal marker', () => {
    // starlight-migration-2026-05-20 lists the deleted fumadocs entrypoints and ends
    // the sentence "…are all gone." Every other marker it could have used sits in a
    // NEIGHBOURING sentence, which sentence scope correctly refuses to reach — so the
    // runbook was flagged for citing two files it exists to document as deleted.
    expect(
      extractCitedPaths('`apps/operator/source.config.ts`, `apps/operator/lib/source.ts` are all gone.'),
    ).toEqual([]);
    expect(extractCitedPaths('That entrypoint is gone; use the Hono host.')).toEqual([]);

    // POSITIVE CONTROL — the guard must not have been widened into inertness: the
    // same two paths in a sentence that asserts them as LIVE are still extracted.
    expect(
      extractCitedPaths('`apps/operator/source.config.ts`, `apps/operator/lib/source.ts` are the entrypoints.').sort(),
    ).toEqual(['apps/operator/lib/source.ts', 'apps/operator/source.config.ts']);

    // …and a file whose own NAME contains the new marker word must not suppress
    // itself (backtick masking), the same hazard `removed.ts` already covers.
    expect(extractCitedPaths('See `packages/x/gone.ts` for the impl.')).toEqual(['packages/x/gone.ts']);
  });

  it('a WEAK marker is sentence-local: it never erases the same path cited cleanly elsewhere', () => {
    // Measured over all 784 insights (EI-20565868233772131): treating `gone` as a
    // STRONG marker retired 2 false positives but HID 2 real ones, because the
    // per-PATH rule erased live citations from docs that also use "gone" about a
    // network peer. `pg-connection-exhaustion-too-many-clients` is the real shape:
    const doc = [
      'The pool size comes from `libs/papercusp/libs/db/src/connection.ts`.',
      '',
      'A backend whose client is gone still holds a slot; `libs/papercusp/libs/db/src/connection.ts` sets the check interval.',
    ].join('\n');
    expect(extractCitedPaths(doc)).toEqual(['libs/papercusp/libs/db/src/connection.ts']);

    // …whereas a STRONG marker keeps its doc-wide reach (EI-510, unchanged).
    const strong = [
      'The pool size comes from `libs/papercusp/libs/db/src/connection.ts`.',
      '',
      '`libs/papercusp/libs/db/src/connection.ts` was removed in the migration.',
    ].join('\n');
    expect(extractCitedPaths(strong)).toEqual([]);

    // A path whose ONLY occurrence is weak-marked is still dropped — that is the
    // starlight-migration case this whole change exists for.
    expect(extractCitedPaths('`apps/operator/source.config.ts` and friends are all gone.')).toEqual([]);
  });

  it('KNOWN LIMIT: a marker suppresses EVERY path in its sentence, live ones included', () => {
    // Sentence scope binds a marker to the whole sentence, not to the nearest path,
    // so a sentence mixing a live and a removed citation suppresses both. This is the
    // module's stated bias (a missed citation is fine; a false "stale" capture is
    // noise), and it is NOT specific to any one marker word — `removed` has always
    // behaved this way. Pinned so the next reader finds it documented rather than
    // rediscovering it through a fixture that mysteriously stops producing a signal.
    expect(extractCitedPaths('Live `libs/flags/src/types.ts`, removed `packages/x/a.ts`.')).toEqual([]);
    expect(extractCitedPaths('Live `libs/flags/src/types.ts`, gone `packages/x/a.ts`.')).toEqual([]);
    // Splitting them into separate sentences is what preserves the live citation.
    expect(
      extractCitedPaths('`packages/x/a.ts` is gone. Live `libs/flags/src/types.ts` stays.'),
    ).toEqual(['libs/flags/src/types.ts']);
  });

  it('drops ellipsis path placeholders (EI-510): `.../` is an elision, not a real file', () => {
    expect(extractCitedPaths('Each route under `apps/operator/app/.../page.tsx` is retired.')).toEqual([]);
    expect(extractCitedPaths('See `packages/operator-core/lib/../oops.ts`.')).toEqual([]);
  });

  it('drops node_modules dependency paths (EI-510): not repo source', () => {
    expect(extractCitedPaths('Patched `apps/operator/node_modules/vditor/dist/types/index.d.ts`.')).toEqual([]);
  });

  it('Class 1 per-PATH (EI-510): a path acknowledged removed ANYWHERE is dropped even if also cited on a clean line', () => {
    const raw = 'Example (`apps/x/gone.ts`):\nNote: `apps/x/gone.ts` was removed in the migration.';
    expect(extractCitedPaths(raw)).toEqual([]);
    // a different, never-acknowledged path on a clean line is still kept
    const mixed = 'Use `apps/x/live.ts`.\nThe old `apps/x/gone.ts` was removed.';
    expect(extractCitedPaths(mixed)).toEqual(['apps/x/live.ts']);
  });
});

describe('extractCitedPaths — removal marker is SENTENCE-scoped (EI-18680208809300804)', () => {
  // Verbatim shape from plans-egress-is-poll-frequency-not-payload: the path ends
  // a line and its "(deleted …)" acknowledgement wraps onto the next one. A
  // line-scoped test cannot see the marker, so the insight was flagged stale for
  // citing a file it explicitly documents as deleted.
  const WRAPPED = [
    '- Meta-gotcha that stalled this diagnosis: `libs/generic/sync/src/transports/polling/batch-fetcher.ts`',
    '  (deleted 2026-07-26; the delta wiring now lives in its replacement, `query-fetcher.ts`)',
    '  contained a raw NUL byte, so ripgrep classified it BINARY.',
  ].join('\n');

  it('drops a path whose removal marker wrapped onto the NEXT line', () => {
    expect(extractCitedPaths(WRAPPED)).not.toContain(
      'libs/generic/sync/src/transports/polling/batch-fetcher.ts',
    );
  });

  it('CONTROL: the same path with NO marker anywhere is still extracted', () => {
    // Guards against the widened scope simply swallowing everything.
    const noMarker = [
      '- Meta-gotcha that stalled this diagnosis: `libs/generic/sync/src/transports/polling/batch-fetcher.ts`',
      '  contained a raw NUL byte, so ripgrep classified it BINARY.',
    ].join('\n');
    expect(extractCitedPaths(noMarker)).toContain(
      'libs/generic/sync/src/transports/polling/batch-fetcher.ts',
    );
  });

  it('a marker in a PRECEDING sentence, same paragraph, does not suppress (why not paragraph scope)', () => {
    // The case that rules out simply widening to the paragraph: one paragraph,
    // two sentences, and the marker is about some other file.
    expect(
      extractCitedPaths('An old file was removed.\nSee `packages/x/live.ts`.'),
    ).toEqual(['packages/x/live.ts']);
  });

  it("a filename containing a marker word does not suppress itself", () => {
    // Backticked spans are masked before the marker test, so `removed.ts` is inert.
    expect(extractCitedPaths('See `packages/x/removed.ts` for the impl.')).toEqual([
      'packages/x/removed.ts',
    ]);
  });

  it('does NOT reach across a blank line into a different paragraph', () => {
    // The marker belongs to a separate paragraph, so it must not suppress here —
    // this is the over-suppression the paragraph scope has to stop short of.
    const separated = [
      'The old loader was `packages/operator-core/lib/gone.ts`, which we removed.',
      '',
      'The live one is `packages/operator-core/lib/still-here.ts`.',
    ].join('\n');
    const cited = extractCitedPaths(separated);
    expect(cited).toContain('packages/operator-core/lib/still-here.ts');
    expect(cited).not.toContain('packages/operator-core/lib/gone.ts');
  });
});

describe('scanInsightStaleness', () => {
  const exists = (present: string[]) => (p: string) => present.includes(p);

  it('signals an active insight citing a missing file; stable title + kind=change', () => {
    const signals = scanInsightStaleness(
      [insight('gone-runbook', 'See `packages/operator-core/lib/old/removed.ts` for the fix.')],
      exists([]),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('insight-staleness');
    expect(signals[0].key).toBe('gone-runbook');
    expect(signals[0].kind).toBe('change');
    expect(signals[0].severity).toBe('minor');
    expect(signals[0].title).not.toMatch(/\d/); // no counts in the stable title
    expect(signals[0].body).toContain('packages/operator-core/lib/old/removed.ts');
    expect(signals[0].paths).toEqual(['apps/operator-docs/src/content/docs/agent-insights/gone-runbook.mdx']);
  });

  it('stays silent for: all-paths-exist, retired/superseded, and no-citations insights', () => {
    const signals = scanInsightStaleness(
      [
        insight('healthy', 'See `libs/flags/src/types.ts`.'),
        insight('retired-one', 'See `packages/x/missing.ts`.', 'retired'),
        insight('superseded-one', 'See `packages/x/missing.ts`.', 'superseded'),
        insight('prose-only', 'No code citations here at all.'),
      ],
      exists(['libs/flags/src/types.ts']),
    );
    expect(signals).toHaveLength(0);
  });

  it('caps signals per sweep', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      insight(`stale-${i}`, `See \`packages/x/missing-${i}.ts\`.`),
    );
    expect(scanInsightStaleness(many, exists([]), { maxSignals: 3 })).toHaveLength(3);
  });

  it('classifies all-citations-missing as apoptotic (supersede) vs partial as repoint-review (EI-441)', () => {
    const [apoptotic] = scanInsightStaleness(
      [insight('all-gone', 'Only `packages/x/gone-a.ts` and `packages/x/gone-b.ts` here.')],
      exists([]),
    );
    expect(apoptotic.title).toMatch(/obsolete .* all cited files are gone/i);
    expect(apoptotic.body).toMatch(/every citation is gone/i);
    expect(apoptotic.body).toMatch(/status: superseded/);
    expect(apoptotic.title).not.toMatch(/\d/); // still a stable, count-free title

    // The prose deliberately carries NO removal marker: this fixture's point is the
    // partial-missing CLASSIFICATION, and any marker word would suppress every path
    // in its sentence (see the mixed-sentence test below), leaving nothing to classify.
    const [partial] = scanInsightStaleness(
      [insight('one-moved', 'Live `libs/flags/src/types.ts` plus `packages/x/vanished.ts`.')],
      exists(['libs/flags/src/types.ts']),
    );
    expect(partial.title).toMatch(/cites files that no longer exist/i);
    expect(partial.title).not.toMatch(/obsolete/i);
  });

  it('does not flag an insight whose only citation is a historical removal-marker reference (EI-510 Class 1)', () => {
    const signals = scanInsightStaleness(
      [insight('migration-note', 'The handler moved off `packages/x/old-home.ts` to the new module.')],
      exists([]),
    );
    expect(signals).toEqual([]);
  });

  it('Class-2 guard (EI-510): downgrades apoptotic supersede→repoint when a missing path basename exists elsewhere', () => {
    const basenameExistsFn = makeRepoBasenameResolver([
      'packages/operator-core/lib/a.ts',
      'packages/operator-core/lib/b.ts',
    ]);
    // Both citations missing by the strict suffix check, but their basenames exist
    // elsewhere → path-prefix drift, NOT a vanished evidence base → repoint, not supersede.
    const [downgraded] = scanInsightStaleness(
      [insight('prefix-drift', 'Edit `packages/old/a.ts` and `packages/old/b.ts`.')],
      exists([]),
      { basenameExistsFn },
    );
    expect(downgraded.title).toMatch(/cites files that no longer exist/i);
    expect(downgraded.title).not.toMatch(/obsolete/i);

    // Without the guard, the same all-missing input stays apoptotic (legacy behavior).
    const [legacy] = scanInsightStaleness(
      [insight('prefix-drift', 'Edit `packages/old/a.ts` and `packages/old/b.ts`.')],
      exists([]),
    );
    expect(legacy.title).toMatch(/obsolete .* all cited files are gone/i);

    // A genuinely-vanished basename stays apoptotic even with the guard present.
    const [vanished] = scanInsightStaleness(
      [insight('all-gone', 'Only `packages/x/really-vanished.ts` here.')],
      exists([]),
      { basenameExistsFn },
    );
    expect(vanished.title).toMatch(/obsolete .* all cited files are gone/i);
  });

  it('stamps a resolution cooldown on every signal — default + override (EI-427 deploy-lag suppressor)', () => {
    const [def] = scanInsightStaleness([insight('s', 'See `packages/x/gone.ts`.')], exists([]));
    expect(def.resolutionCooldownMs).toBe(DEFAULT_INSIGHT_RESOLUTION_COOLDOWN_MS);

    const [overridden] = scanInsightStaleness(
      [insight('s', 'See `packages/x/gone.ts`.')],
      exists([]),
      { resolutionCooldownMs: 1000 },
    );
    expect(overridden.resolutionCooldownMs).toBe(1000);
  });
});

describe('makeRepoPathResolver — suffix-aware existence (EI-510 dropped-prefix shorthand)', () => {
  const tracked = [
    'apps/operator/bin/hono-host.ts',
    'packages/operator-core/lib/loopback-fetch.ts',
    'libs/flags/src/types.ts',
  ];

  it('resolves an exact tracked path', () => {
    expect(makeRepoPathResolver(tracked)('libs/flags/src/types.ts')).toBe(true);
  });

  it('resolves a dropped-prefix shorthand as a path-suffix of a real file', () => {
    // `bin/hono-host.ts` is shorthand for `apps/operator/bin/hono-host.ts`.
    expect(makeRepoPathResolver(tracked)('bin/hono-host.ts')).toBe(true);
    expect(makeRepoPathResolver(tracked)('operator-core/lib/loopback-fetch.ts')).toBe(true);
  });

  it('does NOT resolve a genuinely-absent file (no exact, no suffix)', () => {
    expect(makeRepoPathResolver(tracked)('packages/x/really-gone.ts')).toBe(false);
  });

  it('a basename match that is not a whole-component suffix does not over-resolve', () => {
    // real path ends `/lib/loopback-fetch.ts`, NOT `/core/loopback-fetch.ts`.
    expect(makeRepoPathResolver(tracked)('core/loopback-fetch.ts')).toBe(false);
  });
});

describe('makeCitationResolver — gitignored runtime artifacts are not "missing" (EI-16474)', () => {
  const tracked = ['apps/operator/lib/spa-build-status.ts'];
  // The artifact that exposed this: written beside dist/ ONLY by a failed build,
  // so it is never tracked and is absent exactly when the tree is healthy.
  const ARTIFACT = 'apps/operator-vite/.vite-build-failure.json';

  it('resolves a gitignored path that is ABSENT from disk', () => {
    const resolve = makeCitationResolver({
      trackedFiles: tracked,
      ignoredPaths: [ARTIFACT],
      existsOnDisk: () => false,
    });
    expect(resolve(ARTIFACT)).toBe(true);
  });

  it('CONTROL: without the ignore leg the same path reads as missing (guard is not vacuous)', () => {
    // This is the pre-fix behaviour — it must still be reachable, or the test
    // above would pass for reasons unrelated to the ignore rule.
    const resolve = makeCitationResolver({
      trackedFiles: tracked,
      ignoredPaths: [],
      existsOnDisk: () => false,
    });
    expect(resolve(ARTIFACT)).toBe(false);
  });

  it('still flags a genuinely-deleted source file (no tracked, no ignore, no disk)', () => {
    const resolve = makeCitationResolver({
      trackedFiles: tracked,
      ignoredPaths: [ARTIFACT],
      existsOnDisk: () => false,
    });
    expect(resolve('packages/operator-core/lib/really-gone.ts')).toBe(false);
  });

  it('an insight citing only a gitignored artifact produces NO staleness signal', () => {
    const raw = [
      '# runbook',
      'Read `apps/operator-vite/.vite-build-failure.json` and fix the error.',
      'The reader is `apps/operator/lib/spa-build-status.ts`.',
    ].join('\n');
    const resolve = makeCitationResolver({
      trackedFiles: tracked,
      ignoredPaths: [ARTIFACT],
      existsOnDisk: () => false,
    });
    const signals = scanInsightStaleness(
      [{ slug: 'red-vite-build-destroys-the-live-bundle', status: 'current', raw }],
      resolve,
    );
    expect(signals).toEqual([]);
  });
});

describe('makeRepoBasenameResolver — basename-only existence (EI-510 Class-2 apoptosis guard)', () => {
  const tracked = ['packages/operator-core/lib/loopback-fetch.ts', 'libs/flags/src/types.ts'];

  it('matches on basename regardless of prefix (looser than the suffix resolver)', () => {
    const r = makeRepoBasenameResolver(tracked);
    expect(r('core/loopback-fetch.ts')).toBe(true); // suffix resolver says false; basename says true
    expect(r('anything/at/all/types.ts')).toBe(true);
  });

  it('returns false for a basename present nowhere in the tree', () => {
    expect(makeRepoBasenameResolver(tracked)('packages/x/really-gone.ts')).toBe(false);
  });
});

describe('scanInsightStaleness — suffix + recency guard (P-011)', () => {
  it('does NOT flag an insight whose only citation is a dropped-prefix shorthand', () => {
    const resolver = makeRepoPathResolver(['apps/operator/bin/hono-host.ts']);
    expect(scanInsightStaleness([insight('shorthand', 'The host is `bin/hono-host.ts`.')], resolver)).toEqual([]);
  });

  it('skips a recently-discovered insight (deploy-lag for new insights); flags an old one', () => {
    const nowMs = Date.parse('2026-06-14T00:00:00Z');
    const recent = { slug: 'fresh', status: 'active', discovered: '2026-06-13', raw: 'See `packages/x/gone.ts`.' };
    const old = { slug: 'aged', status: 'active', discovered: '2026-01-01', raw: 'See `packages/x/gone.ts`.' };
    expect(scanInsightStaleness([recent], () => false, { nowMs }).map((s) => s.key)).toEqual([]);
    expect(scanInsightStaleness([old], () => false, { nowMs }).map((s) => s.key)).toEqual(['aged']);
  });

  it('an insight with no discovered date is not recency-guarded (still flagged)', () => {
    const nowMs = Date.parse('2026-06-14T00:00:00Z');
    expect(
      scanInsightStaleness([insight('no-date', 'See `packages/x/gone.ts`.')], () => false, { nowMs }).map((s) => s.key),
    ).toEqual(['no-date']);
  });
});

describe('listIgnoredPaths — bounded sidecar probe routing', () => {
  it('keeps one check-ignore call per path and treats nonzero exits as not ignored', async () => {
    type SidecarExec = typeof import('../../fleet/git-via-sidecar').execFileViaSidecar;
    const calls: Array<{ command: string; args: string[]; opts: Parameters<SidecarExec>[2] }> = [];
    const runExec: SidecarExec = async (command, args, opts) => {
      calls.push({ command, args, opts });
      const pathArg = args[args.length - 1];
      if (pathArg === 'apps/generated.ts') return { stdout: '', stderr: '' };
      throw Object.assign(new Error('not ignored or path is in a submodule'), {
        code: pathArg === 'libs/sync/src/file.ts' ? 128 : 1,
        stdout: '',
        stderr: 'not ignored',
      });
    };

    const ignored = await listIgnoredPaths(
      '/repo',
      ['apps/generated.ts', 'apps/source.ts', 'libs/sync/src/file.ts'],
      runExec,
    );

    expect(ignored).toEqual(new Set(['apps/generated.ts']));
    expect(calls.map(({ command, args }) => [command, args])).toEqual([
      ['git', ['-C', '/repo', 'check-ignore', '-q', '--', 'apps/generated.ts']],
      ['git', ['-C', '/repo', 'check-ignore', '-q', '--', 'apps/source.ts']],
      ['git', ['-C', '/repo', 'check-ignore', '-q', '--', 'libs/sync/src/file.ts']],
    ]);
    expect(calls[0]?.opts).toMatchObject({
      subsystem: 'insight-staleness',
      timeoutMs: 2_000,
      rpcTimeoutMs: 7_000,
    });
  });
});

// The fs glue: readdir(agent-insights) → frontmatter status parse → existsSync
// delegation to the (separately-tested) pure scan. Smoke against the REAL docs
// tree — count-free so it can't drift as insights are added/retired; it pins the
// wiring (no throw, well-formed signals, the deterministic .mdx path shape).
describe('collectInsightStalenessSignals — fs glue over the real docs tree', () => {
  it('resolves to an array of well-formed insight-staleness signals', async () => {
    const signals = await collectInsightStalenessSignals(runLocalGit);
    expect(Array.isArray(signals)).toBe(true);
    for (const s of signals) {
      expect(s.source).toBe('insight-staleness');
      expect(typeof s.key).toBe('string');
      expect(s.key.length).toBeGreaterThan(0);
      expect(s.kind).toBe('change');
      // paths[0] is the deterministic mdx location derived from the slug/key.
      expect(s.paths?.[0]).toBe(
        `apps/operator-docs/src/content/docs/agent-insights/${s.key}.mdx`,
      );
    }
  });

  // EI-16474 regression. The first attempt at the ignore-rule leg used
  // `git check-ignore --stdin`, which resolves the batch as ONE pathspec set and
  // aborts ALL of it with exit 128 on the first path inside a submodule — this
  // repo has dozens, so it silently returned "nothing is ignored" for every
  // cited path and the collector behaved exactly as it had before. The pure-unit
  // tests still passed, because the defect lived entirely in the glue.
  //
  // So this asserts through the REAL collector: no emitted signal may blame a
  // path that git itself calls ignored. Count-free, so it can't drift.
  it('never reports a gitignored (generated) path as missing', async () => {
    const { execFileSync } = await import('node:child_process');
    const { REPO_ROOT } = await import('../../agent-tools/docs/_repo-paths');
    const signals = await collectInsightStalenessSignals(runLocalGit);
    const blamed = signals.flatMap((s) =>
      [...(s.body ?? '').matchAll(/^ {2}- `([^`]+)`$/gm)].map((m) => m[1]),
    );
    const ignored = blamed.filter((p) => {
      try {
        execFileSync('git', ['-C', REPO_ROOT, 'check-ignore', '-q', '--', p], {
          stdio: 'ignore',
          timeout: 30_000,
          killSignal: 'SIGKILL',
        });
        return true; // exit 0 = git considers it ignored
      } catch {
        return false; // exit 1 (not ignored) or 128 (pathspec error) → not our case
      }
    });
    expect(ignored).toEqual([]);
  });
});
