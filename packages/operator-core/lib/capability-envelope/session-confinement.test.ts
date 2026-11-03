import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DIRECTED_IMPLEMENTER_DENY_TOOLS,
  assertConfinementCoversIndirectDispatch,
  directedImplementerConfinement,
  evaluateSessionConfinement,
  toDenyMatchKey,
  validProductReadBoundary,
  validScratchPlanBoundary,
  SCRATCH_PLAN_TOOLS,
  BENCHMARK_SCRATCH_PLAN_TOOLS,
  type SessionToolConfinement,
} from './session-confinement';

const CONFINEMENT: SessionToolConfinement = directedImplementerConfinement({
  directorSid: 'su-director-1',
  scope: 'WI-1234',
});

const evaluate = (toolName: string) =>
  evaluateSessionConfinement({ toolName, confinement: CONFINEMENT });

describe('frozen assignment memory confinement', () => {
  const boundary = { id: 'F-own', harness: 'bench-private', checkout: '/private/assignment' };
  const confinement: SessionToolConfinement = { denyTools: [], denyOutside: ['memory:search', 'memory:list', 'memory:remember'],
    denyWorkItemsOutside: boundary, denyMemoryOutside: { snapshotSha256: 'a'.repeat(64) },
    denyAmbientContext: true, reason: 'frozen memory', imposedBy: 'host' };
  const own = { query: 'iron pickaxe', harness_slug: boundary.harness, harnessOnly: true };
  it('admits explicit search only in the exact pool and denies selector widening even under a broader ceiling', () => {
    expect(evaluateSessionConfinement({ toolName: 'memory:search', args: own, confinement }).allowed).toBe(true);
    for (const args of [{ ...own, harness_slug: 'other' }, { ...own, harnessOnly: false }, { query: own.query },
      { ...own, workspace: 'production' }, { ...own, as_of: '2026-01-01' }, { ...own, limit: 100 }, { ...own, query: '' }])
      expect(evaluateSessionConfinement({ toolName: 'memory:search', args, confinement }))
        .toMatchObject({ allowed: false, matchedGlob: 'outside-frozen-memory' });
    for (const toolName of ['memory:list', 'memory:remember'])
      expect(evaluateSessionConfinement({ toolName, args: own, confinement }).allowed).toBe(false);
    expect(evaluateSessionConfinement({ toolName: 'memory:search', args: own,
      confinement: { ...confinement, denyOutside: [] } }).allowed).toBe(false);
  });
  it('fails closed when host memory or assignment bindings are malformed', () => {
    for (const change of [{ denyMemoryOutside: { snapshotSha256: 'bad' } }, { denyWorkItemsOutside: undefined },
      { denyMemoryOutside: { snapshotSha256: 'a'.repeat(64), file: '/private/other' } }])
      expect(evaluateSessionConfinement({ toolName: 'memory:search', args: own,
        confinement: { ...confinement, ...change } }).allowed).toBe(false);
  });
});

