/**
 * P-021 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-007 #1): the repair
 * manifest is a pure derivation of the queue row — one row per signature leg, subject paths from
 * EVIDENCE only, status red / admitted / green in that priority, the exact admit command, and
 * leg claims that survive a rebuild.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import type { FrozenCandidateRepairQueue, FrozenRepairAdmission } from './frozen-candidate-repair-queue';
import {
  buildRepairManifest,
  claimRepairManifestLeg,
  extractSubjectPathsFromLegOutput,
  parseRepairManifest,
  renderAdmitCommand,
  renderRepairManifest,
  repairSignatureFingerprint,
  summarizeRepairManifest,
  withRepairManifest,
  withMeasuredLegSubjects,
} from './repair-manifest';

const CANDIDATE = 'a'.repeat(40);
const HEAD1 = 'b'.repeat(40);
const HEAD2 = 'c'.repeat(40);

function postgresJsonbOrder<T>(value: T): T {
  if (Array.isArray(value)) return value.map(postgresJsonbOrder) as T;
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => Buffer.byteLength(left) - Buffer.byteLength(right) ||
      Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return Object.fromEntries(entries.map(([key, nested]) => [key, postgresJsonbOrder(nested)])) as T;
}

function queue(over: Partial<FrozenCandidateRepairQueue> = {}): FrozenCandidateRepairQueue {
  return {
    schemaVersion: 4,
    phase: 'awaiting-fixer',
    candidate: CANDIDATE,
    base: null,
    repairHead: CANDIDATE,
    attempts: 0,
    openedAtMs: 1_000,
    updatedAtMs: 2_000,
    fixerSpawnId: null,
    failingTests: ['packages/web/lib/broken.test.ts', 'lint:tsc', 'full-gate'],
    signature: [
      { kind: 'test-file', id: 'packages/web/lib/broken.test.ts', recipe: 'npm run test:file -- packages/web/lib/broken.test.ts', workspace: '@papercusp/web', admittedRound: 1, measuredHead: CANDIDATE },
      { kind: 'lint-leg', id: 'lint:tsc', recipe: 'npm run lint:tsc', admittedRound: 1, measuredHead: CANDIDATE },
      { kind: 'seed', id: 'full-gate', recipe: 'the full canonical gate', admittedRound: 1, measuredHead: CANDIDATE },
    ],
    ...over,
  };
}

function admission(over: Partial<FrozenRepairAdmission> = {}): FrozenRepairAdmission {
  return {
    atMs: 3_000,
    actor: 'su-fixer',
    source: { ref: 'staging', sha: 'd'.repeat(40) },
    fromRepairHead: CANDIDATE,
    toRepairHead: HEAD1,
    paths: ['packages/web/lib/broken.test.ts'],
    unchanged: [],
    blobs: { 'packages/web/lib/broken.test.ts': 'e'.repeat(40) },
    ...over,
  };
}

const TSC_OUTPUT = [
  'packages/operator-core/lib/release/x.ts:12:3 - error TS2322: Type A is not assignable',
  "apps/operator/lib/release/green-checkpoint.ts(44,1): error TS1005: ';' expected.",
  'node_modules/foo/index.d.ts:1:1 - error TS2300 (vendored, must be ignored)',
  '../escape/outside.ts:1:1 - error (must be ignored)',
  'LINT_TSC_RESULT label=operator-core scope=files exit=2 status=failed',
].join('\n');

describe('repair manifest — measured lint subjects survive persistence', () => {
  it('lifts workspace diagnostics once while preserving sibling repo-relative paths', () => {
    expect(extractSubjectPathsFromLegOutput('lib/broken.ts(1,1): error\napps/b/sibling.ts:2: error', 'apps/a', ['apps/a', 'apps/b']))
      .toEqual(['apps/a/lib/broken.ts', 'apps/b/sibling.ts']);
  });
  it('retains measured paths through rebuild and admission, and publishes newly actionable paths', () => {
    const empty = withRepairManifest(queue(), 1);
    const measured = withMeasuredLegSubjects(empty.queue, CANDIDATE, [
      { id: 'lint:tsc', status: 'failed', subjectPaths: ['packages/web/src/broken.ts'] },
    ], 2);
    const changed = withRepairManifest(empty.queue, 3, { subjectPaths: { 'lint:tsc': ['packages/web/src/broken.ts'] } });
    expect(changed.statusChanged).toBe(true);
    const rebuilt = withRepairManifest(measured, 4);
    expect(rebuilt.manifest.rows.find((row) => row.legId === 'lint:tsc')).toMatchObject({
      subjectPaths: ['packages/web/src/broken.ts'], admitCommand: expect.stringContaining('packages/web/src/broken.ts'),
    });
    const admitted = withRepairManifest({ ...rebuilt.queue, repairHead: HEAD1, admissions: [admission({ paths: ['packages/web/src/broken.ts'] })] }, 5);
    expect(admitted.manifest.rows.find((row) => row.legId === 'lint:tsc')?.status.kind).toBe('admitted');
  });

  it('rejects foreign-head evidence and paths from another candidate or leg kind', () => {
    const measured = withMeasuredLegSubjects(queue(), CANDIDATE, [
      { id: 'lint:tsc', status: 'fail', subjectPaths: ['packages/web/src/broken.ts', '../escape.ts', '/absolute/no.ts'] },
    ], 2);
    expect(measured.manifest?.rows.find((row) => row.legId === 'lint:tsc')?.subjectPaths).toEqual(['packages/web/src/broken.ts']);
    expect(withMeasuredLegSubjects(queue(), HEAD1, [{ id: 'lint:tsc', status: 'fail', subjectPaths: ['wrong/file.ts'] }], 3).manifest).toBeUndefined();
    const foreign = withRepairManifest({ ...measured, candidate: HEAD2, repairHead: HEAD2 }, 4);
    expect(foreign.manifest.rows.find((row) => row.legId === 'lint:tsc')?.subjectPaths).toEqual([]);
    const changedKind = withRepairManifest({ ...measured, signature: [{ ...queue().signature[1]!, kind: 'workspace-task' as const }] }, 5);
    expect(changedKind.manifest.rows[0]?.subjectPaths).toEqual([]);
  });
});

describe('repair manifest — subject paths are evidence, never a guess', () => {
  it('a test-file leg names its own path and gets the exact admit command', () => {
    const m = buildRepairManifest({ queue: queue(), nowMs: 10 });
    const row = m.rows.find((r) => r.legId === 'packages/web/lib/broken.test.ts')!;
    expect(row.kind).toBe('test-file');
    expect(row.subjectPaths).toEqual(['packages/web/lib/broken.test.ts']);
    expect(row.subjectSource).toBe('leg-id');
    expect(row.statusLabel).toBe('red-at-candidate');
    expect(row.admitCommand).toBe(renderAdmitCommand(['packages/web/lib/broken.test.ts']));
    expect(row.admitCommand).toBe("release:repair-queue { op: 'admit', paths: [\"packages/web/lib/broken.test.ts\"] }");
    expect(row.workspace).toBe('@papercusp/web');
  });

  it('a lint leg with NO reported output is pathless: no fabricated command', () => {
    const m = buildRepairManifest({ queue: queue(), nowMs: 10 });
    const row = m.rows.find((r) => r.legId === 'lint:tsc')!;
    expect(row.subjectPaths).toEqual([]);
    expect(row.subjectSource).toBe('none');
    expect(row.admitCommand).toBeNull();
    const seed = m.rows.find((r) => r.legId === 'full-gate')!;
    expect(seed.subjectSource).toBe('none');
    expect(seed.admitCommand).toBeNull();
    expect(summarizeRepairManifest(m).pathless).toBe(2);
  });

  it('a lint leg mines the paths it REPORTED from its output tail (vendored / escaping tokens dropped)', () => {
    const m = buildRepairManifest({ queue: queue(), nowMs: 10, legOutputs: { 'lint:tsc': TSC_OUTPUT } });
    const row = m.rows.find((r) => r.legId === 'lint:tsc')!;
    expect(row.subjectPaths).toEqual([
      'packages/operator-core/lib/release/x.ts',
      'apps/operator/lib/release/green-checkpoint.ts',
    ]);
    expect(row.subjectSource).toBe('leg-output');
    expect(row.admitCommand).toContain('apps/operator/lib/release/green-checkpoint.ts');
  });

  it('POSITIVE CONTROL: the extractor really does match the tsc / vitest / eslint shapes it is meant to', () => {
    expect(extractSubjectPathsFromLegOutput('FAIL  libs/generic/search/src/index.test.ts > x')).toEqual([
      'libs/generic/search/src/index.test.ts',
    ]);
    expect(extractSubjectPathsFromLegOutput('/abs/path/file.ts:1:1 error')).toEqual([]);
    expect(extractSubjectPathsFromLegOutput('')).toEqual([]);
    expect(extractSubjectPathsFromLegOutput(undefined)).toEqual([]);
  });

  it('caller-supplied subject paths win over every other source', () => {
    const m = buildRepairManifest({
      queue: queue(),
      nowMs: 10,
      legOutputs: { 'lint:tsc': TSC_OUTPUT },
      subjectPaths: { 'lint:tsc': ['libs/flags/src/types.ts'] },
    });
    const row = m.rows.find((r) => r.legId === 'lint:tsc')!;
    expect(row.subjectPaths).toEqual(['libs/flags/src/types.ts']);
    expect(row.subjectSource).toBe('supplied');
  });
});

describe('repair manifest — status priority: green > admitted > red', () => {
  it('an admission carrying a leg path reads admitted-in-#N@sha (newest admission wins)', () => {
    const q = queue({
      repairHead: HEAD2,
      admissions: [
        admission(),
        admission({ atMs: 4_000, fromRepairHead: HEAD1, toRepairHead: HEAD2, paths: ['packages/web/lib/other.ts'] }),
        admission({ atMs: 5_000, fromRepairHead: HEAD2, toRepairHead: HEAD2, paths: ['packages/web/lib/other.ts', 'packages/web/lib/broken.test.ts'] }),
      ],
    });
    const m = buildRepairManifest({ queue: q, nowMs: 10 });
    const row = m.rows.find((r) => r.legId === 'packages/web/lib/broken.test.ts')!;
    expect(row.status.kind).toBe('admitted');
    expect(row.statusLabel).toBe(`admitted-in-#3@${HEAD2.slice(0, 8)}`);
  });

  it('a leg the lifecycle measured FIXED reads green-at-<sha> even when an admission also covers it', () => {
    const q = queue({
      repairHead: HEAD1,
      admissions: [admission()],
      legs: [
        {
          id: 'packages/web/lib/broken.test.ts',
          state: 'fixed',
          admittedRound: 1,
          admittedHead: CANDIDATE,
          admittedAtMs: 1_000,
          lastMeasuredHead: HEAD1,
          lastMeasuredAtMs: 6_000,
          lastMeasuredRound: 2,
          failingRounds: 1,
          resolvedHead: HEAD1,
          resolvedAtMs: 6_000,
        },
      ],
    });
    const m = buildRepairManifest({ queue: q, nowMs: 10 });
    const row = m.rows.find((r) => r.legId === 'packages/web/lib/broken.test.ts')!;
    expect(row.statusLabel).toBe(`green-at-${HEAD1.slice(0, 8)}`);
    expect(summarizeRepairManifest(m)).toMatchObject({ legs: 3, green: 1, admitted: 0, red: 2 });
  });

  it('an admission that names OTHER paths leaves the leg red', () => {
    const q = queue({ repairHead: HEAD1, admissions: [admission({ paths: ['packages/web/lib/other.ts'] })] });
    const m = buildRepairManifest({ queue: q, nowMs: 10 });
    expect(m.rows.find((r) => r.legId === 'packages/web/lib/broken.test.ts')!.statusLabel).toBe('red-at-candidate');
  });
});

describe('repair manifest — claims, rebuilds and the signature-change trigger', () => {
  it('claiming a leg claims its paths; a second actor is refused; the holder may release', () => {
    const m = buildRepairManifest({ queue: queue(), nowMs: 10 });
    const claimed = claimRepairManifestLeg(m, { legId: 'packages/web/lib/broken.test.ts', actor: 'su-a', atMs: 20 });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error('unreachable');
    expect(claimed.paths).toEqual(['packages/web/lib/broken.test.ts']);
    expect(claimed.row.claim).toEqual({ actor: 'su-a', atMs: 20 });
    // idempotent for the same actor — the original claim stamp is kept
    const again = claimRepairManifestLeg(claimed.manifest, { legId: 'packages/web/lib/broken.test.ts', actor: 'su-a', atMs: 30 });
    expect(again.ok && again.row.claim?.atMs).toBe(20);
    const other = claimRepairManifestLeg(claimed.manifest, { legId: 'packages/web/lib/broken.test.ts', actor: 'su-b', atMs: 30 });
    expect(other).toMatchObject({ ok: false, reason: 'held-by-other', holder: { actor: 'su-a' } });
    const stranger = claimRepairManifestLeg(claimed.manifest, { legId: 'packages/web/lib/broken.test.ts', actor: 'su-b', atMs: 30, release: true });
    expect(stranger).toMatchObject({ ok: false, reason: 'held-by-other' });
    const released = claimRepairManifestLeg(claimed.manifest, { legId: 'packages/web/lib/broken.test.ts', actor: 'su-a', atMs: 40, release: true });
    expect(released.ok && released.released).toBe(true);
    expect(released.ok && released.row.claim).toBeNull();
    expect(claimRepairManifestLeg(m, { legId: 'nope', actor: 'su-a', atMs: 1 })).toMatchObject({ ok: false, reason: 'no-such-leg' });
  });

  it('withRepairManifest: first build changes the signature, an identical rebuild does not, a new leg does; claims survive', () => {
    const first = withRepairManifest(queue(), 10);
    expect(first.signatureChanged).toBe(true);
    expect(first.statusChanged).toBe(true);
    const claimed = claimRepairManifestLeg(first.manifest, { legId: 'lint:tsc', actor: 'su-a', atMs: 11 });
    if (!claimed.ok) throw new Error('unreachable');
    const stable = withRepairManifest({ ...first.queue, manifest: claimed.manifest }, 12);
    expect(stable.signatureChanged).toBe(false);
    expect(stable.statusChanged).toBe(false);
    expect(stable.manifest.rows.find((r) => r.legId === 'lint:tsc')!.claim).toEqual({ actor: 'su-a', atMs: 11 });
    // an admission moves a status without changing the signature
    const admitted = withRepairManifest({ ...stable.queue, repairHead: HEAD1, admissions: [admission()] }, 13);
    expect(admitted.signatureChanged).toBe(false);
    expect(admitted.statusChanged).toBe(true);
    // a new leg changes the signature
    const grown = withRepairManifest(
      {
        ...admitted.queue,
        signature: [...admitted.queue.signature, { kind: 'lint-leg', id: 'lint:migrations', recipe: 'npm run lint:migrations', admittedRound: 2, measuredHead: HEAD1 }],
      },
      14,
    );
    expect(grown.signatureChanged).toBe(true);
    expect(grown.manifest.rows.map((r) => r.legId)).toContain('lint:migrations');
  });

  it('normalizes PostgreSQL jsonb key order before release-actions compares persisted rows', () => {
    const manifest = withRepairManifest(queue(), 10).manifest;
    const stored = postgresJsonbOrder(manifest);
    const parsed = parseRepairManifest(stored);

    expect(JSON.stringify(stored.rows)).not.toBe(JSON.stringify(manifest.rows));
    expect(parsed).not.toBeNull();
    expect(JSON.stringify(parsed!.rows)).toBe(JSON.stringify(manifest.rows));
  });

  it('a manifest built for a DIFFERENT candidate does not carry claims across', () => {
    const first = withRepairManifest(queue(), 10);
    const claimed = claimRepairManifestLeg(first.manifest, { legId: 'lint:tsc', actor: 'su-a', atMs: 11 });
    if (!claimed.ok) throw new Error('unreachable');
    const swapped = buildRepairManifest({ queue: queue({ candidate: HEAD2, repairHead: HEAD2 }), nowMs: 12, previous: claimed.manifest });
    expect(swapped.rows.find((r) => r.legId === 'lint:tsc')!.claim).toBeNull();
  });

  it('the fingerprint is order-independent over (kind,id)', () => {
    const a = repairSignatureFingerprint([{ kind: 'test-file', id: 'x' }, { kind: 'lint-leg', id: 'lint:tsc' }]);
    const b = repairSignatureFingerprint([{ kind: 'lint-leg', id: 'lint:tsc' }, { kind: 'test-file', id: 'x' }]);
    expect(a).toBe(b);
    expect(repairSignatureFingerprint([{ kind: 'lint-leg', id: 'x' }])).not.toBe(repairSignatureFingerprint([{ kind: 'test-file', id: 'x' }]));
  });
});

describe('repair manifest — persistence and rendering', () => {
  it('parse round-trips a built manifest and rejects a malformed blob as ABSENT', () => {
    const q = queue({ repairHead: HEAD1, admissions: [admission()] });
    const m = withRepairManifest(q, 10).manifest;
    const claimed = claimRepairManifestLeg(m, { legId: 'lint:tsc', actor: 'su-a', atMs: 11 });
    if (!claimed.ok) throw new Error('unreachable');
    const back = parseRepairManifest(JSON.parse(JSON.stringify(claimed.manifest)));
    expect(back).toEqual(claimed.manifest);
    expect(parseRepairManifest(null)).toBeNull();
    expect(parseRepairManifest({ schemaVersion: 1 })).toBeNull();
    expect(parseRepairManifest({ ...claimed.manifest, rows: [{ legId: 'x' }] })).toBeNull();
    expect(parseRepairManifest({ ...claimed.manifest, schemaVersion: 2 })).toBeNull();
  });

  it('renders every leg, its status, its admit command and the legend on ONE surface', () => {
    const q = queue({ repairHead: HEAD1, admissions: [admission()] });
    const m = withRepairManifest(q, 10, { legOutputs: { 'lint:tsc': TSC_OUTPUT } }).manifest;
    const text = renderRepairManifest(m);
    expect(text).toContain(`REPAIR MANIFEST — frozen candidate ${CANDIDATE.slice(0, 8)} @ repairHead ${HEAD1.slice(0, 8)}`);
    expect(text).toContain('| packages/web/lib/broken.test.ts | test-file | admitted-in-#1@');
    expect(text).toContain('| lint:tsc | lint-leg | red-at-candidate | packages/operator-core/lib/release/x.ts<br>apps/operator/lib/release/green-checkpoint.ts');
    expect(text).toContain('| full-gate | seed | red-at-candidate | (whole gate — no path) | — | — |');
    expect(text).toContain("`release:repair-queue { op: 'admit', paths: [\"packages/web/lib/broken.test.ts\"] }`");
    expect(text).toContain('claim-leg');
    expect(renderRepairManifest(m, { heading: false })).not.toContain('REPAIR MANIFEST');
  });

  it('caps subject paths per leg and reports the hidden count', () => {
    const many = Array.from({ length: 45 }, (_, i) => `packages/x/f${i}.ts`);
    const m = buildRepairManifest({ queue: queue(), nowMs: 10, subjectPaths: { 'lint:tsc': many } });
    const row = m.rows.find((r) => r.legId === 'lint:tsc')!;
    expect(row.subjectPaths).toHaveLength(40);
    expect(row.subjectPathsTruncated).toBe(5);
    // the admit command still names EVERY path — the cap is a display cap, never an allowlist cap
    expect(row.admitCommand).toContain('packages/x/f44.ts');
  });
});

/**
 * WI-10002500. A workspace task runs with its package directory as cwd, so its runner prints
 * `lib/foo.test.ts` while the admission ledger — and the admit command this manifest renders —
 * are repo-relative. Before the `workspaceDirs` input, those two spaces were compared directly,
 * so the join NEVER matched and every workspace-task leg reported `red-at-candidate` for the
 * life of the queue, including legs whose fix had already been admitted. That erased the one
 * signal that distinguishes "fixed, awaiting re-verification" from "nobody has ever repaired
 * this leg", and a papercusp freeze ran ~14h with the orphan leg rendered like the repaired ones.
 */
