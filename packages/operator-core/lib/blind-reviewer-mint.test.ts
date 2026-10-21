/**
 * WI-6554700010008492 / verification-system-improvements-2026-10-10#D-041, #D-042.
 *
 * The blind gap reviewer is confined to an exact tool ceiling. These tests pin three things:
 *   1. every ceiling entry names a real tool (a dead name grants nothing and reads like coverage);
 *   2. no ceiling entry belongs to a family that returns plan text, except the door itself;
 *   3. the mint launches under the system actor with the confinement attached under the
 *      launcher's symbol, so the dispatch seat sees it before the process starts.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { evaluateSessionConfinement, validScratchPlanBoundary } from './capability-envelope/session-confinement';
import { blindReviewScratchPrefix } from './blind-review-scratch-plans';
import type { BlindReviewBrief } from './blind-review-brief';
import { BLIND_REVIEW_TOOL } from './blind-review-gate';
import {
  BLIND_GAP_REVIEW_ACCOUNT,
  BLIND_GAP_REVIEW_ACTOR,
  BLIND_REVIEWER_TOOL_CEILING,
  blindReviewerConfinement,
  buildBlindReviewerKickoff,
  mintBlindGapReviewer,
} from './blind-reviewer-mint';

const REPO = resolve(__dirname, '../../..');

/** Static discovery, as in capability-envelope/session-confinement.test.ts: importing the
 * registry would pull ~950 modules with side effects into a unit test. Accepts both quote
 * styles because some definitions (dev:service_health) use double quotes. */
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
      for (const m of src.matchAll(/\bname:\s*['"]([^'"]+)['"]/g)) {
        if (m[1].includes(':')) names.add(m[1]);
      }
    }
  };
  walk(join(REPO, 'packages/agent-mcp/src/tools'));
  walk(join(REPO, 'packages/operator-core/lib/agent-tools'));
  return names;
}

/** Families whose tools return plan, rubric, evidence, or plan-derived text. */
const PLAN_TEXT_FAMILIES = [
  'plans', 'rubrics', 'scorecards', 'acceptance', 'search', 'sessions', 'memory',
  'work_items', 'cross_harness', 'docs', 'facts', 'orders', 'reports',
];

const SLUG = 'demo-plan-2026-10-11';
const CONFINEMENT = blindReviewerConfinement(SLUG);
const evaluate = (toolName: string) => evaluateSessionConfinement({ toolName, confinement: CONFINEMENT });

const BRIEF: BlindReviewBrief = {
  planSlug: SLUG,
  activationAuditSeq: 7,
  ownerTurns: [{ ref: 'claude:s1:3', text: 'Make the export button produce a CSV.' }],
  excludedRefs: [],
  text: 'Owner turn claude:s1:3:\nMake the export button produce a CSV.',
};

describe('blind reviewer tool ceiling — catalog truth', () => {
  const CATALOG = discoverToolNames();

  it('calibration: the static walk finds a real catalog, including double-quoted names', () => {
    expect(CATALOG.size).toBeGreaterThan(500);
    for (const control of ['plans:get', 'rubrics:get', 'work_items:complete', 'dev:service_health']) {
      expect(CATALOG.has(control), `control tool missing from walk: ${control}`).toBe(true);
    }
  });

  it('every ceiling entry names a tool that exists', () => {
    const dead = BLIND_REVIEWER_TOOL_CEILING.filter((name) => !CATALOG.has(name));
    expect(dead, `ceiling entries that resolve to no tool: ${dead.join(', ')}`).toEqual([]);
  });

  it('the ceiling holds no glob: denyOutside matches exact names only', () => {
    expect(BLIND_REVIEWER_TOOL_CEILING.filter((name) => name.includes('*'))).toEqual([]);
  });

  it('no ceiling entry is a plan-text family, except the door itself', () => {
    const leaks = BLIND_REVIEWER_TOOL_CEILING.filter(
      (name) => name !== BLIND_REVIEW_TOOL && PLAN_TEXT_FAMILIES.includes(name.split(':')[0]),
    );
    expect(leaks).toEqual([]);
    expect(BLIND_REVIEWER_TOOL_CEILING).toContain(BLIND_REVIEW_TOOL);
  });
});