describe('benchmark planning reuses private scratch plans', () => {
  const boundary = { scratchPrefix: 'benchmark-scratch-abcdef123456-', reviewedSlug: 'observer-private', harness: 'bench-private' };
  const confinement: SessionToolConfinement = { denyTools: [], denyOutside: SCRATCH_PLAN_TOOLS,
    denyPlansOutside: boundary, reason: 'frozen assignment', imposedBy: 'benchmark-host' };
  const check = (toolName: string, args: unknown) => evaluateSessionConfinement({ toolName, args, confinement });
  const own = { slug: `${boundary.scratchPrefix}solution`, harness: boundary.harness };

  it('admits exact private draft authoring and refuses activation even under a broader ceiling', () => {
    expect(validScratchPlanBoundary(boundary)).toBe(true);
    expect(check('plans:new', { ...own, title: 'Solve task', status: 'draft', force: true }).allowed).toBe(true);
    expect(check('plans:add-item', { ...own, text: 'Inspect the failing case' }).allowed).toBe(true);
    expect(check('plans:get', own).allowed).toBe(true);
    for (const tool of SCRATCH_PLAN_TOOLS.filter(name => !BENCHMARK_SCRATCH_PLAN_TOOLS.includes(name)))
      expect(check(tool, { ...own, dryRun: true }).allowed).toBe(false);
    for (const status of [undefined, 'ready', 'active', 'shipped'])
      expect(check('plans:new', { ...own, title: 'Bad activation', status, force: true }).allowed).toBe(false);
    expect(check('plans:new', { ...own, title: 'Dedup inference', status: 'draft' }).allowed).toBe(false);
  });
  it('rejects foreign namespaces, harness aliases, multi-plan selectors and nested cross-plan writes', () => {
    for (const args of [{ ...own, slug: 'shared-plan' }, { ...own, slug: 'benchmark-scratch-other123456-solution' },
      { ...own, harness: 'neighbor' }, { slug: own.slug }, { ...own, slugs: [own.slug, 'neighbor'] },
      { ...own, sourceRanges: [{ session: 'self' }] }])
      expect(check('plans:get', args)).toMatchObject({ allowed: false, matchedGlob: 'outside-exact-scratch-plan' });
    expect(check('plans:add-item', { ...own, items: [{ slug: 'shared-plan', text: 'Foreign' }] }).allowed).toBe(false);
    expect(check('plans:new', { ...own, status: 'draft', force: true, content: boundary.reviewedSlug }).allowed).toBe(false);
    expect(evaluateSessionConfinement({ toolName: 'plans:get', args: own,
      confinement: { ...confinement, denyOutside: ['coord:whoami'] } }).allowed).toBe(false);
  });
});

describe('session confinement — exact product test path families', () => {
  const base = {
    harness: 'papercusp',
    docsHarness: 'engineering',
    docsSlugs: ['agent-insights/product-guide'],
  };

  it.each([
    ['Playwright spec', 'apps/operator/e2e/remote-access-setup.spec.ts'],
    ['unit test', 'packages/operator-core/lib/capability-envelope/session-confinement.test.ts'],
  ])('accepts an exact nominated %s path', (_label, testFile) => {
    expect(validProductReadBoundary({ ...base, testFiles: [testFile] })).toBe(true);
  });

  it.each([
    ['product source', 'apps/operator/src/remote-access.tsx'],
    ['plan artifact', 'plans/remote-access.md'],
    ['path traversal', '../outside/remote-access.spec.ts'],
    ['non-test fixture', 'apps/operator/e2e/remote-access.fixture.ts'],
  ])('rejects a %s path from the test-file boundary', (_label, testFile) => {
    expect(validProductReadBoundary({ ...base, testFiles: [testFile] })).toBe(false);
  });
});

describe('session confinement — basic gate', () => {
  it('is inert for an unconfined session, and says so via applied:false', () => {
    const d = evaluateSessionConfinement({ toolName: 'work_items:complete' });
    expect(d.allowed).toBe(true);
    expect(d.applied).toBe(false);
  });

  it('treats an empty denyTools list as unconfined rather than as deny-all', () => {
    const d = evaluateSessionConfinement({
      toolName: 'work_items:complete',
      confinement: { denyTools: [], reason: 'r', imposedBy: 'x' },
    });
    expect(d.allowed).toBe(true);
    expect(d.applied).toBe(false);
  });

  it('refuses each tool in the D-004 minimum set', () => {
    for (const tool of ['work_items:complete', 'scheduler:get_next', 'loop:arm']) {
      expect(evaluate(tool).allowed, `${tool} must be denied`).toBe(false);
    }
  });

  it('names the imposer, the reason and the matched glob in the refusal', () => {
    const d = evaluate('work_items:complete');
    expect(d.allowed).toBe(false);
    expect(d.matchedGlob).toBe('work_items:complete');
    expect(d.reason).toContain('su-director-1');
    expect(d.reason).toContain('WI-1234');
  });

  it('matches globs, so the self-lift surface cannot be reached by a sibling verb', () => {
    expect(evaluate('capability_envelope:set_protected').allowed).toBe(false);
    expect(evaluate('meta:define-tool').allowed).toBe(false);
    expect(evaluate('meta:define-datatype').allowed).toBe(false);
  });
});

