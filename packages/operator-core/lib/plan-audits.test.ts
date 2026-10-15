/**
 * Citation resolution across repository roots.
 *
 * The class this guards (EI-20430092702151575): a plan filed under one harness whose
 * code lives in a SIBLING repo of the same workspace was structurally unauditable.
 * Rooting resolution at the monorepo alone meant the repo-relative path did not
 * exist, the workspace-prefixed shape did not exist either, `..` was refused by both
 * traversal guards and an absolute path is schema-refused — so NO expressible
 * citation resolved and the ship gate could never be satisfied honestly.
 *
 * Every fixture below is built in a temp directory rather than asserted against this
 * machine's real workspace: the guard has to keep holding on a box where `sidestage`
 * does not exist.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// These fixtures exercise real Git repositories, not the shared host's sidecar.
// Keep ambient operator routing from spawning background services in this suite.
vi.mock('./fleet/git-via-sidecar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fleet/git-via-sidecar')>()),
  gitSidecarEnabled: () => false,
}));
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __repoCitationAsyncGitReadsForTests,
  __repoCitationSyncSpawnsForTests,
  __repoCitationTrackingCacheStatsForTests,
  __resetRepoCitationTrackingCacheForTests,
  prewarmRepoCitationTracking,
  measureCitationBlobsAtHead,
  citationBlobSha,
  citationBlobShaAt,
  foldEffectiveItemAudits,
  gitBlobSha,
  harnessCitationRepoRoot,
  independentSiblingRepos,
  mergeActivationAuditCoverage,
  registeredCitationRepoRoots,
  selectHarnessCitationRepoRoot,
  planItemTextHash,
  prepareAuditPassEntries,
  recordPlanAudit,
  resolveCitation,
  repoCitationDeps,
  validatePersistedAuditEntries,
  type AuditCitation,
  type ActivationAuditPayload,
  type CitationDeps,
  type CitationFailureReason,
  type CitationResolution,
} from './plan-audits';

describe('activation audit accumulated source coverage', () => {
  const payload = (count: number, start = 0): ActivationAuditPayload => ({
    sourceRanges: Array.from({ length: count }, (_, n) => ({
      sourceKind: 'codex', sessionId: `carry-${start + n}`, fromTurn: 0, toTurn: 4,
    })),
    mappings: [], repairedOmissions: [], rejectedOrSuperseded: [], unresolvedBlockers: [],
  });

  it('retains distinct prior sessions when a bounded re-audit crosses 50 lifetime ranges', () => {
    const previous = payload(50);
    const incoming = payload(2, 50);
    const oldBytes = JSON.stringify(previous);
    const merged = mergeActivationAuditCoverage(previous, incoming);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.activation.sourceRanges).toEqual([
      ...previous.sourceRanges, ...incoming.sourceRanges,
    ]);
    expect(JSON.stringify(previous)).toBe(oldBytes);
    const repeated = mergeActivationAuditCoverage(merged.activation, incoming);
    expect(repeated.ok).toBe(true);
    if (repeated.ok) expect(repeated.activation.sourceRanges).toHaveLength(52);
  });

  it('still rejects a changed requirement or dropped source refs after many carry sessions', () => {
    const previous = payload(51);
    previous.mappings = [{
      id: 'M-001', sourceRefs: ['session_turn:codex:carry-0:1'],
      requirement: 'Preserve the owner approval gate', planTargets: ['P-001'],
      disposition: 'covered',
    }];
    const incoming = payload(1, 51);
    incoming.mappings = [{ ...previous.mappings[0], sourceRefs: [],
      requirement: 'Skip the owner approval gate' }];
    const merged = mergeActivationAuditCoverage(previous, incoming);
    expect(merged.ok).toBe(false);
    if (!merged.ok) {
      expect(merged.conflicts.map((conflict) => conflict.code)).toEqual([
        'mapping_id_reused', 'mapping_source_refs_dropped',
      ]);
    }
  });

  const removedBarMapping = (): ActivationAuditPayload => {
    const previous = payload(1);
    previous.mappings = [{
      id: 'M-004', sourceRefs: ['session_turn:codex:carry-0:1'],
      requirement: 'Lessons enter candidate review', planTargets: ['R-4', 'P-008'],
      disposition: 'covered',
    }];
    return previous;
  };

  it('retires a target the current plan no longer contains and records the retirement', () => {
    const previous = removedBarMapping();
    const incoming = payload(0);
    incoming.mappings = [{ ...previous.mappings[0], planTargets: ['P-008', 'D-043'], disposition: 'rejected' }];
    const merged = mergeActivationAuditCoverage(previous, incoming, {
      deadTargets: [{ mappingId: 'M-004', target: 'R-4' }],
    });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.retiredTargets).toEqual([{ mappingId: 'M-004', target: 'R-4' }]);
    expect(merged.activation.mappings[0]).toMatchObject({ disposition: 'rejected', planTargets: ['P-008', 'D-043'] });
    expect(merged.activation.rejectedOrSuperseded).toContain(
      'M-004 target R-4 retired: absent from the current plan revision');
  });

  it('still refuses dropping a live target, even beside a dead one or a dead target of another mapping', () => {
    const previous = removedBarMapping();
    const incoming = payload(0);
    incoming.mappings = [{ ...previous.mappings[0], planTargets: ['D-043'], disposition: 'rejected' }];
    const merged = mergeActivationAuditCoverage(previous, incoming, {
      deadTargets: [{ mappingId: 'M-004', target: 'R-4' }, { mappingId: 'M-009', target: 'P-008' }],
    });
    expect(merged.ok).toBe(false);
    if (!merged.ok) {
      expect(merged.conflicts).toEqual([{
        mappingId: 'M-004', code: 'mapping_targets_dropped', detail: 'M-004 drops prior plan target(s): P-008',
      }]);
    }
    expect(mergeActivationAuditCoverage(previous, incoming).ok).toBe(false);
  });

  // WI-10006324: a plan that drops a provenance-declared item must stay re-auditable.
  const withDroppedItemProvenance = (): ActivationAuditPayload => {
    const previous = payload(1);
    previous.itemProvenance = [
      { itemId: 'P-015', kind: 'derived', from: ['R-7', 'D-012'], note: 'added after a degraded grade' },
      { itemId: 'P-016', kind: 'agent-added', reason: 'follow-up probe' },
    ];
    return previous;
  };

  it('retires a carried itemProvenance declaration whose item is no longer live, and records it', () => {
    const merged = mergeActivationAuditCoverage(withDroppedItemProvenance(), payload(0), {
      liveItemIds: ['P-001', 'P-016'],
    });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.retiredItemProvenance).toEqual(['P-015']);
    expect(merged.activation.itemProvenance?.map((d) => d.itemId)).toEqual(['P-016']);
    expect(merged.activation.rejectedOrSuperseded).toContain(
      'itemProvenance for P-015 retired: P-015 is dropped or absent from the current plan revision');
  });

  it('never retires a declaration the caller submits, and carries everything when liveItemIds is omitted', () => {
    const incoming = payload(0);
    incoming.itemProvenance = [{ itemId: 'P-015', kind: 'agent-added', reason: 'still wanted' }];
    const submitted = mergeActivationAuditCoverage(withDroppedItemProvenance(), incoming, {
      liveItemIds: ['P-001', 'P-016'],
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.retiredItemProvenance).toEqual([]);
    expect(submitted.activation.itemProvenance).toContainEqual(
      { itemId: 'P-015', kind: 'agent-added', reason: 'still wanted' });

    const unscoped = mergeActivationAuditCoverage(withDroppedItemProvenance(), payload(0));
    expect(unscoped.ok).toBe(true);
    if (!unscoped.ok) return;
    expect(unscoped.retiredItemProvenance).toEqual([]);
    expect(unscoped.activation.itemProvenance?.map((d) => d.itemId)).toEqual(['P-015', 'P-016']);
  });
});

let workspaceRoot: string;
let repoRoot: string;
let registeredAppRoot: string;
let registeredPointerRoot: string;

const code = (p: string): AuditCitation => ({ kind: 'code', path: p });

type CitationResolver = (citation: AuditCitation, deps: CitationDeps) => CitationResolution;

const deliberatelyWrongCitationResolver: CitationResolver = () => ({ ok: true });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
}

function citationResolverContractFailures(resolve: CitationResolver, deps: CitationDeps): string[] {
  const cases: Array<{
    name: string;
    citation: AuditCitation;
    expected: { ok: true } | { ok: false; reason: CitationFailureReason };
  }> = [
    {
      name: 'existing code path',
      citation: code('apps/operator/in-repo.ts'),
      expected: { ok: true },
    },
    {
      name: 'missing code path',
      citation: code('apps/operator/does-not-exist.ts'),
      expected: { ok: false, reason: 'file_not_found' },
    },
    {
      name: 'line beyond the cited file',
      citation: { ...code('apps/operator/in-repo.ts'), line: 9999 },
      expected: { ok: false, reason: 'line_out_of_range' },
    },
    {
      name: 'symbol absent from the cited file',
      citation: { ...code('apps/operator/in-repo.ts'), symbol: 'notInThisFile' },
      expected: { ok: false, reason: 'symbol_not_found' },
    },
    {
      name: 'none citation without a reason',
      citation: { kind: 'none' },
      expected: { ok: false, reason: 'reason_missing' },
    },
  ];

  return cases.flatMap(({ name, citation, expected }) => {
    const actual = resolve(citation, deps);
    if (actual.ok !== expected.ok) return [name];
    if (!actual.ok && !expected.ok && actual.reason !== expected.reason) return [name];
    return [];
  });
}

beforeAll(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-audits-roots-'));

  // The monorepo itself.
  repoRoot = path.join(workspaceRoot, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'apps', 'operator'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'apps', 'operator', 'in-repo.ts'), 'export const inRepo = 1;\n');
  fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });

  // An INDEPENDENT sibling repository (`.git` is a directory) — the sidestage shape.
  const sibling = path.join(workspaceRoot, 'sidestage');
  fs.mkdirSync(path.join(sibling, 'apps', 'web', 'src'), { recursive: true });
  fs.mkdirSync(path.join(sibling, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(sibling, 'apps', 'web', 'src', 'SellerDock.tsx'),
    'export function SellerDock() { return null; }\n',
  );

  // A registered app checkout nested below the workspace state directory. This is
  // intentionally not a direct sibling, so filesystem adjacency cannot admit it.
  registeredAppRoot = path.join(workspaceRoot, '.papercusp', 'apps', 'email');
  fs.mkdirSync(path.join(registeredAppRoot, '.git'), { recursive: true });
  fs.mkdirSync(path.join(registeredAppRoot, 'apps', 'desktop'), { recursive: true });
  fs.writeFileSync(
    path.join(registeredAppRoot, 'apps', 'desktop', 'main.ts'),
    'export const emailDesktop = true;\n',
  );

  // A registered pointer-file worktree must not become evidence merely because the
  // registry names its path.
  registeredPointerRoot = path.join(workspaceRoot, '.papercusp', 'apps', 'email-checkpoint');
  fs.mkdirSync(path.join(registeredPointerRoot, 'apps', 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(registeredPointerRoot, '.git'), 'gitdir: /tmp/email-checkpoint\n');
  fs.writeFileSync(
    path.join(registeredPointerRoot, 'apps', 'desktop', 'pointer-only.ts'),
    'export const checkpoint = true;\n',
  );

  // A WORKTREE of the monorepo (`.git` is a pointer FILE) — a deploy artifact that
  // must never stand as evidence, even though the file it holds really exists.
  const worktree = path.join(workspaceRoot, 'repo-release');
  fs.mkdirSync(path.join(worktree, 'apps', 'operator'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(repoRoot, '.git', 'worktrees', 'release')}\n`);
  fs.writeFileSync(path.join(worktree, 'apps', 'operator', 'deployed.ts'), 'export const deployed = 1;\n');

  // A plain directory with no `.git` at all.
  fs.mkdirSync(path.join(workspaceRoot, 'scratch', 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'scratch', 'src', 'notes.ts'), 'export const notes = 1;\n');
});

afterAll(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('repoCitationDeps — in-repo citations (unchanged behaviour)', () => {
  it('resolves a repo-relative path to a real file', () => {
    const deps = repoCitationDeps(repoRoot);
    expect(resolveCitation(code('apps/operator/in-repo.ts'), deps)).toEqual({ ok: true });
  });

  it('still refuses a path that names nothing', () => {
    const deps = repoCitationDeps(repoRoot);
    const res = resolveCitation(code('apps/operator/does-not-exist.ts'), deps);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: 'file_not_found' });
  });
});

describe('resolveCitation — falsifiability control (plan P-011)', () => {
  it('satisfies the resolver contract against temp-tree evidence', () => {
    expect(citationResolverContractFailures(resolveCitation, repoCitationDeps(repoRoot))).toEqual([]);
  });

  it('catches a permanently wrong resolver without mutating production code', () => {
    expect(citationResolverContractFailures(deliberatelyWrongCitationResolver, repoCitationDeps(repoRoot))).toEqual([
      'missing code path',
      'line beyond the cited file',
      'symbol absent from the cited file',
      'none citation without a reason',
    ]);
  });
});

describe('resolveCitation — trackedness of verifying citations (EI-21729074760905025)', () => {
  const resolvingDeps = (tracked: boolean | null): CitationDeps => ({
    statFile: () => ({ isFile: true }),
    readFile: () => 'export const cited = true;\n',
    isTracked: () => tracked,
  });

  it.each(['code', 'test'] as const)('rejects a %s citation when Git definitely reports it as untracked', (kind) => {
    const result = resolveCitation({ kind, path: 'src/untracked.ts' }, resolvingDeps(false));
    expect(result).toMatchObject({
      ok: false,
      reason: 'file_untracked',
    });
    expect((result as { detail: string }).detail).toContain('git-sync');
    expect((result as { detail: string }).detail).toContain('ignored');
  });

  it('preserves an otherwise-valid citation when trackedness is indeterminate', () => {
    expect(resolveCitation(code('src/unknown.ts'), resolvingDeps(null))).toEqual({ ok: true });
  });

  it('requires trackedness for repo-file docs without making them verifying citations', () => {
    expect(resolveCitation({ kind: 'doc', path: 'docs/design.md' }, resolvingDeps(false))).toMatchObject({
      ok: false,
      reason: 'file_untracked',
    });
    expect(resolveCitation({ kind: 'doc', path: 'docs/design.md' }, resolvingDeps(true))).toEqual({ ok: true });
    expect(resolveCitation({ kind: 'doc', ref: '/internal/docs/design', reason: 'PG-canonical doc' }, resolvingDeps(false)))
      .toEqual({ ok: true });
    expect(resolveCitation({ kind: 'none', reason: 'operational-only item' }, resolvingDeps(false))).toEqual({ ok: true });
  });
});

describe('harnessCitationRepoRoot — canonical registry precedence (WI-38854)', () => {
  it('uses the registered hive checkout instead of a stale same-slug workspace sibling', () => {
    const canonical = path.join(workspaceRoot, '.papercusp', 'hives', 'sidestage');
    fs.mkdirSync(path.join(canonical, 'apps', 'web', 'src'), { recursive: true });
    fs.mkdirSync(path.join(canonical, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(canonical, 'apps', 'web', 'src', 'EventReadinessPanel.tsx'),
      'export function EventReadinessPanel() { return null; }\n',
    );

    const root = harnessCitationRepoRoot(
      { projects: [{ slug: 'sidestage', path: canonical }] },
      'sidestage',
    );
    expect(root).toBe(canonical);
    expect(
      resolveCitation(
        { kind: 'code', path: 'apps/web/src/EventReadinessPanel.tsx', symbol: 'EventReadinessPanel' },
        repoCitationDeps(root!),
      ),
    ).toEqual({ ok: true });
    expect(resolveCitation(code('apps/web/src/EventReadinessPanel.tsx'), repoCitationDeps(repoRoot)).ok).toBe(false);
  });

  it('fails closed for an unregistered explicit harness', () => {
    expect(harnessCitationRepoRoot({ projects: [] }, 'missing')).toBeNull();
  });

  it('selects the sole real Hive checkout when the registry member path is stale', () => {
    const stale = path.join(workspaceRoot, 'missing-devboard');
    const fallback = path.join(workspaceRoot, 'sidestage-fallback');
    fs.mkdirSync(path.join(fallback, '.git'), { recursive: true });
    fs.mkdirSync(path.join(fallback, 'apps', 'web', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(fallback, 'apps', 'web', 'src', 'BuyerProductRail.css'),
      '.rail { display: grid; }\n',
    );

    expect(
      selectHarnessCitationRepoRoot(
        { projects: [{ slug: 'sb-devboard-hive', path: stale, harness_kind: 'hive' }] },
        'sb-devboard-hive',
        [code('apps/web/src/BuyerProductRail.css')],
        [fallback],
      ),
    ).toEqual({ root: fallback, source: 'hive-checkout' });
  });

  it('refuses an ambiguous tie between two real Hive checkouts', () => {
    const stale = path.join(workspaceRoot, 'missing-devboard-ambiguous');
    const first = path.join(workspaceRoot, 'hive-first');
    const second = path.join(workspaceRoot, 'hive-second');
    for (const root of [first, second]) {
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });
      fs.mkdirSync(path.join(root, 'apps', 'web', 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'apps', 'web', 'src', 'BuyerProductRail.css'), '.rail {}\n');
    }

    expect(
      selectHarnessCitationRepoRoot(
        { projects: [{ slug: 'sb-devboard-hive', path: stale, harness_kind: 'hive' }] },
        'sb-devboard-hive',
        [code('apps/web/src/BuyerProductRail.css')],
        [first, second],
      ),
    ).toBeNull();
  });

  it('excludes pointer-file worktrees from Hive fallback candidates', () => {
    const stale = path.join(workspaceRoot, 'missing-devboard-worktree');
    const real = path.join(workspaceRoot, 'hive-real');
    const worktree = path.join(workspaceRoot, 'hive-checkpoint');
    fs.mkdirSync(path.join(real, '.git'), { recursive: true });
    fs.mkdirSync(path.join(real, 'apps', 'web', 'src'), { recursive: true });
    fs.writeFileSync(path.join(real, 'apps', 'web', 'src', 'BuyerProductRail.css'), '.rail {}\n');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: /tmp/other-worktree\n');
    fs.mkdirSync(path.join(worktree, 'apps', 'web', 'src'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'apps', 'web', 'src', 'BuyerProductRail.css'), '.checkpoint {}\n');

    expect(
      selectHarnessCitationRepoRoot(
        { projects: [{ slug: 'sb-devboard-hive', path: stale, harness_kind: 'hive' }] },
        'sb-devboard-hive',
        [code('apps/web/src/BuyerProductRail.css')],
        [real, worktree],
      ),
    ).toEqual({ root: real, source: 'hive-checkout' });
  });

  it('keeps a resolving registry root labeled as the registry source', () => {
    const canonical = path.join(workspaceRoot, 'registry-live');
    fs.mkdirSync(path.join(canonical, 'apps', 'web', 'src'), { recursive: true });
    fs.writeFileSync(path.join(canonical, 'apps', 'web', 'src', 'BuyerProductRail.css'), '.rail {}\n');

    expect(
      selectHarnessCitationRepoRoot(
        { projects: [{ slug: 'sb-devboard-hive', path: canonical, harness_kind: 'hive' }] },
        'sb-devboard-hive',
        [code('apps/web/src/BuyerProductRail.css')],
        [],
      ),
    ).toEqual({ root: canonical, source: 'registry' });
  });

  it('falls back to the canonical repo when no hive checkout resolves the citations (WI-41365)', () => {
    const stale = path.join(workspaceRoot, 'missing-devboard-canonical');
    const nonResolving = path.join(workspaceRoot, 'hive-unrelated');
    fs.mkdirSync(path.join(nonResolving, '.git'), { recursive: true });
    const canonicalRepo = path.join(workspaceRoot, 'canonical-papercusp');
    fs.mkdirSync(path.join(canonicalRepo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(canonicalRepo, 'packages', 'operator-core', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(canonicalRepo, 'packages', 'operator-core', 'lib', 'orient-task-schema-pack.ts'),
      'export const packed = 1;\n',
    );

    expect(
      selectHarnessCitationRepoRoot(
        { projects: [{ slug: 'sb-devboard-hive', path: stale, harness_kind: 'hive' }] },
        'sb-devboard-hive',
        [code('packages/operator-core/lib/orient-task-schema-pack.ts')],
        [nonResolving],
        canonicalRepo,
      ),
    ).toEqual({ root: canonicalRepo, source: 'canonical-repo' });
  });

  it('prefers a sole resolving hive checkout over the canonical repo, and never tie-breaks with it', () => {
    const stale = path.join(workspaceRoot, 'missing-devboard-precedence');
    const canonicalRepo = path.join(workspaceRoot, 'canonical-papercusp-precedence');
    const hiveA = path.join(workspaceRoot, 'hive-a');
    const hiveB = path.join(workspaceRoot, 'hive-b');
    for (const root of [canonicalRepo, hiveA, hiveB]) {
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'shared.ts'), 'export const shared = 1;\n');
    }
    const reg = { projects: [{ slug: 'sb-devboard-hive', path: stale, harness_kind: 'hive' as const }] };

    // One resolving hive checkout wins even though the canonical repo also resolves.
    expect(
      selectHarnessCitationRepoRoot(reg, 'sb-devboard-hive', [code('src/shared.ts')], [hiveA], canonicalRepo),
    ).toEqual({ root: hiveA, source: 'hive-checkout' });
    // Two resolving hive checkouts stay an ambiguous refusal — the canonical repo must not tie-break.
    expect(
      selectHarnessCitationRepoRoot(reg, 'sb-devboard-hive', [code('src/shared.ts')], [hiveA, hiveB], canonicalRepo),
    ).toBeNull();
    // And a citation resolving NOWHERE still fails closed.
    expect(
      selectHarnessCitationRepoRoot(reg, 'sb-devboard-hive', [code('src/nowhere.ts')], [hiveA], canonicalRepo),
    ).toBeNull();
  });
});

describe('repoCitationDeps — sibling repositories (EI-20430092702151575)', () => {
  it('resolves a workspace-relative citation into an INDEPENDENT sibling repo', () => {
    const deps = repoCitationDeps(repoRoot);
    expect(resolveCitation(code('sidestage/apps/web/src/SellerDock.tsx'), deps)).toEqual({ ok: true });
  });

  it('verifies line and symbol inside a sibling file, not merely its existence', () => {
    const deps = repoCitationDeps(repoRoot);
    expect(
      resolveCitation({ kind: 'code', path: 'sidestage/apps/web/src/SellerDock.tsx', symbol: 'SellerDock' }, deps),
    ).toEqual({ ok: true });

    const missing = resolveCitation(
      { kind: 'code', path: 'sidestage/apps/web/src/SellerDock.tsx', symbol: 'NotInThisFile' },
      deps,
    );
    expect(missing.ok).toBe(false);
    expect(missing).toMatchObject({ reason: 'symbol_not_found' });

    const past = resolveCitation({ kind: 'code', path: 'sidestage/apps/web/src/SellerDock.tsx', line: 9999 }, deps);
    expect(past.ok).toBe(false);
    expect(past).toMatchObject({ reason: 'line_out_of_range' });
  });

  it('REFUSES a worktree of this repo — a deploy artifact is never evidence', () => {
    const deps = repoCitationDeps(repoRoot);
    // The file genuinely exists on disk; admission is decided by `.git` being a
    // pointer FILE, so this must fail despite the path being real.
    expect(fs.existsSync(path.join(workspaceRoot, 'repo-release', 'apps', 'operator', 'deployed.ts'))).toBe(true);
    const res = resolveCitation(code('repo-release/apps/operator/deployed.ts'), deps);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: 'file_not_found' });
  });

  it('REFUSES a sibling directory that is not a repository at all', () => {
    const deps = repoCitationDeps(repoRoot);
    expect(fs.existsSync(path.join(workspaceRoot, 'scratch', 'src', 'notes.ts'))).toBe(true);
    const res = resolveCitation(code('scratch/src/notes.ts'), deps);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: 'file_not_found' });
  });

  it('prefers the in-repo file when a sibling shares its first path segment', () => {
    // A monorepo directory named like a sibling must win, so a sibling can never
    // shadow real monorepo evidence.
    fs.mkdirSync(path.join(repoRoot, 'sidestage'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'sidestage', 'marker.ts'), 'export const fromRepo = true;\n');
    const deps = repoCitationDeps(repoRoot);
    expect(
      resolveCitation({ kind: 'code', path: 'sidestage/marker.ts', symbol: 'fromRepo' }, deps),
    ).toEqual({ ok: true });
  });
});

describe('repoCitationDeps — registered project roots (EI-21830530720187606)', () => {
  it('admits a nested registered checkout without requiring workspace relocation', () => {
    const deps = repoCitationDeps(repoRoot, [registeredAppRoot]);
    expect(
      resolveCitation(
        { kind: 'code', path: 'apps/desktop/main.ts', symbol: 'emailDesktop' },
        deps,
      ),
    ).toEqual({ ok: true });
  });

  it('keeps the selected root ahead of a registered root with the same relative path', () => {
    fs.mkdirSync(path.join(repoRoot, 'apps', 'desktop'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'apps', 'desktop', 'main.ts'),
      'export const canonicalDesktop = true;\n',
    );
    const deps = repoCitationDeps(repoRoot, [registeredAppRoot]);
    expect(
      resolveCitation(
        { kind: 'code', path: 'apps/desktop/main.ts', symbol: 'canonicalDesktop' },
        deps,
      ),
    ).toEqual({ ok: true });
    expect(
      resolveCitation(
        { kind: 'code', path: 'apps/desktop/main.ts', symbol: 'emailDesktop' },
        deps,
      ),
    ).toMatchObject({ ok: false, reason: 'symbol_not_found' });
  });

  it('excludes registered pointer-file worktrees', () => {
    const deps = repoCitationDeps(repoRoot, [registeredPointerRoot]);
    const result = resolveCitation(code('apps/desktop/pointer-only.ts'), deps);
    expect(result).toMatchObject({ ok: false, reason: 'file_not_found' });
    expect((result as { detail: string }).detail).not.toContain(registeredPointerRoot);
  });

  it('reports registered roots in a miss after trying them', () => {
    const deps = repoCitationDeps(repoRoot, [registeredAppRoot]);
    const result = resolveCitation(code('apps/desktop/missing.ts'), deps);
    expect(result).toMatchObject({ ok: false, reason: 'file_not_found' });
    expect((result as { detail: string }).detail).toContain(repoRoot);
    expect((result as { detail: string }).detail).toContain(registeredAppRoot);
  });

  it('derives only real registered checkout roots from ProjectEntry.path', () => {
    expect(
      registeredCitationRepoRoots({
        projects: [
          { slug: 'email', path: registeredAppRoot },
          { slug: 'email-checkpoint', path: registeredPointerRoot },
          { slug: 'state-only', path: path.join(workspaceRoot, '.papercusp', 'hives', 'email') },
        ],
      }),
    ).toEqual([registeredAppRoot]);
  });

  it('lets root selection resolve a mixed citation set through registered roots', () => {
    const registryRoot = path.join(workspaceRoot, 'registered-primary');
    fs.mkdirSync(path.join(registryRoot, '.git'), { recursive: true });
    fs.mkdirSync(path.join(registryRoot, 'apps', 'operator'), { recursive: true });
    fs.writeFileSync(
      path.join(registryRoot, 'apps', 'operator', 'primary.ts'),
      'export const primary = true;\n',
    );
    expect(
      selectHarnessCitationRepoRoot(
        { projects: [{ slug: 'email-harness', path: registryRoot }] },
        'email-harness',
        [
          code('apps/operator/primary.ts'),
          code('apps/desktop/main.ts'),
        ],
        [],
        repoRoot,
        [registeredAppRoot],
      ),
    ).toEqual({ root: registryRoot, source: 'registry' });
  });
});

describe('repoCitationDeps — containment is unchanged', () => {
  it('refuses traversal out of the repo even though the sibling is now reachable', () => {
    const deps = repoCitationDeps(repoRoot);
    const res = resolveCitation(code('../sidestage/apps/web/src/SellerDock.tsx'), deps);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: 'path_escapes_repo' });
  });

  it('refuses an absolute path to a file that really exists', () => {
    const deps = repoCitationDeps(repoRoot);
    const abs = path.join(workspaceRoot, 'sidestage', 'apps', 'web', 'src', 'SellerDock.tsx');
    expect(fs.existsSync(abs)).toBe(true);
    const res = resolveCitation(code(abs), deps);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: 'path_absolute' });
  });
});

describe('repoCitationDeps — Git trackedness (EI-21729074760905025)', () => {
  it('distinguishes tracked and untracked files in the selected repository after async prewarm', async () => {
    const trackedRoot = path.join(workspaceRoot, 'tracked-repo');
    fs.mkdirSync(trackedRoot, { recursive: true });
    fs.writeFileSync(path.join(trackedRoot, 'tracked.ts'), 'export const tracked = true;\n');
    fs.mkdirSync(path.join(trackedRoot, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(trackedRoot, 'docs', 'tracked.md'), '# Tracked doc\n');
    git(trackedRoot, 'init', '-q');
    git(trackedRoot, 'add', '--', 'tracked.ts', 'docs/tracked.md');
    fs.writeFileSync(path.join(trackedRoot, 'untracked.ts'), 'export const untracked = true;\n');
    fs.writeFileSync(path.join(trackedRoot, 'docs', 'untracked.md'), '# Untracked doc\n');

    await prewarmRepoCitationTracking([trackedRoot], [
      code('tracked.ts'),
      code('untracked.ts'),
      { kind: 'doc', path: 'docs/tracked.md' },
      { kind: 'doc', path: 'docs/untracked.md' },
    ]);
    const deps = repoCitationDeps(trackedRoot);
    expect(deps.isTracked?.('tracked.ts')).toBe(true);
    expect(deps.isTracked?.('untracked.ts')).toBe(false);
    expect(deps.isTracked?.('docs/tracked.md')).toBe(true);
    expect(deps.isTracked?.('docs/untracked.md')).toBe(false);
    expect(resolveCitation(code('tracked.ts'), deps)).toEqual({ ok: true });
    expect(resolveCitation(code('untracked.ts'), deps)).toMatchObject({
      ok: false,
      reason: 'file_untracked',
    });
    expect(resolveCitation({ kind: 'doc', path: 'docs/tracked.md' }, deps)).toEqual({ ok: true });
    expect(resolveCitation({ kind: 'doc', path: 'docs/untracked.md' }, deps)).toMatchObject({
      ok: false,
      reason: 'file_untracked',
    });
  });

  it('reuses one tracked-file snapshot across resolver contexts and reloads it when the Git index changes', async () => {
    const trackedRoot = path.join(workspaceRoot, 'tracked-cache-repo');
    fs.mkdirSync(trackedRoot, { recursive: true });
    fs.writeFileSync(path.join(trackedRoot, 'tracked.ts'), 'export const tracked = true;\n');
    fs.writeFileSync(path.join(trackedRoot, 'newly-tracked.ts'), 'export const later = true;\n');
    git(trackedRoot, 'init', '-q');
    git(trackedRoot, 'add', '--', 'tracked.ts');

    __resetRepoCitationTrackingCacheForTests();
    try {
      await prewarmRepoCitationTracking([trackedRoot], [code('tracked.ts'), code('newly-tracked.ts')]);
      expect(repoCitationDeps(trackedRoot).isTracked?.('tracked.ts')).toBe(true);
      // A NEW deps object shares the index snapshot instead of spawning Git once
      // per citation/root-selection/gate-evaluation context.
      expect(repoCitationDeps(trackedRoot).isTracked?.('newly-tracked.ts')).toBe(false);
      expect(__repoCitationTrackingCacheStatsForTests()).toEqual({ roots: 1, loads: 1 });

      git(trackedRoot, 'add', '--', 'newly-tracked.ts');
      await prewarmRepoCitationTracking([trackedRoot], [code('newly-tracked.ts')]);
      expect(repoCitationDeps(trackedRoot).isTracked?.('newly-tracked.ts')).toBe(true);
      expect(__repoCitationTrackingCacheStatsForTests()).toEqual({ roots: 1, loads: 2 });
    } finally {
      __resetRepoCitationTrackingCacheForTests();
    }
  });
});

// proof-freshness-pinned-candidate-2026-10-06 P-019 (D-001): the ship gate measures cited
// blobs at the committed HEAD of each top-level repository, so a peer's UNCOMMITTED edit to
// a cited file is invisible while a COMMITTED change reads stale.
describe('measureCitationBlobsAtHead — committed measurement commit M (P-019)', () => {
  const initRepo = (repo: string): void => {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'plan-audits-test@example.com');
    git(repo, 'config', 'user.name', 'Plan Audits Test');
  };

  it('measures the committed blob at HEAD and ignores an uncommitted edit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-audits-measure-'));
    const cited = path.join(root, 'src', 'cited.ts');
    const citedDoc = path.join(root, 'docs', 'guide.md');
    const committed = 'export const cited = "committed";\n';
    const committedDoc = '# Committed guide\n';
    try {
      fs.mkdirSync(path.dirname(cited), { recursive: true });
      fs.mkdirSync(path.dirname(citedDoc), { recursive: true });
      fs.writeFileSync(cited, committed);
      fs.writeFileSync(citedDoc, committedDoc);
      initRepo(root);
      git(root, 'add', '--', 'src/cited.ts', 'docs/guide.md');
      git(root, 'commit', '-qm', 'committed bytes');
      const head = git(root, 'rev-parse', 'HEAD').trim();
      fs.writeFileSync(cited, 'export const cited = "peer uncommitted edit";\n');
      fs.writeFileSync(citedDoc, '# Peer uncommitted edit\n');

      const docCitation: AuditCitation = { kind: 'doc', path: 'docs/guide.md' };
      const measured = await measureCitationBlobsAtHead([code('src/cited.ts'), docCitation], repoCitationDeps(root));
      expect(measured.blobs.get('src/cited.ts')).toBe(gitBlobSha(committed));
      expect(measured.blobs.get('docs/guide.md')).toBe(gitBlobSha(committedDoc));
      expect(measured.commits.get('src/cited.ts')).toBe(head);
      expect(measured.commits.get('docs/guide.md')).toBe(head);

      // Once committed, the same edit IS what M measures.
      const edited = 'export const cited = "now committed";\n';
      fs.writeFileSync(cited, edited);
      const editedDoc = '# Now committed\n';
      fs.writeFileSync(citedDoc, editedDoc);
      git(root, 'commit', '-qam', 'commit the edit');
      const after = await measureCitationBlobsAtHead([code('src/cited.ts'), docCitation], repoCitationDeps(root));
      expect(after.blobs.get('src/cited.ts')).toBe(gitBlobSha(edited));
      expect(after.blobs.get('docs/guide.md')).toBe(gitBlobSha(editedDoc));
      expect(after.commits.get('src/cited.ts')).toBe(git(root, 'rev-parse', 'HEAD').trim());
      expect(after.commits.get('docs/guide.md')).toBe(git(root, 'rev-parse', 'HEAD').trim());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('measures an uncommitted new file as null (not a committed file at M)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-audits-measure-new-'));
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'old.ts'), 'export const old = 1;\n');
      initRepo(root);
      git(root, 'add', '--', 'src/old.ts');
      git(root, 'commit', '-qm', 'base');
      fs.writeFileSync(path.join(root, 'src', 'new.ts'), 'export const fresh = 1;\n');

      const measured = await measureCitationBlobsAtHead([code('src/new.ts')], repoCitationDeps(root));
      expect(measured.blobs.has('src/new.ts')).toBe(true);
      expect(measured.blobs.get('src/new.ts')).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads a submodule citation at the gitlink the superproject HEAD pins, with no sync Git child', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-audits-measure-sub-'));
    const childRoot = path.join(root, 'child');
    const superprojectRoot = path.join(root, 'superproject');
    const pinned = 'export const pinned = true;\n';
    __resetRepoCitationTrackingCacheForTests();
    try {
      fs.mkdirSync(path.join(childRoot, 'src'), { recursive: true });
      fs.mkdirSync(superprojectRoot, { recursive: true });
      fs.writeFileSync(path.join(childRoot, 'src', 'index.ts'), pinned);
      initRepo(childRoot);
      initRepo(superprojectRoot);
      git(childRoot, 'add', '--', 'src/index.ts');
      git(childRoot, 'commit', '-qm', 'child source');
      git(superprojectRoot, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', childRoot, 'libs/child');
      git(superprojectRoot, 'commit', '-qm', 'pin child');
      const head = git(superprojectRoot, 'rev-parse', 'HEAD').trim();

      // The child moves on (committed inside the submodule) but the superproject gitlink is
      // NOT bumped: M is the superproject HEAD, so the pinned bytes are what it measures.
      const sub = path.join(superprojectRoot, 'libs', 'child');
      git(sub, 'config', 'user.email', 'plan-audits-test@example.com');
      git(sub, 'config', 'user.name', 'Plan Audits Test');
      fs.writeFileSync(path.join(sub, 'src', 'index.ts'), 'export const pinned = false;\n');
      git(sub, 'commit', '-qam', 'unpinned child commit');

      // COLD cache, deliberately: on the live shared tree the parent index moves between
      // the prewarm and the gate read, so the warm-snapshot shortcut misses. A synchronous
      // gitlink climb then forked one `git ls-files` per citation (P-005 real-plan probe:
      // 66 sync spawns for 66 citations). The climb must stay off the request thread.
      __resetRepoCitationTrackingCacheForTests();
      const citation = code('libs/child/src/index.ts');
      const spawnsBefore = __repoCitationSyncSpawnsForTests();
      const measured = await measureCitationBlobsAtHead(
        [citation, code('libs/child/src/index.ts'), code('.gitmodules')],
        repoCitationDeps(superprojectRoot),
      );
      expect(measured.blobs.get('libs/child/src/index.ts')).toBe(gitBlobSha(pinned));
      expect(measured.commits.get('libs/child/src/index.ts')).toBe(head);
      expect(__repoCitationSyncSpawnsForTests()).toBe(spawnsBefore);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('measures nothing for deps without `locate`, so callers keep the working-tree fingerprint', async () => {
    const measured = await measureCitationBlobsAtHead([code('src/x.ts')], {
      statFile: () => ({ isFile: true }),
      readFile: () => 'x',
    });
    expect(measured.blobs.size).toBe(0);
    expect(measured.commits.size).toBe(0);
  });
});

describe('repoCitationDeps — audited commit blob provenance (EI-22457360430270017)', () => {
  it('reads the cited blob from the pinned commit instead of the moving worktree', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-audits-commit-'));
    const citedPath = path.join(root, 'src', 'cited.ts');
    const oldBody = 'export const cited = "old";\n';
    const newBody = 'export const cited = "new";\n';
    try {
      fs.mkdirSync(path.dirname(citedPath), { recursive: true });
      fs.writeFileSync(citedPath, oldBody);
      git(root, 'init', '-q');
      git(root, 'config', 'user.email', 'plan-audits-test@example.com');
      git(root, 'config', 'user.name', 'Plan Audits Test');
      git(root, 'add', '--', 'src/cited.ts');
      git(root, 'commit', '-qm', 'old cited bytes');
      const oldSha = git(root, 'rev-parse', 'HEAD').trim();

      fs.writeFileSync(citedPath, newBody);
      git(root, 'add', '--', 'src/cited.ts');
      git(root, 'commit', '-qm', 'new cited bytes');
      const newSha = git(root, 'rev-parse', 'HEAD').trim();

      const deps = repoCitationDeps(root);
      const citation = code('src/cited.ts');
      expect(citationBlobSha(citation, deps)).toBe(gitBlobSha(newBody));
      expect(await citationBlobShaAt(citation, oldSha, deps)).toBe(gitBlobSha(oldBody));
      expect(await citationBlobShaAt(citation, newSha, deps)).toBe(gitBlobSha(newBody));
      expect(await citationBlobShaAt(citation, 'f'.repeat(40), deps)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('surfaces an operational Git failure instead of treating it as a missing audited citation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-audits-git-failure-'));
    const citedPath = path.join(root, 'src', 'cited.ts');
    const fakeGitDir = path.join(root, 'fake-bin');
    try {
      fs.mkdirSync(path.dirname(citedPath), { recursive: true });
      fs.writeFileSync(citedPath, 'export const cited = true;\n');
      git(root, 'init', '-q');
      git(root, 'config', 'user.email', 'plan-audits-test@example.com');
      git(root, 'config', 'user.name', 'Plan Audits Test');
      git(root, 'add', '--', 'src/cited.ts');
      git(root, 'commit', '-qm', 'cited source');
      const auditedSha = git(root, 'rev-parse', 'HEAD').trim();

      fs.mkdirSync(fakeGitDir);
      const fakeGit = path.join(fakeGitDir, 'git');
      fs.writeFileSync(fakeGit, '#!/bin/sh\nprintf \'synthetic Git transport failure\\n\' >&2\nexit 42\n');
      fs.chmodSync(fakeGit, 0o755);
      const previousPath = process.env.PATH;
      process.env.PATH = `${fakeGitDir}${path.delimiter}${previousPath ?? ''}`;
      try {
        await expect(citationBlobShaAt(code('src/cited.ts'), auditedSha, repoCitationDeps(root)))
          .rejects.toMatchObject({ name: 'CitationGitReadError', code: 'citation_git_read_unavailable' });
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a cited blob through the superproject gitlink at audited SHA (EI-22580796784944702)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-audits-submodule-'));
    const childRoot = path.join(root, 'chat-protocol');
    const superprojectRoot = path.join(root, 'superproject');
    const citedPath = path.join(childRoot, 'src', 'index.ts');
    const citedBody = 'export const protocol = "pinned";\n';
    try {
      fs.mkdirSync(path.dirname(citedPath), { recursive: true });
      fs.mkdirSync(superprojectRoot, { recursive: true });
      fs.writeFileSync(citedPath, citedBody);

      git(childRoot, 'init', '-q');
      git(childRoot, 'config', 'user.email', 'plan-audits-test@example.com');
      git(childRoot, 'config', 'user.name', 'Plan Audits Test');
      git(childRoot, 'add', '--', 'src/index.ts');
      git(childRoot, 'commit', '-qm', 'pinned child source');

      git(superprojectRoot, 'init', '-q');
      git(superprojectRoot, 'config', 'user.email', 'plan-audits-test@example.com');
      git(superprojectRoot, 'config', 'user.name', 'Plan Audits Test');
      git(
        superprojectRoot,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        childRoot,
        'libs/generic/chat-protocol',
      );
      git(superprojectRoot, 'add', '--', '.gitmodules', 'libs/generic/chat-protocol');
      git(superprojectRoot, 'commit', '-qm', 'pin chat protocol submodule');
      const auditedSha = git(superprojectRoot, 'rev-parse', 'HEAD').trim();

      const deps = repoCitationDeps(superprojectRoot);
      const citation = code('libs/generic/chat-protocol/src/index.ts');
      expect(resolveCitation(citation, deps)).toEqual({ ok: true });
      expect(citationBlobSha(citation, deps)).toBe(gitBlobSha(citedBody));
      expect(await citationBlobShaAt(citation, auditedSha, deps)).toBe(gitBlobSha(citedBody));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // P-007 / WI-10002829: a loop-saturation profile of the :3170 request host attributed
  // 28% of real main-thread work in the window that stalled the first native plan-popup to
  // this resolver's synchronous `git` children. After the async prewarm, the tracked and
  // gitlink answers come from the warm index snapshots, and commit-addressed lookups are
  // memoized — so a repeated acceptance evaluation launches no additional Git reads.
  it('answers tracked + gitlink checks from an async prewarm and memoizes commit-addressed lookups', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-audits-prewarm-'));
    const childRoot = path.join(root, 'child');
    const superprojectRoot = path.join(root, 'superproject');
    const citedBody = 'export const prewarmed = true;\n';
    __resetRepoCitationTrackingCacheForTests();
    try {
      fs.mkdirSync(path.join(childRoot, 'src'), { recursive: true });
      fs.mkdirSync(superprojectRoot, { recursive: true });
      fs.writeFileSync(path.join(childRoot, 'src', 'index.ts'), citedBody);
      for (const repo of [childRoot, superprojectRoot]) {
        git(repo, 'init', '-q');
        git(repo, 'config', 'user.email', 'plan-audits-test@example.com');
        git(repo, 'config', 'user.name', 'Plan Audits Test');
      }
      git(childRoot, 'add', '--', 'src/index.ts');
      git(childRoot, 'commit', '-qm', 'child source');
      git(superprojectRoot, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', childRoot, 'libs/child');
      git(superprojectRoot, 'commit', '-qm', 'pin child');
      const auditedSha = git(superprojectRoot, 'rev-parse', 'HEAD').trim();
      const citation = code('libs/child/src/index.ts');

      await prewarmRepoCitationTracking([superprojectRoot], [citation]);
      // Both the submodule's index and its superproject's (gitlink lookup) were warmed.
      expect(__repoCitationTrackingCacheStatsForTests()).toEqual({ roots: 2, loads: 2 });

      const deps = repoCitationDeps(superprojectRoot);
      expect(resolveCitation(citation, deps)).toEqual({ ok: true });
      expect(deps.isTracked?.('libs/child/src/index.ts')).toBe(true);
      expect(__repoCitationSyncSpawnsForTests()).toBe(0);

      // First commit-addressed lookup reads ls-tree + rev-parse asynchronously; the same
      // lookup from a NEW resolver context is served from the immutable memo.
      const beforeLookup = __repoCitationAsyncGitReadsForTests();
      expect(await citationBlobShaAt(citation, auditedSha, deps)).toBe(gitBlobSha(citedBody));
      const afterFirst = __repoCitationAsyncGitReadsForTests();
      expect(afterFirst - beforeLookup).toBe(2);
      expect(__repoCitationSyncSpawnsForTests()).toBe(0);
      expect(await citationBlobShaAt(citation, auditedSha, repoCitationDeps(superprojectRoot))).toBe(gitBlobSha(citedBody));
      expect(__repoCitationAsyncGitReadsForTests()).toBe(afterFirst);
      expect(__repoCitationSyncSpawnsForTests()).toBe(0);
    } finally {
      __resetRepoCitationTrackingCacheForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * `file_not_found` names the ROOT it searched (EI-20449557927956357).
 *
 * The class this guards: the refusal for "your path shape is wrong" and the refusal for
 * "you are resolving against a root you did not expect" were BYTE-IDENTICAL — both just
 * echoed the path back. Those two have opposite fixes, so the reader cannot act on the
 * message; measured cost was ~20min of bisecting a shipping plan's ship gate, and a
 * second agent hit the same wall the same day from the other direction.
 *
 * Asserting on the ROOT rather than on prose keeps this a behavioural guard: reword the
 * message freely, but a detail that stops naming where it looked fails here.
 */