describe('blind reviewer confinement — gate decisions', () => {
  it('allows only nominated product docs and bounded raw test-file history, never plan or bound-proof selectors', () => {
    const confinement = blindReviewerConfinement(SLUG, { harness: 'papercusp', docsHarness: 'engineering',
      docsSlugs: ['agent-insights/proving-a-guard-is-falsifiable'], testFiles: ['lib/probe.test.ts'] });
    const read = (toolName: string, args: unknown) => evaluateSessionConfinement({ toolName, args, confinement });
    const docs = { harness: 'engineering', slugs: ['agent-insights/proving-a-guard-is-falsifiable'] };
    const runs = { harness: 'papercusp', filePath: 'lib/probe.test.ts', source: 'mutation-probe', sinceHours: 24, limit: 20 };
    expect(read('docs:get', docs).allowed).toBe(true);
    expect(read('testing:runs', runs).allowed).toBe(true);
    const execute = { harness: 'papercusp', files: ['lib/probe.test.ts'], timeoutMs: 120000, maxFailures: 5 };
    expect(read('testing:run', execute).allowed).toBe(true);
    // WI-6554700010018202: a foreground timeout hands back a detached run id the reviewer must poll.
    expect(read('testing:run-status', { runId: '36ac0764-7ce6-424e-99f1-ec233bed8e7b' }).allowed).toBe(true);
    for (const args of [{}, { runId: '' }, { runId: '../x' }, { runId: 7 },
      { runId: 'abc', workItemId: 'WI-123' }, { runId: 'abc', harness: 'papercusp' }]) {
      expect(read('testing:run-status', args).allowed).toBe(false);
    }
    for (const args of [{ ...execute, files: ['lib/other.test.ts'] }, { ...execute, files: [] },
      { ...execute, files: ['lib/probe.test.ts', 'lib/other.test.ts'] }, { ...execute, harness: 'other' },
      { ...execute, evidence: { workItemId: 'WI-123', bindings: [] } },
      { ...execute, recoverEvidence: { workItemId: 'WI-123', runId: 'author-proof' } },
      { ...execute, remeasureEvidence: { workItemId: 'WI-123' } },
      { ...execute, changedPaths: ['lib/secret.ts'] }, { ...execute, root: '/other' },
      { ...execute, timeoutMs: 120001 }, { ...execute, maxFailures: 6 }]) {
      expect(read('testing:run', args).allowed).toBe(false);
    }
    expect(evaluate('testing:run').allowed).toBe(false); // A frozen legacy ceiling stays closed.
    expect(evaluate('testing:run-status').allowed).toBe(false);
    for (const args of [{ ...docs, slugs: ['other-guide'] }, { ...docs, harness: 'other' },
      { ...docs, source: true }, { ...docs, slug: docs.slugs[0], slugs: undefined }]) {
      expect(read('docs:get', args).allowed).toBe(false);
    }
    for (const args of [{ ...runs, filePath: 'probe' }, { ...runs, harness: 'other' },
      { ...runs, limit: 21 }, { ...runs, sinceHours: undefined }, { ...runs, source: 'ci' },
      { ...runs, testRunIds: [123] }, { ...runs, rollup: 'commit' }]) {
      expect(read('testing:runs', args).allowed).toBe(false);
    }
    for (const name of ['plans:get-spec-evidence', 'plans:get', 'rubrics:get', 'scorecards:get', 'reports:get', 'docs:search']) {
      expect(read(name, {}).allowed, name).toBe(false);
    }
    expect(evaluate('docs:get').allowed).toBe(false); // Legacy no-nomination ceiling stays closed.
    expect(Object.isFrozen(confinement.denyProductReadsOutside?.docsSlugs)).toBe(true);
    expect(Object.isFrozen(confinement.denyProductReadsOutside?.testFiles)).toBe(true);
  });

  it('refuses the plan-artifact reads the reviewer must not see', () => {
    for (const tool of [
      'plans:get', 'plans:get-specs', 'plans:get-spec-evidence', 'plans:items', 'plans:search',
      'rubrics:get', 'scorecards:list', 'search:semantic', 'search:fulltext', 'sessions:search',
      'sessions:read', 'memory:search', 'work_items:get', 'cross_harness:plans_get', 'coord:feed',
    ]) {
      const decision = evaluate(tool);
      expect(decision.allowed, `${tool} must be refused`).toBe(false);
      expect(decision.applied).toBe(true);
      expect(decision.matchedGlob).toBe('outside-exact-ceiling');
    }
  });

  it('refuses a mangled client spelling of a refused tool', () => {
    expect(evaluate('mcp__papercusp-su__plans_get').allowed).toBe(false);
  });

  it('refuses a tool registered after the ceiling was written', () => {
    expect(evaluate('plans:some-future-reader').allowed).toBe(false);
  });

  it('allows the door and every other ceiling entry', () => {
    for (const tool of BLIND_REVIEWER_TOOL_CEILING) {
      expect(evaluate(tool).allowed, `${tool} must be allowed`).toBe(true);
    }
  });

  it('names the imposer and the plan in a refusal', () => {
    const decision = evaluate('plans:get');
    expect(decision.reason).toContain(BLIND_GAP_REVIEW_ACTOR);
    expect(decision.reason).toContain(SLUG);
  });

  it('suppresses ambient context, which also carries plan text', () => {
    expect(CONFINEMENT.denyAmbientContext).toBe(true);
    expect(Object.isFrozen(CONFINEMENT)).toBe(true);
    expect(Object.isFrozen(BLIND_REVIEWER_TOOL_CEILING)).toBe(true);
  });
});