describe('session confinement — the collateral the capability grain got wrong', () => {
  // This is the regression that motivated a tool-grain gate at all (D-015 ¶4):
  // work_items:complete and scheduler:get_next both declare capability
  // 'work_items:write', which is shared by 43 tools. A capability-grain deny would
  // take the implementer's own progress-recording down with the target.
  it.each([
    'work_items:checkpoint',
    'work_items:comment',
    'work_items:claim',
    'work_items:create',
    'work_items:set_state',
    'coord:send',
    'testing:run',
    'capability:bash',
  ])('leaves %s reachable — the implementer still has to do its job', (tool) => {
    expect(evaluate(tool).allowed).toBe(true);
  });

  it('denies claim_next but not claim — self-acquisition is the target, not claiming', () => {
    expect(evaluate('work_items:claim_next').allowed).toBe(false);
    expect(evaluate('work_items:claim').allowed).toBe(true);
  });
});

describe('session confinement — client name mangling cannot bypass it', () => {
  it('folds both spellings onto one match key', () => {
    expect(toDenyMatchKey('mcp__papercusp-su__work_items_complete')).toBe(
      'work_items_complete',
    );
    expect(toDenyMatchKey('work_items:complete')).toBe('work_items_complete');
    // The underscore-bearing verb that makes reconstructing the colon unsound.
    expect(toDenyMatchKey('mcp__papercusp-su__scheduler_get_next')).toBe(
      toDenyMatchKey('scheduler:get_next'),
    );
  });

  it('denies the mangled spelling too — a denial that catches one spelling is not a denial', () => {
    expect(evaluate('mcp__papercusp-su__work_items_complete').allowed).toBe(false);
    expect(evaluate('mcp__papercusp-su__scheduler_get_next').allowed).toBe(false);
  });

  it('agrees between the two spellings for every tool in the deny set', () => {
    for (const glob of DIRECTED_IMPLEMENTER_DENY_TOOLS) {
      if (glob.includes('*')) continue; // globs have no single mangled spelling
      const mangled = `mcp__papercusp-su__${glob.replace(':', '_')}`;
      expect(evaluate(glob).allowed, glob).toBe(false);
      expect(evaluate(mangled).allowed, mangled).toBe(false);
    }
  });
});

describe('session confinement — the wiring invariant is itself falsifiable', () => {
  it('passes for a gate that actually consults the confinement', () => {
    expect(() => assertConfinementCoversIndirectDispatch(evaluate)).not.toThrow();
  });

  // Falsifiability control: a gate wired ONLY at the outer boundary looks exactly like
  // this from the dispatch seat — it allows everything it is asked about. If this
  // assertion ever stops throwing, the invariant has become decorative.
  it('throws for a gate that is not consulted at the dispatch seat', () => {
    const notWired = () => ({ allowed: true, applied: false });
    expect(() => assertConfinementCoversIndirectDispatch(notWired)).toThrow(
      /not consulted at the dispatch seat/,
    );
  });
});