describe('resolveCitation — a miss says WHERE it looked (EI-20449557927956357)', () => {
  it('names the repo root when nothing matched', () => {
    const deps = repoCitationDeps(repoRoot);
    const res = resolveCitation(code('apps/operator/does-not-exist.ts'), deps);
    expect(res).toMatchObject({ ok: false, reason: 'file_not_found' });
    const detail = (res as { detail: string }).detail;
    expect(detail).toContain('apps/operator/does-not-exist.ts');
    expect(detail).toContain(repoRoot);
  });

  it('names the HARNESS root when resolution is scoped to a harness tree', () => {
    // The exact shape that cost the 20 minutes: a plan whose harness is a sibling hive.
    // A citation written workspace-relative (`sidestage/...`) misses, and the old detail
    // could not reveal that the search was rooted INSIDE the hive already.
    const canonical = path.join(workspaceRoot, '.papercusp', 'hives', 'sidestage');
    fs.mkdirSync(path.join(canonical, '.git'), { recursive: true });
    const deps = repoCitationDeps(canonical);
    const res = resolveCitation(code('sidestage/apps/web/src/SellerDock.tsx'), deps);
    expect(res).toMatchObject({ ok: false, reason: 'file_not_found' });
    expect((res as { detail: string }).detail).toContain(canonical);
  });

  it('names BOTH roots when the first segment is an admitted sibling', () => {
    const deps = repoCitationDeps(repoRoot);
    const res = resolveCitation(code('sidestage/apps/web/src/NoSuchFile.tsx'), deps);
    expect(res).toMatchObject({ ok: false, reason: 'file_not_found' });
    const detail = (res as { detail: string }).detail;
    expect(detail).toContain(repoRoot);
    expect(detail).toContain(path.join(workspaceRoot, 'sidestage'));
  });

  it('does not name a sibling root that was never consulted', () => {
    // Control: without this, "names both roots" would also pass an implementation that
    // blindly appends every admitted sibling to every miss — which buries the one root
    // that matters and is the failure mode this whole change exists to remove.
    const deps = repoCitationDeps(repoRoot);
    const res = resolveCitation(code('apps/operator/does-not-exist.ts'), deps);
    expect((res as { detail: string }).detail).not.toContain(path.join(workspaceRoot, 'sidestage'));
  });

  it('stays pure: injected deps without describeRoots return the bare path', () => {
    const res = resolveCitation(code('apps/operator/nope.ts'), {
      statFile: () => null,
      readFile: () => null,
    });
    expect(res).toEqual({ ok: false, reason: 'file_not_found', detail: 'apps/operator/nope.ts' });
  });
});