/**
 * verification-system-improvements-2026-10-10#D-050 (WI-6554700010018458): the reviewer may
 * author and exercise its OWN scratch plans, so a plan that ships plan-tool behaviour can be
 * reviewed. The reviewed plan, cross-plan selectors and every other plan-text family stay
 * refused.
 */
describe('blind reviewer scratch plans (D-050)', () => {
  const PREFIX = blindReviewScratchPrefix('abc123def456');
  const SCRATCH = { scratchPrefix: PREFIX, reviewedSlug: SLUG, harness: 'papercusp' };
  const SCRATCH_CONFINEMENT = blindReviewerConfinement(SLUG, undefined, SCRATCH);
  const plan = (toolName: string, args?: unknown) => evaluateSessionConfinement({ toolName, args, confinement: SCRATCH_CONFINEMENT });
  const MINE = `${PREFIX}probe`;
  const ADMITTED: Array<[string, Record<string, unknown>]> = [
    ['plans:new', { slug: MINE, title: 'Probe', harness: 'papercusp', verificationProfile: 'general', content: '# Probe' }],
    ['plans:add-item', { slug: MINE, text: 'Do x', importance: 'high', items: [{ text: 'Do y', blockedBy: ['P-001'] }] }],
    ['plans:set-status', { slug: MINE, item: 'P-001', status: 'done', note: 'checked' }],
    ['plans:audit', { slug: MINE, items: [{ itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'code', path: 'lib/x.ts' }] }] }],
    ['plans:get', { slug: MINE, heading: 'Items', itemIds: ['P-001'] }],
    ['plans:set-plan-status', { slug: MINE, status: 'shipped', dryRun: true }],
  ];

  it('admits the reviewer\'s own scratch plans through every scratch verb', () => {
    for (const [tool, args] of ADMITTED) expect(plan(tool, args).allowed, tool).toBe(true);
  });

  it('refuses the reviewed plan, an unprefixed slug, a bare prefix and a missing slug on every scratch verb', () => {
    for (const [tool, args] of ADMITTED) {
      for (const slug of [SLUG, 'other-plan-2026-10-20', PREFIX, `${PREFIX}${SLUG}`, `x${MINE}`, undefined]) {
        const decision = plan(tool, { ...args, slug });
        expect(decision.allowed, `${tool} ${String(slug)}`).toBe(false);
        expect(decision.matchedGlob).toBe('outside-exact-scratch-plan');
      }
      expect(plan(tool, undefined).allowed, `${tool} without args`).toBe(false);
    }
  });

  it('refuses a scratch call that names the reviewed plan in any field, so the ledger probe stays exact', () => {
    expect(plan('plans:new', { slug: MINE, title: 'Probe', content: `copy of ${SLUG}` }).allowed).toBe(false);
    expect(plan('plans:add-item', { slug: MINE, text: `see ${SLUG}#P-001` }).allowed).toBe(false);
  });

  it('refuses cross-plan selectors, out-of-list keys and a foreign harness', () => {
    const refused: Array<[string, Record<string, unknown>]> = [
      ['plans:get', { slug: MINE, slugs: ['other-plan-2026-10-20'] }],
      ['plans:get', { slug: MINE, priorAttemptRefs: ['WI-1'] }],
      ['plans:get', { slug: MINE, operationalBrief: true }],
      ['plans:get', { slug: MINE, itemIds: ['other-plan#P-001'] }],
      ['plans:get', { slug: MINE, decisionId: 'other-plan#D-001' }],
      ['plans:get', { slug: MINE, harness: 'other' }],
      ['plans:new', { slug: MINE, title: 'x', workspaceId: 'default' }],
      ['plans:new', { slug: MINE, title: 'x', force: true }],
      ['plans:add-item', { slug: MINE, text: 'x', items: [{ slug: 'other-plan-2026-10-20', text: 'y' }] }],
      ['plans:add-item', { slug: MINE, text: 'x', items: [{ text: 'y', harness: 'other' }] }],
      ['plans:add-item', { slug: MINE, text: 'x', blockedBy: ['other#P-001'] }],
      ['plans:set-status', { slug: MINE, items: [{ slug: 'other-plan-2026-10-20', item: 'P-001', status: 'done' }] }],
      ['plans:set-status', { slug: MINE, item: 'P-001', status: 'done', verification: { workItemId: 'WI-1' } }],
      ['plans:audit', { slug: MINE, findings: [{ summary: 'x', disposition: 'filed', ref: 'WI-1' }] }],
      ['plans:audit', { slug: MINE, phase: 'activation', sourceRanges: [{ session: 'claude:s1' }] }],
      ['plans:audit', { slug: MINE, classRef: 'plan-class-feature-ship' }],
      ['plans:audit', { slug: MINE, items: [{ itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'work-item', ref: 'WI-1' }] }] }],
      ['plans:set-plan-status', { slug: MINE, status: 'shipped' }],
      ['plans:set-plan-status', { slug: MINE, status: 'shipped', dryRun: false }],
      ['plans:set-plan-status', { slug: MINE, status: 'shipped', dryRun: true, force: { reason: 'x' } }],
      ['plans:set-plan-status', { slug: MINE, status: 'shipped', dryRun: true, slugs: [MINE] }],
    ];
    for (const [tool, args] of refused) {
      const decision = plan(tool, args);
      expect(decision.allowed, `${tool} ${JSON.stringify(args)}`).toBe(false);
      expect(decision.matchedGlob).toBe('outside-exact-scratch-plan');
    }
  });

  it('keeps every other plan, rubric and evidence family refused with the boundary in place', () => {
    for (const tool of ['plans:items', 'plans:search', 'plans:list', 'plans:get-spec-evidence', 'plans:set-archived',
      'cross_harness:plans_get', 'rubrics:get', 'scorecards:list', 'scorecards:emit', 'mcp__papercusp-su__plans_new']) {
      const decision = plan(tool, { slug: MINE });
      expect(decision.allowed, tool).toBe(false);
      expect(decision.matchedGlob).toBe('outside-exact-ceiling');
    }
  });

  it('admits the scratch verbs only together with the boundary', () => {
    expect(evaluate('plans:new').allowed).toBe(false);
    expect(evaluateSessionConfinement({ toolName: 'plans:new', args: { slug: MINE, title: 'x' }, confinement: CONFINEMENT }).matchedGlob)
      .toBe('outside-exact-ceiling');
    // A boundary that fails validation denies every tool, not just the plan verbs.
    const broken = { ...SCRATCH_CONFINEMENT, denyPlansOutside: { ...SCRATCH, scratchPrefix: 'blind-' } };
    for (const tool of ['plans:new', 'coord:whoami']) {
      expect(evaluateSessionConfinement({ toolName: tool, args: { slug: 'blind-x' }, confinement: broken }).allowed, tool).toBe(false);
    }
    // Listing executes nothing, so the boundary does not hide the verbs from the catalog.
    expect(evaluateSessionConfinement({ toolName: 'plans:new', confinement: SCRATCH_CONFINEMENT, purpose: 'listing' }).allowed).toBe(true);
  });

  it('mints a fresh prefix that can never match an ordinary plan slug', () => {
    expect(blindReviewScratchPrefix()).toMatch(/^blind-review-scratch-[a-f0-9]{12}-$/);
    expect(blindReviewScratchPrefix()).not.toBe(blindReviewScratchPrefix());
    expect(validScratchPlanBoundary(SCRATCH)).toBe(true);
    for (const scratchPrefix of ['blind-review-scratch-', 'blind-review-scratch-ab-', 'plan-', 'blind-review-scratch-ABC123def456-']) {
      expect(validScratchPlanBoundary({ ...SCRATCH, scratchPrefix }), scratchPrefix).toBe(false);
    }
    expect(validScratchPlanBoundary({ ...SCRATCH, extra: true })).toBe(false);
    expect(validScratchPlanBoundary({ ...SCRATCH, harness: 'all' })).toBe(false);
    expect(Object.isFrozen(SCRATCH_CONFINEMENT.denyPlansOutside)).toBe(true);
  });
});