describe('session confinement — exact tool ceiling', () => {
  const confinement = { denyTools: ['work_items:claim_next'],
    denyOutside: ['work_items:get', 'work_items:complete', 'tools:invoke'],
    reason: 'native benchmark has one metered inference route', imposedBy: 'benchmark-host' };

  it.each(['capability:bash', 'consult:get_feedback', 'new_provider:infer',
    'mcp__papercusp-su__work_items_get', 'work_items_get'])('denies unlisted %s, including ambiguous aliases', toolName => {
    expect(evaluateSessionConfinement({ toolName, confinement }).allowed).toBe(false);
  });
  it.each(['work_items:get', 'work_items:complete', 'tools:invoke'])('keeps canonical %s available to ordinary gates', toolName => {
    expect(evaluateSessionConfinement({ toolName, confinement }).allowed).toBe(true);
  });
  it('cannot use the ceiling to lift an explicit denial', () => {
    expect(evaluateSessionConfinement({ toolName: 'work_items:get',
      confinement: { ...confinement, denyTools: ['work_items:*'] } }).allowed).toBe(false);
  });
  it('treats an empty ceiling as deny everything', () => {
    expect(evaluateSessionConfinement({ toolName: 'work_items:get',
      confinement: { ...confinement, denyTools: [], denyOutside: [] } }).allowed).toBe(false);
  });
});