/**
 * EI-22129491468808913: a bare repo-relative citation for genuinely cross-repo work
 * (no sibling-name prefix at all) misses `within()`'s existing sibling branch entirely
 * — that branch only fires when the FIRST SEGMENT already names a sibling — so the
 * miss reads identically to a wholly nonexistent path. An auditor who tries the
 * natural bare shape, watches it fail, and has no signal that a sibling repo holds the
 * same relative path reasonably (but wrongly) concludes cross-repo citation is unsafe
 * and downgrades real code to `not-code`.
 */
describe('resolveCitation — sibling repair suggestion on a miss (EI-22129491468808913)', () => {
  it('suggests the sibling-prefixed path when the bare citation matches one', () => {
    const deps = repoCitationDeps(repoRoot);
    const res = resolveCitation(code('apps/web/src/SellerDock.tsx'), deps);
    expect(res).toMatchObject({ ok: false, reason: 'file_not_found' });
    expect((res as { detail: string }).detail).toContain('did you mean "sidestage/apps/web/src/SellerDock.tsx"?');
  });

  it('names no suggestion when nothing under any sibling matches', () => {
    const res = resolveCitation(code('apps/operator/does-not-exist.ts'), repoCitationDeps(repoRoot));
    expect((res as { detail: string }).detail).not.toContain('did you mean');
  });

  it('does not re-suggest the same sibling prefix a citation already carries', () => {
    // `within()` already tried `sidestage/apps/web/src/NoSuchFile.tsx` under the
    // sibling directly; a suggestion re-adding the same "sidestage/" prefix would be
    // noise ("did you mean sidestage/sidestage/..."), not a repair.
    const res = resolveCitation(code('sidestage/apps/web/src/NoSuchFile.tsx'), repoCitationDeps(repoRoot));
    expect((res as { detail: string }).detail).not.toContain('did you mean');
  });

  it('stays pure: injected deps without siblingSuggestion return the bare miss detail unchanged', () => {
    const res = resolveCitation(code('apps/operator/nope.ts'), {
      statFile: () => null,
      readFile: () => null,
      describeRoots: () => repoRoot,
    });
    expect(res).toEqual({
      ok: false,
      reason: 'file_not_found',
      detail: `apps/operator/nope.ts (searched ${repoRoot})`,
    });
  });
});

