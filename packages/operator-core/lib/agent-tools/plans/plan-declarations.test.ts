import { describe, expect, it } from 'vitest';
import {
  LIBRARIES_SECTION_DESCRIPTION,
  LIBRARIES_SECTION_HEADING,
  REUSE_REF_KINDS,
  REUSE_SECTION_HEADING,
  checkLibraryDeclarations,
  librariesDeclarationSchema,
  normalisePackageName,
  type LibraryCheckDeps,
  parseReuseRef,
  planDeclarationsRegressionAdvisory,
  resolveReuseReferences,
  type ParsedReuseRef,
  type ReferenceLookup,
  type ReuseDeclaration,
  type ReuseReferenceResolvers,
  planDeclarationsScaffold,
  planDeclarationsWriteAdvisory,
  previewPlanDeclarations,
  renderDeclarationsWalkthrough,
} from './plan-declarations';
import { indexDeclaredPackages, parseCargoManifest, type WorkspaceManifest } from '../../workspace-manifests';

const reuseSection = (block: unknown) =>
  `## ${REUSE_SECTION_HEADING}\n\nGuidance.\n\n\`\`\`reuse\n${typeof block === 'string' ? block : JSON.stringify(block, null, 2)}\n\`\`\``;
const librariesSection = (block: unknown) =>
  `## ${LIBRARIES_SECTION_HEADING}\n\nGuidance.\n\n\`\`\`libraries\n${typeof block === 'string' ? block : JSON.stringify(block, null, 2)}\n\`\`\``;
const plan = (...sections: string[]) => ['---\ntitle: T\n---', '## Now', 'state', ...sections, '## Decisions'].join('\n\n');

const validReuse = {
  searched: [{ where: 'packages/operator-core/lib/agent-tools/plans', how: 'grep for section parsers', found: 'product-shaping.ts' }],
  reused: [{ ref: 'packages/operator-core/lib/agent-tools/plans/plan-sections.ts#splitPlanSections', kind: 'symbol', provides: 'section split', items: ['P-001'] }],
  newSurfaces: [{ name: 'plan-declarations.ts', kind: 'module', nearestExisting: 'product-shaping.ts', whyNotReused: 'keeps that file focused' }],
  notApplicable: null,
};
const validLibraries = {
  needs: [
    { need: 'schema validation', decision: 'already-in-project', package: 'zod', reason: '', existingUse: 'product-shaping.ts' },
    { need: 'trim helper', decision: 'skip-research', package: '', reason: 'two lines of glue code' },
    { need: 'url state', decision: 'owner-specified', package: 'nuqs', reason: '', sourceRef: 'session_turn:claude:abc:3' },
    { need: 'pdf rendering', decision: 'researched', package: 'pdfkit', reason: '', candidates: [
      { name: 'pdfkit', verdict: 'chosen', why: 'streams, maintained' },
      { name: 'jspdf', verdict: 'rejected', why: 'browser-first' },
    ] },
  ],
  notApplicable: null,
};