describe('buildBlindReviewerKickoff', () => {
  it('carries the owner words, the run hint and the post call, and no plan text', () => {
    const kickoff = buildBlindReviewerKickoff(BRIEF, 'Boot it with scripts/verify-tauri-headless.sh');
    expect(kickoff).toContain('Make the export button produce a CSV.');
    expect(kickoff).toContain('Boot it with scripts/verify-tauri-headless.sh');
    expect(kickoff).toContain(`${BLIND_REVIEW_TOOL} { op: 'post', slug: '${SLUG}'`);
  });

  it('falls back to a discovery hint when no run hint is given', () => {
    expect(buildBlindReviewerKickoff(BRIEF, '  ')).toContain('dev:service_health');
    expect(buildBlindReviewerKickoff(BRIEF)).toContain('dev:service_health');
  });
});

describe('mintBlindGapReviewer', () => {
  const KEY = Symbol('test-confinement-key');

  function deps(brief: BlindReviewBrief | null = BRIEF) {
    const handler = vi.fn(async () => ({ ok: true, ownerId: 'su-reviewer-1' }));
    const loadBrief = vi.fn(async () => brief);
    const launcher = vi.fn(async () => ({ handler, confinementKey: KEY }));
    return { handler, loadBrief, launcher, deps: { loadBrief, launcher } };
  }

  it('attaches the nominated product read boundary before launch and supplies executable read hints', async () => {
    const d = deps();
    const productReads = { docsHarness: 'engineering', docsSlugs: ['agent-insights/product-guide'], testFiles: ['lib/probe.test.ts'] };
    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', productReads, ctx: { workspaceId: 'ws-1' } }, d.deps);
    expect(result.ok).toBe(true);
    const [args, ctx] = d.handler.mock.calls[0] as unknown as [{ brief: string }, Record<PropertyKey, unknown>];
    expect(ctx[KEY]).toMatchObject({ denyProductReadsOutside: { ...productReads, harness: 'papercusp' } });
    expect(args.brief).toContain("docs:get { harness: 'engineering', slugs: ['agent-insights/product-guide'] }");
    expect(args.brief).toContain("testing:runs { harness: 'papercusp', filePath: 'lib/probe.test.ts'");
    expect(args.brief).toContain("testing:run-status { runId: '<that id>' }");
  });

  it.each([{ testFiles: ['../outside.test.ts'] }, { docsHarness: '*' }, { testFiles: ['lib/source.ts'] }])('refuses an invalid product boundary before launch: %j', async productReads => {
    const d = deps();
    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', productReads, ctx: { workspaceId: 'ws-1' } }, d.deps);
    expect(result).toMatchObject({ ok: false, code: 'invalid_product_reads' });
    expect(d.handler).not.toHaveBeenCalled();
  });

  it('launches headless under the system actor with the confinement on the launcher key', async () => {
    const d = deps();
    const result = await mintBlindGapReviewer(
      { slug: SLUG, harness: 'papercusp', howToRun: 'run it', ctx: { workspaceId: 'ws-1', ownerId: 'su-author', isSuperuser: true } },
      d.deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activationAuditSeq).toBe(7);
    expect(d.loadBrief).toHaveBeenCalledWith({ workspaceId: 'ws-1', planSlug: SLUG, harnessSlug: 'papercusp' });
    expect(d.handler).toHaveBeenCalledTimes(1);
    const [args, ctx] = d.handler.mock.calls[0] as unknown as [Record<string, unknown>, Record<PropertyKey, unknown>];
    expect(args).toEqual({
      brief: result.kickoff,
      harness: 'papercusp',
      headless: true,
      agent: 'codex',
      account: 'auto',
      mcpTarget: 'spawn-host',
    });
    // The reviewer routes through the gateway pool, never the box's own system login: a
    // revoked/limited 'default' login killed every reviewer on its first turn
    // (WI-6554700010008650). Pinned to the literal so the constant cannot drift silently.
    expect(BLIND_GAP_REVIEW_ACCOUNT).toBe('auto');
    expect(args.account).not.toBe('default');
    // The caller's identity must not leak into the launch: the door rejects the author's lineage.
    expect(ctx.ownerId).toBe(BLIND_GAP_REVIEW_ACTOR);
    expect(ctx.isSuperuser).toBe(false);
    expect(ctx.principal).toEqual({ kind: 'system', slug: BLIND_GAP_REVIEW_ACTOR, workspaceId: 'ws-1' });
    expect(result.scratchPrefix).toMatch(/^blind-review-scratch-[a-f0-9]{12}-$/);
    expect(ctx[KEY]).toEqual(blindReviewerConfinement(SLUG, undefined,
      { scratchPrefix: result.scratchPrefix!, reviewedSlug: SLUG, harness: 'papercusp' }));
  });

  it('attaches a fresh scratch-plan boundary before launch and names its prefix in the kickoff (D-050)', async () => {
    const d = deps();
    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } }, d.deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [args, ctx] = d.handler.mock.calls[0] as unknown as [{ brief: string }, Record<PropertyKey, unknown>];
    const confinement = ctx[KEY] as ReturnType<typeof blindReviewerConfinement>;
    expect(confinement.denyPlansOutside).toEqual({ scratchPrefix: result.scratchPrefix, reviewedSlug: SLUG, harness: 'papercusp' });
    expect(confinement.denyOutside).toEqual(expect.arrayContaining(['plans:new', 'plans:get', 'plans:set-plan-status']));
    expect(confinement.denyOutside).not.toContain('plans:items');
    expect(args.brief).toContain(`${result.scratchPrefix}probe`);
    expect(args.brief).toContain('dryRun: true');
    // A refused call is still ledgered with its arguments, and the door's probe counts it.
    expect(args.brief).toContain('voids your review');
    const second = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } }, deps().deps);
    expect(second.ok && second.scratchPrefix).not.toBe(result.scratchPrefix);
  });

  it('binds the reviewer door to the spawning product runtime instead of the stable catalog', async () => {
    const d = deps();
    const result = await mintBlindGapReviewer(
      { slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } },
      d.deps,
    );
    const scratchPrefix = result.ok ? result.scratchPrefix! : '';
    expect(d.handler).toHaveBeenCalledWith(
      expect.objectContaining({ mcpTarget: 'spawn-host' }),
      expect.objectContaining({ [KEY]: blindReviewerConfinement(SLUG, undefined,
        { scratchPrefix, reviewedSlug: SLUG, harness: 'papercusp' }) }),
    );
  });

  it('refuses without a concrete workspace and loads nothing', async () => {
    for (const workspaceId of [undefined, '', '*']) {
      const d = deps();
      const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId } }, d.deps);
      expect(result).toMatchObject({ ok: false, code: 'workspace_required' });
      expect(d.loadBrief).not.toHaveBeenCalled();
      expect(d.handler).not.toHaveBeenCalled();
    }
  });

  it('refuses a plan with no activation audit and launches nothing', async () => {
    const d = deps(null);
    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } }, d.deps);
    expect(result).toMatchObject({ ok: false, code: 'no_activation_audit' });
    expect(d.handler).not.toHaveBeenCalled();
  });

  it.each(['no mapped sources', 'only excluded sources'] as const)('refuses an empty owner brief with %s before loading the launcher', async sourceCase => {
    const d = deps({
      ...BRIEF,
      ownerTurns: [],
      excludedRefs: sourceCase === 'only excluded sources'
        ? [{ ref: 'codex:unenrolled:1', reason: 'not-owner' }]
        : [],
    });
    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } }, d.deps);
    expect(result).toMatchObject({ ok: false, code: 'no_owner_turns' });
    expect(d.loadBrief).toHaveBeenCalledTimes(1);
    expect(d.launcher).not.toHaveBeenCalled();
    expect(d.handler).not.toHaveBeenCalled();
  });
});