describe('per-item audit provenance (plan D-006/D-007)', () => {
  it('stores blob hashes for repository files but keeps PG-canonical docs opaque', () => {
    expect(gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    const deps = repoCitationDeps(repoRoot);
    const citation = code('apps/operator/in-repo.ts');
    expect(citationBlobSha(citation, deps)).toBe(gitBlobSha('export const inRepo = 1;\n'));
    expect(citationBlobSha({ kind: 'doc', path: 'apps/operator/in-repo.ts' }, deps))
      .toBe(gitBlobSha('export const inRepo = 1;\n'));
    expect(citationBlobSha({ kind: 'doc', ref: '/internal/docs/design', reason: 'PG-canonical doc' }, deps)).toBeNull();
  });

  it('folds newest entries per item across partial passes', () => {
    const older = { itemId: 'P-001', verdict: 'implemented' as const, citations: [] };
    const newer = { itemId: 'P-001', verdict: 'partial' as const, citations: [] };
    const second = { itemId: 'P-002', verdict: 'implemented' as const, citations: [] };
    expect(
      foldEffectiveItemAudits([
        { auditSeq: 3, items: [newer] },
        { auditSeq: 2, items: [older, second] },
      ]),
    ).toEqual([
      { entry: newer, auditSeq: 3 },
      { entry: second, auditSeq: 2 },
    ]);
  });

  it('carries an unlisted item without re-stamping its original provenance', () => {
    const original = {
      itemId: 'P-001',
      verdict: 'implemented' as const,
      citations: [{ kind: 'code' as const, path: 'old.ts', blobSha: 'ce013625030ba8dba906f756967f9e9ca394464a' }],
      auditedSha: 'old-head',
      auditedAt: '2026-08-13T10:00:00.000Z',
      itemTextHash: planItemTextHash('old requirement'),
    };
    const fresh = {
      itemId: 'P-002',
      verdict: 'implemented' as const,
      citations: [{ kind: 'test' as const, path: 'new.test.ts', blobSha: 'da39a3ee5e6b4b0d3255bfef95601890afd80709' }],
    };
    const result = prepareAuditPassEntries({
      planItems: [
        { itemId: 'P-001', status: 'done', itemText: 'old requirement' },
        { itemId: 'P-002', status: 'done', itemText: 'fresh requirement' },
        { itemId: 'P-003', status: 'todo', itemText: 'never audited' },
      ],
      submitted: [fresh],
      previous: [{ entry: original, auditSeq: 4 }],
      auditedSha: 'new-head',
      auditedAt: '2026-08-20T12:00:00.000Z',
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ ...original, carriedFrom: 4 });
    expect(result[1]).toEqual({
      ...fresh,
      auditedSha: 'new-head',
      auditedAt: '2026-08-20T12:00:00.000Z',
      itemTextHash: planItemTextHash('fresh requirement'),
    });
    expect(validatePersistedAuditEntries(result)).toEqual([]);
    expect(result.some((entry) => entry.itemId === 'P-003')).toBe(false);
  });

  it('rejects a newly-created legacy-shaped entry at the write boundary', async () => {
    const item = { itemId: 'P-001', verdict: 'implemented' as const, citations: [] };
    expect(validatePersistedAuditEntries([item])).toEqual([
      expect.objectContaining({ itemId: 'P-001', code: 'missing_audited_sha' }),
      expect.objectContaining({ itemId: 'P-001', code: 'missing_audited_at' }),
      expect.objectContaining({ itemId: 'P-001', code: 'missing_item_text_hash' }),
    ]);
    await expect(
      recordPlanAudit({
        planSlug: 'test-plan',
        harnessSlug: 'papercusp',
        createdBy: 'test-agent',
        items: [item],
      }),
    ).rejects.toThrow(/plan audit provenance invalid/);
  });

  it('rejects a fresh code citation without its blob hash', () => {
    expect(
      validatePersistedAuditEntries([
        {
          itemId: 'P-001',
          verdict: 'implemented',
          citations: [{ kind: 'code', path: 'src/a.ts' }],
          auditedSha: 'abcdef1234567',
          auditedAt: '2026-08-20T12:00:00.000Z',
          itemTextHash: planItemTextHash('requirement'),
        },
      ]),
    ).toEqual([expect.objectContaining({ itemId: 'P-001', code: 'missing_blob_sha' })]);
  });

  it('rejects a fresh repo-file doc citation without its blob hash', () => {
    expect(
      validatePersistedAuditEntries([
        {
          itemId: 'P-001',
          verdict: 'not-code',
          citations: [{ kind: 'doc', path: 'docs/guide.md' }],
          auditedSha: 'abcdef1234567',
          auditedAt: '2026-08-20T12:00:00.000Z',
          itemTextHash: planItemTextHash('publish guide'),
        },
      ]),
    ).toEqual([expect.objectContaining({ itemId: 'P-001', code: 'missing_blob_sha' })]);
  });

  it('allows a legacy entry only when it is explicitly carried forward', () => {
    expect(
      validatePersistedAuditEntries([
        {
          itemId: 'P-001',
          verdict: 'implemented',
          citations: [{ kind: 'code', path: 'old.ts' }],
          carriedFrom: 4,
        },
      ]),
    ).toEqual([]);
  });
});

describe('independentSiblingRepos — a checkout directly under $HOME (EI-22188958812917965)', () => {
  // Fully isolated from the real machine's home directory (opts.homeRoot), matching this
  // file's own stated discipline: the guard must hold on a box where the reported shape
  // does not happen to exist for real. The reported bug: a sibling checkout that sits
  // directly under $HOME — one tier further out than the conventional
  // `~/papercupai-workspace/`-style workspace directory — was invisible to this resolver
  // no matter how the caller repo-qualified the path, because the scan never looked past
  // `dirname(repoRoot)`.
  let homeRoot: string;
  let workspaceRoot: string;
  let repoRoot: string;

  beforeAll(() => {
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-audits-home-'));
    workspaceRoot = path.join(homeRoot, 'papercupai-workspace');
    repoRoot = path.join(workspaceRoot, 'papercusp');
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });

    // The conventional tier: a sibling INSIDE workspaceRoot, beside repoRoot.
    fs.mkdirSync(path.join(workspaceRoot, 'sidestage', '.git'), { recursive: true });

    // The reported tier: a sibling directly under $HOME, one level further out —
    // `~/Restart`, not `~/papercupai-workspace/Restart`.
    fs.mkdirSync(path.join(homeRoot, 'Restart', '.git'), { recursive: true });

    // A non-repo directory directly under $HOME must NOT be admitted (no `.git` dir).
    fs.mkdirSync(path.join(homeRoot, 'Downloads'));

    // A worktree pointer FILE (not a directory) under $HOME must be excluded too, matching
    // the existing workspace-tier worktree exclusion.
    fs.mkdirSync(path.join(homeRoot, 'papercusp-release'));
    fs.writeFileSync(path.join(homeRoot, 'papercusp-release', '.git'), 'gitdir: ../elsewhere\n');
  });

  afterAll(() => {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  });

  it('finds a sibling directly under $HOME, not just inside the conventional workspace directory', () => {
    const siblings = independentSiblingRepos(repoRoot, { homeRoot });
    expect(siblings.has('Restart')).toBe(true);
    expect(siblings.get('Restart')).toBe(homeRoot);
  });

  it('still finds the conventional workspace-tier sibling, resolved against workspaceRoot', () => {
    const siblings = independentSiblingRepos(repoRoot, { homeRoot });
    expect(siblings.has('sidestage')).toBe(true);
    expect(siblings.get('sidestage')).toBe(workspaceRoot);
  });

  it('does not admit a non-repo directory or a worktree pointer file under $HOME', () => {
    const siblings = independentSiblingRepos(repoRoot, { homeRoot });
    expect(siblings.has('Downloads')).toBe(false);
    expect(siblings.has('papercusp-release')).toBe(false);
  });

  it('the returned parent resolves the exact reported repro path to a real, readable file', () => {
    // The bug's repro: filesChanged: ["apps/web/lib/sheets.ts"] (bare) and
    // ["Restart/apps/web/lib/sheets.ts"] (repo-qualified) both reported "absent-from-both".
    // A consumer (repoCitationDeps's `within()`, or completionRepoRootsFromRegistry) resolves
    // a sibling name against `siblings.get(name)` — never a hardcoded workspaceRoot — which is
    // exactly what makes the repo-qualified form work now.
    fs.mkdirSync(path.join(homeRoot, 'Restart', 'apps', 'web', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(homeRoot, 'Restart', 'apps', 'web', 'lib', 'sheets.ts'),
      'export const sheets = 1;\n',
    );
    const siblings = independentSiblingRepos(repoRoot, { homeRoot });
    const parent = siblings.get('Restart');
    expect(parent).toBe(homeRoot);
    const abs = path.resolve(parent!, 'Restart', 'apps/web/lib/sheets.ts');
    expect(fs.readFileSync(abs, 'utf8')).toContain('sheets');
  });
});