describe('repair manifest — leg paths and the admission ledger are joined in ONE path space', () => {
  // `@papercusp/web` → `apps/operator` is deliberate: its directory is NOT its package name's
  // last segment. 7 of this repo's 105 workspaces are like that, so a basename-derived shortcut
  // would pass a test written with a self-consistent name and still be wrong in production.
  const WORKSPACE_DIRS = {
    '@papercusp/web': 'apps/operator',
    '@papercusp/operator-core': 'packages/operator-core',
    '@papercusp/search': 'libs/generic/search',
  };
  const LANE_OUTPUT = ' FAIL  lib/agent-obligation-owner-directives.test.ts > opens a real pool';
  const REPO_PATH = 'apps/operator/lib/agent-obligation-owner-directives.test.ts';

  function laneQueue(over: Partial<FrozenCandidateRepairQueue> = {}): FrozenCandidateRepairQueue {
    return queue({
      failingTests: ['@papercusp/web :: test:lane-pure'],
      signature: [
        {
          kind: 'workspace-task',
          id: '@papercusp/web :: test:lane-pure',
          recipe: 'npm run test:lane-pure -w @papercusp/web',
          workspace: '@papercusp/web',
          admittedRound: 1,
          measuredHead: CANDIDATE,
        },
      ],
      ...over,
    });
  }

  it('lifts a workspace-relative mined path to repo-relative using the leg workspace directory', () => {
    const m = buildRepairManifest({
      queue: laneQueue(),
      nowMs: 10,
      legOutputs: { '@papercusp/web :: test:lane-pure': LANE_OUTPUT },
      workspaceDirs: WORKSPACE_DIRS,
    });
    const row = m.rows[0]!;
    expect(row.subjectPaths).toEqual([REPO_PATH]);
    // the rendered repair command must be pasteable from the repo root, which it was not before
    expect(row.admitCommand).toContain(REPO_PATH);
  });

  it('an admission carrying the repo-relative path flips the leg to admitted-in-#N', () => {
    const m = buildRepairManifest({
      queue: laneQueue({ repairHead: HEAD1, admissions: [admission({ paths: [REPO_PATH], blobs: { [REPO_PATH]: 'f'.repeat(40) } })] }),
      nowMs: 10,
      legOutputs: { '@papercusp/web :: test:lane-pure': LANE_OUTPUT },
      workspaceDirs: WORKSPACE_DIRS,
    });
    expect(m.rows[0]!.statusLabel).toBe(`admitted-in-#1@${HEAD1.slice(0, 8)}`);
  });

  it('CONTROL: the identical queue WITHOUT the map still reads red-at-candidate — the map is what does the work', () => {
    const m = buildRepairManifest({
      queue: laneQueue({ repairHead: HEAD1, admissions: [admission({ paths: [REPO_PATH], blobs: { [REPO_PATH]: 'f'.repeat(40) } })] }),
      nowMs: 10,
      legOutputs: { '@papercusp/web :: test:lane-pure': LANE_OUTPUT },
    });
    expect(m.rows[0]!.subjectPaths).toEqual(['lib/agent-obligation-owner-directives.test.ts']);
    expect(m.rows[0]!.statusLabel).toBe('red-at-candidate');
  });

  it('does NOT double-prefix a mined path that is already repo-relative, including one in a sibling workspace', () => {
    const m = buildRepairManifest({
      queue: laneQueue(),
      nowMs: 10,
      legOutputs: {
        '@papercusp/web :: test:lane-pure': [
          'apps/operator/lib/already-repo-relative.ts:3:1 - error',
          'packages/operator-core/lib/sibling.ts:9:2 - error',
        ].join('\n'),
      },
      workspaceDirs: WORKSPACE_DIRS,
    });
    expect(m.rows[0]!.subjectPaths).toEqual([
      'apps/operator/lib/already-repo-relative.ts',
      'packages/operator-core/lib/sibling.ts',
    ]);
  });

  it('a leg with no workspace is left exactly as mined — lifting only ever applies to a known workspace', () => {
    const m = buildRepairManifest({
      queue: queue(),
      nowMs: 10,
      legOutputs: { 'lint:tsc': TSC_OUTPUT },
      workspaceDirs: WORKSPACE_DIRS,
    });
    const row = m.rows.find((r) => r.legId === 'lint:tsc')!;
    expect(row.subjectPaths).toContain('packages/operator-core/lib/release/x.ts');
    expect(row.subjectPaths).toContain('apps/operator/lib/release/green-checkpoint.ts');
  });

  it('lifts the root scripts lint leg from its explicitly registered project directory', () => {
    const id = 'lint:tsc:scripts';
    const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const m = withRepairManifest(queue({
      candidate,
      repairHead: candidate,
      failingTests: [id],
      signature: [{ kind: 'lint-leg', id, recipe: 'npm run lint:tsc:scripts', admittedRound: 1, measuredHead: candidate }],
    }), 10, {
      legOutputs: { [id]: [
        'lib/runtime-compatibility-census.mjs(1,1): error TS2322: bad value',
        'lib/workspace-host-gcs-publication.mjs(2,1): error TS2322: bad value',
      ].join('\n') },
      workspaceDirs: WORKSPACE_DIRS,
      legProjectDirs: { [id]: 'scripts' },
    }).manifest;
    const row = m.rows[0]!;
    expect(row.subjectPaths).toEqual([
      'scripts/lib/runtime-compatibility-census.mjs',
      'scripts/lib/workspace-host-gcs-publication.mjs',
    ]);
    expect(row.admitCommand).toContain('scripts/lib/runtime-compatibility-census.mjs');
    for (const path of row.subjectPaths) {
      execFileSync('git', ['rev-parse', '--verify', candidate + ':' + path], { encoding: 'utf8' });
    }
  });

  it('lifts workspace-fanout diagnostics using their repo-relative runPackages header', () => {
    const id = 'lint:tsc:workspaces';
    const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const m = withRepairManifest(queue({
      candidate,
      repairHead: candidate,
      failingTests: [id],
      signature: [{ kind: 'lint-leg', id, recipe: 'npm run lint:tsc:workspaces', admittedRound: 1, measuredHead: candidate }],
    }), 10, {
      legOutputs: { [id]: [
        '--- libs/generic/search — npx tsc -p tsconfig.json exited 2 ---',
        'src/hybrid.test.ts(1,1): error TS2322: bad value',
      ].join('\n') },
      workspaceDirs: WORKSPACE_DIRS,
    }).manifest;
    const row = m.rows[0]!;
    expect(row.subjectPaths).toEqual(['libs/generic/search/src/hybrid.test.ts']);
    expect(row.admitCommand).toContain('libs/generic/search/src/hybrid.test.ts');
    // This workspace is a superproject gitlink; resolve the file against its candidate submodule commit.
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const submoduleSha = execFileSync('git', ['rev-parse', '--verify', candidate + ':libs/generic/search'], { encoding: 'utf8' }).trim();
    execFileSync('git', [
      '-C',
      repoRoot + '/libs/generic/search',
      'rev-parse',
      '--verify',
      submoduleSha + ':src/hybrid.test.ts',
    ], { encoding: 'utf8' });
  });
});