describe('session confinement — exact assignment arguments', () => {
  const confinement = { denyTools: [], denyOutside: ['coord:whoami', 'work_items:get', 'work_items:checkpoint', 'work_items:complete'],
    denyWorkItemsOutside: { id: 'F-bench', harness: 'bench-private', checkout: '/private/assignment' }, reason: 'frozen assignment', imposedBy: 'host' };
  const own = { id: 'F-bench', harness: 'bench-private' };
  const completion = { summary: 'Implemented task', testsRun: ['npm test'], testResult: 'pass', verifiedHow: 'local tests', filesChanged: ['src/task.ts'] };
  const evaluate = (toolName: string, args: unknown) => evaluateSessionConfinement({ toolName, args, confinement });
  it('permits the maintained single-item read, progress and evidence completion workflow', () => {
    expect(evaluate('work_items:get', { ...own, resume: true }).allowed).toBe(true);
    expect(evaluate('work_items:checkpoint', { ...own, append: true, checkpoint: { did: 'implemented', next: 'test' } }).allowed).toBe(true);
    expect(evaluate('work_items:complete', { ...own, state: 'done', assumptions: 'none', completion }).allowed).toBe(true);
    expect(evaluate('coord:whoami', {}).allowed).toBe(true);
  });
  it('permits only an empty managed self-compaction request inside an exact assignment', () => {
    const policy = { ...confinement, denyOutside: [...confinement.denyOutside, 'session:request-compaction'] };
    const evaluateCarry = (args: unknown) => evaluateSessionConfinement({
      toolName: 'session:request-compaction', args, confinement: policy });
    expect(evaluateCarry({}).allowed).toBe(true);
    expect(evaluateSessionConfinement({ toolName: 'session:request-compaction',
      confinement: policy, purpose: 'listing' }).allowed).toBe(true);
    for (const args of [undefined, null, [], { focus: 'WI-other' }, { continueNote: 'Use another assignment' },
      { autoContinue: true }, { respawn: true }, { ownerId: 'su-other' }, { reason: 'caller hint' }])
      expect(evaluateCarry(args)).toMatchObject({ allowed: false, matchedGlob: 'outside-exact-carry' });
    expect(evaluate('session:request-compaction', {}).allowed).toBe(false);
    expect(evaluateSessionConfinement({ toolName: 'session:request-compaction', args: {},
      confinement: { ...policy, denyTools: ['session:*'] } }).allowed).toBe(false);
  });
  it('exposes permitted metadata only when the host explicitly requests listing; missing dispatch args still deny', () => {
    for (const toolName of ['work_items:get', 'work_items:checkpoint', 'work_items:complete']) {
      expect(evaluateSessionConfinement({ toolName, confinement, purpose: 'listing' }).allowed).toBe(true);
      expect(evaluateSessionConfinement({ toolName, confinement }).allowed).toBe(false);
    }
    expect(evaluateSessionConfinement({ toolName: 'capability:bash', confinement, purpose: 'listing' }).allowed).toBe(false);
  });
  it('permits enumerated coverage required by a scoped verification completion', () => {
    const coverage = { population: ['task implementation', 'local verification'],
      checked: ['task implementation', 'local verification'], notChecked: [], notApplicable: [], residue: [] };
    expect(evaluate('work_items:complete', { ...own, state: 'done', assumptions: 'none',
      completion: { ...completion, verification: { coverage } } }).allowed).toBe(true);
    expect(evaluate('work_items:complete', { ...own, state: 'done', assumptions: 'none',
      completion: { ...completion, verification: { coverage: { population: ['task'], checked: ['task'], residue: ['none'] } } } }).allowed).toBe(true);
  });
  it.each([null, [], {}, { probes: [] },
    { coverage: null }, { coverage: [] }, { coverage: { population: [], residue: [] } },
    { coverage: { population: ['task'], checked: [{ ref: 'WI-other' }], residue: [] } },
    { coverage: { population: ['task'], checked: ['task'], residue: ['WI-other'] } },
    { coverage: { population: ['task'], checked: ['task'], residue: [], filesChanged: ['/etc/passwd'] } },
    { coverage: { population: ['task'], checked: ['task'], residue: [] }, probes: [{ tool: 'consult:get_feedback' }] },
  ])('refuses malformed coverage and verification side effects %j', verification => {
    expect(evaluate('work_items:complete', { ...own, state: 'done', assumptions: 'none',
      completion: { ...completion, verification } }).allowed).toBe(false);
  });
  it.each([undefined, {}, { ...own, id: 'F-neighbor' }, { ...own, harness: 'other' },
    { ...own, ids: ['F-bench', 'F-neighbor'] }, { ...own, items: [{ id: 'F-neighbor' }] },
    { ...own, priorAttemptRefs: ['thread-post:other'] }, { ...own, workItem: 'F-neighbor' },
    { ...own, confinement: { denyWorkItemsOutside: own } }])('refuses ambiguous or unrelated read arguments %j', args => {
    expect(evaluate('work_items:get', args)).toMatchObject({ allowed: false, matchedGlob: 'outside-exact-work-item' });
  });
  it('denies checkpoint probes and cross-plan publication while preserving ordinary progress', () => {
    for (const extra of [{ checks: [{ tool: 'consult:get_feedback' }] }, { dependsOn: ['WI-other'] }, { learned: 'publish', learnedLevel: 'plan' }])
      expect(evaluate('work_items:checkpoint', { ...own, checkpoint: 'progress', ...extra }).allowed).toBe(false);
  });
  it('admits the change-kind declaration a successful close requires, on the assigned item only', () => {
    const declared = { ...own, state: 'done', assumptions: 'none', completion };
    expect(evaluate('work_items:complete', { ...declared, changeKinds: ['logic'] }).allowed).toBe(true);
    expect(evaluate('work_items:complete', { ...declared, changeKinds: ['logic', 'test-only'],
      changeKindReason: 'first declared at close' }).allowed).toBe(true);
    expect(evaluate('work_items:complete', { ...declared, id: 'F-neighbor', changeKinds: ['logic'] }).allowed).toBe(false);
    for (const extra of [{ changeKinds: [] }, { changeKinds: 'logic' }, { changeKinds: ['not-a-kind'] }, { changeKinds: [{ kind: 'logic' }] },
      { changeKinds: ['logic'], changeKindReason: '' }, { changeKinds: ['logic'], changeKindReason: '   ' },
      { changeKinds: ['logic'], changeKindReason: 'x'.repeat(1001) }, { changeKinds: ['logic'], changeKindReason: ['why'] },
      { changeKinds: ['logic'], changeKindRefs: ['WI-other'] }])
      expect(evaluate('work_items:complete', { ...declared, ...extra }).allowed).toBe(false);
    // Per-kind proof can name artifacts the server reads; it stays outside the boundary.
    expect(evaluate('work_items:complete', { ...declared, changeKinds: ['ui'],
      completion: { ...completion, kindEvidence: [{ kind: 'ui', artifacts: ['/etc/passwd'] }] } }).allowed).toBe(false);
  });
  it('denies completion side effects, reference assumptions and file proof escapes', () => {
    for (const extra of [{ items: [{ id: 'F-neighbor' }] }, { outputPayload: {} }, { assumptions: ['fact:other'] }])
      expect(evaluate('work_items:complete', { ...own, state: 'done', assumptions: 'none', completion, ...extra }).allowed).toBe(false);
    for (const extra of [{ duplicateOf: 'WI-other' }, { verification: { probes: [] } }])
      expect(evaluate('work_items:complete', { ...own, state: 'done', assumptions: 'none', completion: { ...completion, ...extra } }).allowed).toBe(false);
    for (const path of ['/etc/passwd', '../neighbor/file', 'src/../../neighbor', 'C:\\private', 'src\\..\\private'])
      expect(evaluate('work_items:complete', { ...own, state: 'done', assumptions: 'none', completion: { ...completion, filesChanged: [path] } }).allowed).toBe(false);
  });
  it('cannot lift a tool denial and fails closed on malformed host scope', () => {
    expect(evaluateSessionConfinement({ toolName: 'work_items:get', args: own, confinement: { ...confinement, denyTools: ['work_items:*'] } }).allowed).toBe(false);
    expect(evaluateSessionConfinement({ toolName: 'coord:whoami', args: {}, confinement: { ...confinement, denyWorkItemsOutside: {} as never } }).allowed).toBe(false);
  });
});