describe('plan declarations', () => {
  it('accepts valid reuse and libraries sections', () => {
    const preview = previewPlanDeclarations(plan(reuseSection(validReuse), librariesSection(validLibraries)));
    expect(preview.diagnostics).toEqual([]);
    expect(preview.ok).toBe(true);
    expect(preview.reuse.status).toBe('declared');
    expect(preview.libraries.status).toBe('declared');
  });

  it('R-2: optional fields may be omitted, while the rules that need them still refuse', () => {
    const preview = previewPlanDeclarations(plan(
      reuseSection({ ...validReuse, searched: [{ where: 'packages/operator-core/lib', how: 'grep' }] }),
      librariesSection({ needs: [
        { need: 'schema validation', decision: 'already-in-project', package: 'zod', existingUse: 'product-shaping.ts' },
        { need: 'url state', decision: 'owner-specified', package: 'nuqs', sourceRef: 'session_turn:claude:abc:3' },
      ], notApplicable: null }),
    ));
    expect(preview.diagnostics).toEqual([]);
    expect(preview.ok).toBe(true);

    const missing = previewPlanDeclarations(plan(
      reuseSection(validReuse),
      librariesSection({ needs: [
        { need: 'trim helper', decision: 'skip-research' },
        { need: 'schema validation', decision: 'already-in-project', existingUse: 'product-shaping.ts' },
      ], notApplicable: null }),
    ));
    expect(missing.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['declaration_invalid', 'needs.0.reason'],
      ['declaration_invalid', 'needs.1.package'],
    ]);
  });

  it('accepts a not-applicable reason in place of entries', () => {
    const preview = previewPlanDeclarations(plan(
      reuseSection({ searched: [], reused: [], newSurfaces: [], notApplicable: 'docs-only plan' }),
      librariesSection({ needs: [], notApplicable: 'no code is written' }),
    ));
    expect(preview.ok).toBe(true);
    expect(preview.reuse.status).toBe('not-applicable');
    expect(preview.libraries.status).toBe('not-applicable');
  });

  it('R-2: each malformed declaration is reported with its field path', () => {
    const badJson = previewPlanDeclarations(plan(reuseSection('{ "searched": [ }'), librariesSection(validLibraries)));
    expect(badJson.ok).toBe(false);
    expect(badJson.diagnostics.map((d) => d.code)).toEqual(['declaration_invalid_json']);
    expect(badJson.diagnostics[0]!.section).toBe(REUSE_SECTION_HEADING);

    const unknownDecision = previewPlanDeclarations(plan(reuseSection(validReuse), librariesSection({
      needs: [{ need: 'dates', decision: 'guessed', package: 'dayjs', reason: '' }], notApplicable: null,
    })));
    expect(unknownDecision.diagnostics).toEqual([
      expect.objectContaining({ code: 'declaration_invalid', section: LIBRARIES_SECTION_HEADING, path: 'needs.0.decision' }),
    ]);

    const missingField = previewPlanDeclarations(plan(reuseSection({
      ...validReuse, reused: [{ ref: 'packages/x.ts', kind: 'file' }],
    }), librariesSection(validLibraries)));
    expect(missingField.diagnostics).toEqual([
      expect.objectContaining({ code: 'declaration_invalid', section: REUSE_SECTION_HEADING, path: 'reused.0.provides' }),
    ]);

    const decisionRules = previewPlanDeclarations(plan(reuseSection(validReuse), librariesSection({
      needs: [
        { need: 'a', decision: 'owner-specified', package: 'nuqs', reason: '', sourceRef: 'the owner said so' },
        { need: 'b', decision: 'already-in-project', package: 'zod', reason: '' },
        { need: 'c', decision: 'skip-research', package: '', reason: '' },
        { need: 'd', decision: 'researched', package: 'pdfkit', reason: '', candidates: [{ name: 'pdfkit', verdict: 'chosen', why: 'x' }] },
      ],
      notApplicable: null,
    })));
    expect(decisionRules.diagnostics.map((d) => d.path)).toEqual([
      'needs.0.sourceRef', 'needs.1.existingUse', 'needs.2.reason', 'needs.3.candidates',
    ]);

    // D-003: a not-applicable reason must be a real one-line reason — an empty or
    // whitespace-only string is refused at path `notApplicable` in either section.
    for (const blank of ['', '   ']) {
      const blankReuse = previewPlanDeclarations(plan(
        reuseSection({ searched: [], reused: [], newSurfaces: [], notApplicable: blank }),
        librariesSection(validLibraries),
      ));
      expect(blankReuse.ok).toBe(false);
      expect(blankReuse.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'declaration_invalid', section: REUSE_SECTION_HEADING, path: 'notApplicable' }),
      ]));

      const blankLibraries = previewPlanDeclarations(plan(
        reuseSection(validReuse),
        librariesSection({ needs: [], notApplicable: blank }),
      ));
      expect(blankLibraries.ok).toBe(false);
      expect(blankLibraries.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'declaration_invalid', section: LIBRARIES_SECTION_HEADING, path: 'notApplicable' }),
      ]));
    }
  });

  it('reports a missing section, a missing block and an empty declaration', () => {
    const missing = previewPlanDeclarations(plan(reuseSection(validReuse)));
    expect(missing.libraries.status).toBe('missing');
    expect(missing.diagnostics).toEqual([expect.objectContaining({ code: 'declaration_section_missing', section: LIBRARIES_SECTION_HEADING })]);

    const noBlock = previewPlanDeclarations(plan(`## ${REUSE_SECTION_HEADING}\n\nWe reuse the existing sync layer.`, librariesSection(validLibraries)));
    expect(noBlock.diagnostics.map((d) => d.code)).toEqual(['declaration_block_missing_or_ambiguous']);

    const empty = previewPlanDeclarations(plan(
      reuseSection({ searched: [], reused: [], newSurfaces: [], notApplicable: null }),
      librariesSection({ needs: [], notApplicable: null }),
    ));
    expect(empty.diagnostics.map((d) => d.path)).toEqual(['searched', 'reused', 'needs']);
  });

  it('an unfilled scaffold is invalid and names the fields to fill', () => {
    const preview = previewPlanDeclarations(plan(planDeclarationsScaffold()));
    expect(preview.reuse.status).toBe('invalid');
    expect(preview.libraries.status).toBe('invalid');
    expect(preview.diagnostics.map((d) => d.path)).toEqual(expect.arrayContaining(['searched.0.where', 'reused.0.kind', 'needs.0.decision']));
  });

  it('R-8: libraries guidance names all three no-research cases', () => {
    expect(LIBRARIES_SECTION_DESCRIPTION).toMatch(/owner already named the library \(owner-specified/);
    expect(LIBRARIES_SECTION_DESCRIPTION).toMatch(/project already uses a library for this \(already-in-project/);
    expect(LIBRARIES_SECTION_DESCRIPTION).toMatch(/no suitable library is expected \(skip-research/);
    expect(LIBRARIES_SECTION_DESCRIPTION).toMatch(/Research only when a library would remove a lot of work and fits the use case/);
  });

  it('renders every reuse entry, new surface and library row for the walkthrough', () => {
    const lines = renderDeclarationsWalkthrough(previewPlanDeclarations(plan(reuseSection(validReuse), librariesSection(validLibraries))));
    const text = lines.join('\n');
    expect(text).toContain('plan-sections.ts#splitPlanSections');
    expect(text).toContain('nearest existing: product-shaping.ts; not reused because: keeps that file focused');
    for (const row of validLibraries.needs) expect(text).toContain(`${row.need}: ${row.decision}`);
  });

  it('write advisory carries the scaffold only while a section is missing', () => {
    const advisory = planDeclarationsWriteAdvisory(plan());
    expect(advisory?.scaffold).toContain(`## ${REUSE_SECTION_HEADING}`);
    expect(advisory?.sections.map((s) => s.status)).toEqual(['missing', 'missing']);
    expect(planDeclarationsWriteAdvisory(plan(reuseSection(validReuse), librariesSection(validLibraries)))).toBeNull();
  });

  it('regression advisory fires only when an edit breaks a section that parsed before', () => {
    const good = plan(reuseSection(validReuse), librariesSection(validLibraries));
    const legacy = plan();
    // A plan that never had the sections stays quiet on edit.
    expect(planDeclarationsRegressionAdvisory(legacy, plan('## Extra\n\nmore text'))).toBeNull();
    // An edit that keeps both sections valid stays quiet.
    expect(planDeclarationsRegressionAdvisory(good, `${good}\n\nappended note`)).toBeNull();

    const removed = planDeclarationsRegressionAdvisory(good, plan(librariesSection(validLibraries)));
    expect(removed?.sections).toEqual([{ heading: REUSE_SECTION_HEADING, before: 'declared', after: 'missing' }]);

    const broken = planDeclarationsRegressionAdvisory(
      good,
      plan(reuseSection(validReuse), librariesSection({ needs: [{ need: 'x', decision: 'bogus' }], notApplicable: null })),
    );
    expect(broken?.sections).toEqual([{ heading: LIBRARIES_SECTION_HEADING, before: 'declared', after: 'invalid' }]);
    expect(broken?.diagnostics.length).toBeGreaterThan(0);
    expect(broken?.next).toMatch(/Write accepted/);
  });
});

// plan-reuse-and-library-declarations-2026-10-20 R-4 (D-002, D-004 #2, D-013 #2).
describe('reuse reference resolver', () => {
  type Kind = ReuseDeclaration['reused'][number]['kind'];
  const declaration = (entries: Array<{ ref: string; kind: Kind; items?: string[] }>): ReuseDeclaration => ({
    searched: [{ where: 'x', how: 'y', found: '' }],
    reused: entries.map((entry) => ({ provides: 'p', ...entry })),
    newSurfaces: [],
    notApplicable: null,
  });
  // One present and one absent reference per kind. The present ones only resolve
  // through these injected lookups, so a backend that is never reached cannot
  // pass as found or as unverified.
  const PRESENT: Record<Kind, string> = {
    file: 'packages/operator-core/lib/agent-tools/plans/plan-sections.ts',
    // A project outside packages/operator-core.
    symbol: 'libs/papercusp/packages/orchestrator/src/prompt-build.ts#REUSE_FIRST_NUDGE',
    tool: 'plans:audit',
    table: 'harness_shared.plan_audits',
    package: '@scope/pkg/sub',
    routine: 'green-checkpoint',
    doc: '/internal/docs/agent-insights/derived-truth-ladder',
  };
  const ABSENT: Record<Kind, string> = {
    file: 'packages/nope/missing.ts',
    symbol: 'libs/papercusp/packages/orchestrator/src/prompt-build.ts#NO_SUCH_SYMBOL',
    tool: 'plans:no-such-verb',
    table: 'harness_shared.no_such_table',
    package: 'no-such-package',
    routine: 'no-such-routine',
    doc: 'agent-insights/no-such-doc',
  };
  const seen: ParsedReuseRef[] = [];
  const lookup = (present: (ref: ParsedReuseRef) => boolean) => async (ref: ParsedReuseRef): Promise<ReferenceLookup> => {
    seen.push(ref);
    return present(ref) ? { outcome: 'found', via: 'fake' } : { outcome: 'not-found', via: 'fake' };
  };
  const resolvers: ReuseReferenceResolvers = {
    file: lookup((ref) => ref.path === PRESENT.file),
    symbol: lookup((ref) => ref.path === 'libs/papercusp/packages/orchestrator/src/prompt-build.ts' && ref.symbol === 'REUSE_FIRST_NUDGE'),
    tool: lookup((ref) => ref.name === 'plans:audit'),
    table: lookup((ref) => ref.schema === 'harness_shared' && ref.table === 'plan_audits'),
    package: lookup((ref) => ref.name === '@scope/pkg'),
    routine: lookup((ref) => ref.name === 'green-checkpoint'),
    doc: lookup((ref) => ref.name === 'agent-insights/derived-truth-ladder'),
  };
  const items = new Set(['P-001', 'P-002']);

  it('R-4: each reference kind is refused when missing and accepted when present', async () => {
    for (const kind of REUSE_REF_KINDS) {
      const present = await resolveReuseReferences(declaration([{ ref: PRESENT[kind], kind, items: ['P-001'] }]), { resolvers, planItemIds: items });
      expect(present, `${kind} present`).toMatchObject({ ok: true, blockers: [], unverified: [] });
      expect(present.checks[0]).toMatchObject({ kind, status: 'found' });

      const absent = await resolveReuseReferences(declaration([{ ref: ABSENT[kind], kind }]), { resolvers, planItemIds: items });
      expect(absent.ok, `${kind} absent`).toBe(false);
      expect(absent.checks[0]).toMatchObject({ kind, status: 'not-found' });
      expect(absent.blockers).toEqual([expect.objectContaining({ code: 'reuse_reference_unresolved', ref: ABSENT[kind], kind })]);
    }
    // The lookups saw the normalised parts, not the raw strings.
    expect(seen).toContainEqual(expect.objectContaining({ kind: 'package', name: '@scope/pkg' }));
    expect(seen).toContainEqual(expect.objectContaining({ kind: 'doc', name: 'agent-insights/derived-truth-ladder' }));
  });

  it('R-4: an unavailable lookup backend reports the entry unverified and does not refuse', async () => {
    const down: ReuseReferenceResolvers = {
      table: async () => ({ outcome: 'unavailable', reason: 'PG catalog unavailable' }),
      tool: async () => { throw new Error('registry crashed'); },
      // routine: no lookup configured at all
    };
    const report = await resolveReuseReferences(declaration([
      { ref: 'harness_shared.plan_audits', kind: 'table' },
      { ref: 'plans:audit', kind: 'tool' },
      { ref: 'green-checkpoint', kind: 'routine' },
    ]), { resolvers: down, planItemIds: items });
    expect(report).toMatchObject({ ok: true, blockers: [] });
    expect(report.unverified).toEqual(['harness_shared.plan_audits', 'plans:audit', 'green-checkpoint']);
    expect(report.checks.map((check) => check.detail)).toEqual([
      'PG catalog unavailable', 'registry crashed', 'no routine lookup is configured',
    ]);
  });

  it('R-4: a reference not in its kind\'s exact form is refused without a lookup', async () => {
    const before = seen.length;
    const report = await resolveReuseReferences(declaration([
      { ref: 'the existing sync layer', kind: 'file' },
      { ref: 'packages/x.ts', kind: 'symbol' },
      { ref: 'harness_shared', kind: 'table' },
      { ref: '/abs/path.ts', kind: 'file' },
      { ref: 'packages/../etc/passwd', kind: 'file' },
    ]), { resolvers, planItemIds: items });
    expect(report.ok).toBe(false);
    expect(report.checks.every((check) => check.status === 'malformed')).toBe(true);
    expect(report.blockers).toHaveLength(5);
    expect(seen.length).toBe(before);
  });

  it('R-4: a reuse entry whose items are not P-NNN ids of this plan is reported', async () => {
    const report = await resolveReuseReferences(
      declaration([{ ref: PRESENT.table, kind: 'table', items: ['P-001', 'P-009'] }]),
      { resolvers, planItemIds: items },
    );
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.status).toBe('found');
    expect(report.blockers).toEqual([{ code: 'reuse_item_unknown', ref: PRESENT.table, kind: 'table', detail: 'P-009 is not an item of this plan' }]);
  });

  // plan-reuse-and-library-declarations-2026-10-20 R-5 (D-004 #4/#6, D-013 #3).
  const manifests: WorkspaceManifest[] = [
    { path: 'package.json', ecosystem: 'npm', name: 'root', dependencies: ['zod', 'lodash', '@scope/pkg'] },
    { path: 'packages/app/package.json', ecosystem: 'npm', name: '@papercusp/app', dependencies: ['fast-glob'] },
    { path: 'apps/tui/Cargo.toml', ecosystem: 'cargo', name: 'tui', dependencies: ['serde_json', 'tokio'] },
  ];
  const librariesOf = (needs: unknown[]) => librariesDeclarationSchema.parse({ needs, notApplicable: null });
  const inProject = (pkg: string) => ({ need: `use ${pkg}`, decision: 'already-in-project', package: pkg, reason: '', existingUse: 'somewhere' });

  it('R-5: already-in-project is refused for a package no workspace depends on', async () => {
    const deps: LibraryCheckDeps = { packages: indexDeclaredPackages(manifests), ownerTurns: null };
    // Real dependencies, a subpath of one, and a Cargo crate (`-`/`_` folded) are accepted.
    for (const pkg of ['zod', 'lodash/fp', '@scope/pkg/sub', 'fast-glob', 'serde-json', 'tokio']) {
      const report = await checkLibraryDeclarations(librariesOf([inProject(pkg)]), deps);
      expect(report, pkg).toMatchObject({ ok: true, blockers: [], unverified: [] });
    }
    // A package no manifest depends on is refused — including a workspace's own name.
    for (const pkg of ['left-pad', '@papercusp/app', 'reqwest']) {
      const report = await checkLibraryDeclarations(librariesOf([inProject(pkg)]), deps);
      expect(report.ok, pkg).toBe(false);
      expect(report.blockers).toEqual([expect.objectContaining({ code: 'library_not_a_dependency', row: 0 })]);
    }
    // Unreadable manifests: unverified, never refused.
    const down = await checkLibraryDeclarations(librariesOf([inProject('left-pad')]), { packages: null, ownerTurns: null });
    expect(down).toMatchObject({ ok: true, unverified: ['needs.0'] });
  });

  it('R-5: an owner-specified row must cite an owner-typed turn; an unavailable ledger is unverified', async () => {
    const owner = (ref: string) => ({ need: 'url state', decision: 'owner-specified', package: 'nuqs', reason: '', sourceRef: ref });
    const ownerTurns = async (refs: readonly string[]) => new Map(refs.filter((r) => !r.endsWith(':9')).map((r) => [r, r.endsWith(':1') ? 'owner' as const : 'not-owner' as const]));
    const deps: LibraryCheckDeps = { packages: indexDeclaredPackages(manifests), ownerTurns };
    expect(await checkLibraryDeclarations(librariesOf([owner('session_turn:claude:s:1')]), deps)).toMatchObject({ ok: true });
    const agent = await checkLibraryDeclarations(librariesOf([owner('session_turn:claude:s:2')]), deps);
    expect(agent.blockers).toEqual([expect.objectContaining({ code: 'library_owner_turn_unresolved', detail: expect.stringContaining('not an owner-typed turn') })]);
    const absent = await checkLibraryDeclarations(librariesOf([owner('session_turn:claude:s:9')]), deps);
    expect(absent.blockers).toEqual([expect.objectContaining({ code: 'library_owner_turn_unresolved', detail: expect.stringContaining('not found') })]);
    for (const unavailable of [null, async () => { throw new Error('ledger down'); }]) {
      const report = await checkLibraryDeclarations(librariesOf([owner('session_turn:claude:s:2')]), { ...deps, ownerTurns: unavailable });
      expect(report).toMatchObject({ ok: true, unverified: ['needs.0'] });
    }
  });

  it('R-5: a researched row needs a runner-up or a reason, and existing look-alike dependencies are advised', async () => {
    const preview = previewPlanDeclarations(plan(reuseSection(validReuse), librariesSection({
      needs: [{ need: 'pdf rendering', decision: 'researched', package: 'pdfkit', reason: '', candidates: [{ name: 'pdfkit', verdict: 'chosen', why: 'x' }] }],
      notApplicable: null,
    })));
    expect(preview.libraries.status).toBe('invalid');
    expect(preview.libraries.diagnostics.map((d) => d.path)).toContain('needs.0.candidates');

    const researched = librariesOf([{ need: 'glob file matching for workspaces', decision: 'researched', package: 'tinyglobby', reason: '',
      candidates: [{ name: 'tinyglobby', verdict: 'chosen', why: 'small' }, { name: 'globby', verdict: 'rejected', why: 'heavier' }] }]);
    const report = await checkLibraryDeclarations(researched, {
      packages: indexDeclaredPackages(manifests), ownerTurns: null,
      dependencyDescriptions: async () => new Map([['fast-glob', 'Fast glob matching for Node.js'], ['zod', 'TypeScript-first schema validation']]),
    });
    expect(report).toMatchObject({ ok: true, advice: [{ row: 0, existingDependencies: ['fast-glob'] }] });
  });

  it('R-5: the shared manifest walk reads every Cargo dependency table', () => {
    const cargo = parseCargoManifest('apps/x/Cargo.toml', [
      '[package]', 'name = "x"', '',
      '[dependencies]', 'serde = "1"', 'tokio = { version = "1", features = ["full"] }', '',
      '[dev-dependencies]', 'insta = "1"', '',
      '[build-dependencies]', 'cc = "1"', '',
      "[target.'cfg(unix)'.dependencies]", 'libc = "0.2"', '',
      '[workspace.dependencies]', 'anyhow = "1"',
    ].join('\n'));
    expect(cargo).toMatchObject({ ecosystem: 'cargo', name: 'x' });
    expect([...cargo.dependencies].sort()).toEqual(['anyhow', 'cc', 'insta', 'libc', 'serde', 'tokio']);
  });

  it('normalises package subpaths for matching (D-013 #3)', () => {
    expect(normalisePackageName('lodash/fp')).toBe('lodash');
    expect(normalisePackageName('@scope/pkg/sub')).toBe('@scope/pkg');
    expect(normalisePackageName(' zod ')).toBe('zod');
    expect(parseReuseRef('symbol', 'a/b.ts#Class.method')).toEqual({ ok: true, parsed: { kind: 'symbol', ref: 'a/b.ts#Class.method', path: 'a/b.ts', symbol: 'Class.method' } });
  });
});