/**
 * WI-10005009: git-sync rewrites .git/index on every sweep, and a half-written index makes
 * both the tracked-file snapshot and `ls-files --error-unmatch` answer "not tracked" for a
 * committed file. A citation to that file would then be refused as untracked. isTracked must
 * fall back to HEAD's tree, and must not promote an untracked file while doing so.
 */
describe('repoCitationDeps — torn index (WI-10005009)', () => {
  const tornRepo = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-audits-torn-index-'));
    const git = (...args: string[]) =>
      execFileSync('git', [
        '-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t',
        '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
      ], { stdio: 'pipe' });
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'tracked.ts'), 'export const x = 1;\n');
    git('add', 'tracked.ts');
    git('commit', '-q', '-m', 'seed');
    fs.writeFileSync(path.join(dir, 'untracked.ts'), 'export const y = 2;\n');
    const index = path.join(dir, '.git', 'index');
    const bytes = fs.readFileSync(index);
    fs.writeFileSync(index, bytes.subarray(0, Math.floor(bytes.length / 2)));
    return dir;
  };

  it('keeps a committed file tracked, and an untracked one untracked, under a half-written index', async () => {
    const dir = tornRepo();
    try {
      // Calibration: the raw index read really does misreport, so this case is not vacuous.
      let rawTracked = true;
      try {
        execFileSync('git', ['-C', dir, 'ls-files', '--error-unmatch', '--', 'tracked.ts'], { stdio: 'ignore' });
      } catch {
        rawTracked = false;
      }
      expect(rawTracked).toBe(false);

      await prewarmRepoCitationTracking([dir], [code('tracked.ts'), code('untracked.ts')]);
      const deps = repoCitationDeps(dir);
      // isTracked is optional on the deps type; require it, so the negative case below
      // cannot pass vacuously through an absent reader.
      expect(deps.isTracked).toBeTypeOf('function');
      expect(deps.isTracked?.('tracked.ts')).toBe(true);
      expect(deps.isTracked?.('untracked.ts')).not.toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