describe('session confinement — structural guarantees, pinned to the source', () => {
  // Subject path is overridable so this guard can be falsifiability-probed against a
  // COPY outside the tree (scripts/mutation-probe.sh tier 2) instead of by mutating the
  // shared checkout, which git-sync would happily commit mid-probe.
  const SUBJECT = process.env.PROBE_SESSION_CONFINEMENT_SRC ?? join(__dirname, 'session-confinement.ts');
  const SOURCE = readFileSync(SUBJECT, 'utf8');
  // Strip the header/JSDoc prose: the comments legitimately DISCUSS isSuperuser and
  // allowTools, and a guard that cannot tell prose from code would be unfixable.
  const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  // Calibration — proves the stripped-code corpus is real and non-empty, so the two
  // absence assertions below cannot pass merely because CODE came out blank.
  it('calibration: the stripped source still contains the gate itself', () => {
    expect(CODE).toContain('evaluateSessionConfinement');
    expect(CODE).toContain('denyTools');
    expect(CODE.length).toBeGreaterThan(500);
  });

  // Guarantee (A): it cannot be bypassed by privilege because it never receives it.
  it('never references privilege — there is no privilege check to get wrong', () => {
    expect(CODE).not.toMatch(/isSuperuser|isPowerUser/);
    expect(CODE).not.toMatch(/UnifiedToolContext/);
  });

  // Guarantee (B): it cannot widen because it has no allow vocabulary.
  it('has no allow dimension — the worst a bad confinement can do is deny more', () => {
    expect(CODE).not.toMatch(/allowTools|allowCapabilities/);
  });

  it('the deny set is documented — every entry sits under an explaining comment', () => {
    // The deny list is the part a future reader is most tempted to trim; the comments
    // are what make trimming a decision rather than a cleanup.
    const block = SOURCE.slice(SOURCE.indexOf('DIRECTED_IMPLEMENTER_DENY_TOOLS'));
    expect(block).toContain('D-004 minimum set');
    expect(block).toContain('Self-lift');
  });
});

describe('session confinement — the deny list is PINNED to the live tool catalog', () => {
  /**
   * Rung 2 of CLAUDE.md's derive/pin/attest ladder, for EI-21475119505876554.
   *
   * The deny list is hand-authored tool NAMES — a second copy of a truth the tool
   * catalog owns. Nothing checked them, and two entries (`capability:set-tier`,
   * `capability:set_protected`) resolved to NO tool for as long as they existed.
   *
   * Why every test ABOVE passes with a wrong name: they exercise the MATCHER against
   * the list, so `evaluate('capability:set-tier')` is denied precisely BECAUSE the list
   * contains that string. The list agreeing with itself is not evidence. Only the
   * catalog can falsify an entry.
   *
   * And the failure is silent by construction, which is why it needs a guard rather
   * than care: denying too MUCH fails loudly the first time an implementer is blocked
   * from real work; denying too LITTLE produces no error anywhere, and is
   * indistinguishable from a session with nothing to deny.
   *
   * Static discovery (mirroring __tests__/tool-data-shape-ratchet.test.ts, the repo's
   * established pattern) rather than importing the registry: importing agent-tools/index
   * pulls ~950 modules with side effects into a unit test.
   */
  const REPO = resolve(__dirname, '../../../..');

  function discoverToolNames(): Set<string> {
    const names = new Set<string>();
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith('.ts') || entry.includes('.test.') || entry.startsWith('index.')) continue;
        const src = readFileSync(full, 'utf8');
        if (!src.includes('defineTool(')) continue;
        // Tool names are `server:verb` — the colon is what separates a tool name from
        // every other `name:` literal a definition may carry (schemes, fixtures, args).
        for (const m of src.matchAll(/\bname:\s*'([^']+)'/g)) {
          if (m[1].includes(':')) names.add(m[1]);
        }
      }
    };
    walk(join(REPO, 'packages/agent-mcp/src/tools'));
    walk(join(REPO, 'packages/operator-core/lib/agent-tools'));
    return names;
  }

  const CATALOG = discoverToolNames();

  const toGlobRe = (glob: string) =>
    new RegExp(
      '^' + glob.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
    );

  // Calibration — a broken walk fails every assertion below, and this is what says the
  // WALK broke rather than the list being wrong. Without it, a red here is unreadable.
  it('calibration: the static walk finds a real catalog', () => {
    expect(CATALOG.size).toBeGreaterThan(500);
    for (const control of [
      'work_items:complete',
      'scheduler:get_next',
      'loop:arm',
      'capability_tier:set',
      'capability_envelope:set_role',
    ]) {
      expect(CATALOG.has(control), `control tool missing from walk: ${control}`).toBe(true);
    }
  });

  it('every exact entry names a tool that actually exists', () => {
    const dead = DIRECTED_IMPLEMENTER_DENY_TOOLS.filter((e) => !e.includes('*') && !CATALOG.has(e));
    expect(
      dead,
      'these deny entries resolve to NO tool, so they deny nothing while reading exactly ' +
        'like coverage. Fix the NAME (find the real one with tools:find) — do not delete ' +
        `the intent: ${dead.join(', ')}`,
    ).toEqual([]);
  });

  it('every glob entry matches at least one real tool', () => {
    const empty = DIRECTED_IMPLEMENTER_DENY_TOOLS.filter(
      (e) => e.includes('*') && ![...CATALOG].some((n) => toGlobRe(e).test(n)),
    );
    expect(
      empty,
      'these deny globs match no tool in the catalog — either the surface was renamed ' +
        '(re-point the glob) or it was retired (drop the entry deliberately, with a note): ' +
        `${empty.join(', ')}`,
    ).toEqual([]);
  });

  // The specific hole EI-21475119505876554 found, kept as a regression: the runtime
  // tier-override surface must stay covered under whatever spelling it carries.
  it('still covers the runtime tier-override surface — the hole this guard was built for', () => {
    expect(CATALOG.has('capability_tier:set')).toBe(true);
    expect(evaluate('capability_tier:set').allowed).toBe(false);
    expect(evaluate('mcp__papercusp-su__capability_tier_set').allowed).toBe(false);
  });
});
