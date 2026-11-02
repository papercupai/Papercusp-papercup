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
  BLIND_REVIEWER_BACKENDS,
  launchProvablyNotStarted,
  BLIND_GAP_REVIEW_ACTOR,
  BLIND_REVIEWER_TOOL_CEILING,
  blindReviewerConfinement,
  buildBlindReviewerKickoff,
  mintBlindGapReviewer,
  resumeBlindGapReviewer,
} from './blind-reviewer-mint';
import { INTERNAL_BLIND_REVIEW_RESUME } from './blind-review-session-bindings';
import type { createBlindReviewSessionBinding } from './blind-review-session-bindings';
import type { FreshLaunchSessionProbe } from './agent-launch-core';
import { replacementFixture } from './__tests__/_blind-review-replacement-fixture';

const REPO = resolve(__dirname, '../../..');

describe('recruiter replacement protocol', () => {
  const fixture = () => replacementFixture(REPO, 'packages/operator-core/lib/blind-reviewer-mint.test.ts');
  it('unauthorized-caller: ignores forged owner fields and refuses the original reviewer itself', async () => {
    const f = fixture();
    for (const caller of ['su-stranger', 'su-original']) {
      expect(await f.run({ ctx: { workspaceId: 'ws-unit', principal: { kind: 'agent', slug: caller, workspaceId: 'ws-unit' }, ownerId: 'su-author' } }))
        .toMatchObject({ ok: false, error: 'recruiter_only' });
    }
    expect(f.launch).not.toHaveBeenCalled();
    expect(await f.run()).toMatchObject({ ok: true, attempt: { status: 'ready' } });
  });
  it('missing-product-test and exact-manifest: corrected nominations are immutable and reach confinement exactly', async () => {
    const f = fixture();
    expect(await f.run({ productReads: { testFiles: ['missing-product.test.ts'] } })).toMatchObject({ ok: false, error: 'invalid_product_reads' });
    const result = await f.run();
    expect(result).toMatchObject({ ok: true, attempt: { status: 'ready' } });
    const manifest = f.state.attempts[0].request_snapshot;
    const confinement = (f.launch.mock.calls[0][1] as Record<symbol, { denyProductReadsOutside: unknown }>)[f.key];
    expect(confinement.denyProductReadsOutside).toEqual((manifest as { productReads: unknown }).productReads);
    for (const files of [[], ['packages/operator-core/lib/blind-review-replacement.test.ts'],
      ['packages/operator-core/lib/blind-reviewer-mint.test.ts', 'packages/operator-core/lib/blind-review-replacement.test.ts']]) {
      expect(await f.run({ productReads: { testFiles: files } })).toMatchObject({ ok: false, error: 'request_conflict' });
    }
    expect(f.state.attempts[0].request_snapshot).toEqual(manifest);
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it.each(['conclusive', 'live', 'resuming', 'reserved'])('protected-state-%s: refuses changed eligibility before selecting an attempt', async kind => {
    const f = fixture();
    if (kind === 'conclusive') { f.state.material.outcome = 'conclusive'; f.state.material.summary = 'CONCLUSIVE: reviewed'; }
    if (kind === 'live') f.state.ended = false;
    if (kind === 'resuming') f.state.sourceStatus = 'resuming';
    if (kind === 'reserved') f.state.resumeClaim = 'resume-active';
    expect(await f.run()).toMatchObject({ ok: false, error: 'review_protected' });
    expect(f.launch).not.toHaveBeenCalled();
  });
  it('independent-replacement-identity: rejects related native receipts without releasing their reservation', async () => {
    const f = fixture(); f.deps.lineageRelated = async () => true;
    expect(await f.run()).toMatchObject({ ok: false, error: 'reviewer_not_independent' });
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.state.attempts[0]).toMatchObject({ status: 'uncertain', reviewer_owner_id: null });
  });
  it('recover-failed-launch: records no-process failures, preserves them, then succeeds on a new ordered request', async () => {
    const f = fixture();
    // A definite failure is every backend rung refusing before spawn (EI-27127088253419654).
    for (const _rung of BLIND_REVIEWER_BACKENDS) {
      f.launch.mockResolvedValueOnce({ isError: true, data: { launchFailure: { stage: 'pre-spawn', processesOpened: 0 } } });
    }
    expect(await f.run()).toMatchObject({ ok: true, attempt: { attemptSeq: 1, status: 'failed' } });
    expect(await f.run()).toMatchObject({ ok: true, deduped: true, attempt: { attemptSeq: 1 } });
    expect(await f.run({ requestKey: 'after-definite-failure' })).toMatchObject({ ok: true, attempt: { attemptSeq: 2, status: 'ready' } });
    expect(f.state.attempts.map(a => [a.attempt_seq, a.status])).toEqual([[1, 'failed'], [2, 'ready']]);
    expect(f.launch).toHaveBeenCalledTimes(BLIND_REVIEWER_BACKENDS.length + 1);
  });
  it('retry-one-active: an interleaved equivalent request observes the same attempt and launches only once', async () => {
    const f = fixture();
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
    f.launch.mockImplementationOnce(async () => { entered(); await gate; return { data: { launch: f.launchSummary } }; });
    const first = f.run(); await started;
    const duplicate = await f.run({ requestKey: 'equivalent-other-request' });
    expect(duplicate).toMatchObject({ ok: true, deduped: true, attempt: { id: 100, status: 'launching' } });
    release(); expect(await first).toMatchObject({ ok: true, attempt: { id: 100, status: 'ready' } });
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it('uncertain-launch-reconciliation: a lost reply stays excluded until the original ledger supplies exact native identity', async () => {
    const f = fixture(); f.launch.mockRejectedValueOnce(new Error('reply lost'));
    expect(await f.run()).toMatchObject({ ok: true, attempt: { status: 'uncertain' } });
    expect(await f.run({ requestKey: 'must-not-launch' })).toMatchObject({ ok: true, deduped: true, attempt: { status: 'uncertain' } });
    f.state.ledger = f.launchSummary;
    expect(await f.run()).toMatchObject({ ok: true, deduped: true, attempt: { status: 'ready', nativeSessionId: 'native-new' } });
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it('reconciles a delayed native id without requiring the frozen launch summary to change', async () => {
    const f = fixture();
    f.state.ledger = { ...f.launchSummary,
      freshVerdict: { sessions: [{ ownerId: 'su-new', advSessionId: 30, sessionId: null }] } };
    f.launch.mockResolvedValueOnce({ data: { launch: f.state.ledger } });
    expect(await f.run()).toMatchObject({ ok: true, attempt: { status: 'uncertain' } });
    f.state.delayedNative = { id: 30, workspace_id: 'ws-unit', coord_owner_id: 'su-new', session_id: null };
    expect(await f.run()).toMatchObject({ ok: true, deduped: true, attempt: { status: 'uncertain' } });
    f.state.delayedNative.session_id = 'native-delayed';
    expect(await f.run()).toMatchObject({ ok: true, deduped: true,
      attempt: { status: 'ready', reviewerOwnerId: 'su-new', advSessionId: 30, nativeSessionId: 'native-delayed' } });
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.bind).toHaveBeenCalledTimes(1);
    expect(f.state.ledger).toMatchObject({ freshVerdict: { sessions: [{ sessionId: null }] } });
  });
  it.each([
    { id: 31, workspace_id: 'ws-unit', coord_owner_id: 'su-new', session_id: 'foreign-native' },
    { id: 30, workspace_id: 'another-workspace', coord_owner_id: 'su-new', session_id: 'foreign-native' },
    { id: 30, workspace_id: 'ws-unit', coord_owner_id: 'su-other', session_id: 'foreign-native' },
  ])('keeps the reservation when delayed identity belongs to another launch: %j', async native => {
    const f = fixture();
    const summary = { ...f.launchSummary,
      freshVerdict: { sessions: [{ ownerId: 'su-new', advSessionId: 30, sessionId: null }] } };
    f.launch.mockResolvedValueOnce({ data: { launch: summary } });
    f.state.delayedNative = native;
    expect(await f.run()).toMatchObject({ ok: true, attempt: { status: 'uncertain' } });
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
});

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
  unverifiedTurns: [],
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
  it('permits guarded self-shutdown without opening coordination, plan, or proof reads', () => {
    expect(evaluate('session:end').allowed).toBe(true);
    for (const tool of ['coord:inbox', 'coord:send', 'session:request-compaction',
      'plans:get', 'rubrics:get', 'scorecards:get', 'work_items:get']) {
      expect(evaluate(tool).allowed, tool).toBe(false);
    }

    // Existing review bindings keep their frozen ceiling; a new mint must not
    // retroactively widen an already-launched reviewer's access.
    const legacy = { ...CONFINEMENT, denyOutside: CONFINEMENT.denyOutside!.filter(name => name !== 'session:end') };
    expect(evaluateSessionConfinement({ toolName: 'session:end', confinement: legacy }).allowed).toBe(false);
  });

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

  it('admits product registry reads and pack browsing without opening plan artifacts', () => {
    for (const [tool, args] of [
      ['plan-types:list', { harness: 'papercusp', kind: 'item-type' }],
      ['plan-types:get', { harness: 'papercusp', kind: 'plan-type', typeId: 'acme/checklist', revision: 1 }],
      ['cupboard:search', { kind: 'pack', q: 'checklist', limit: 10 }],
    ] as const) expect(plan(tool, args).allowed, tool).toBe(true);

    for (const [tool, args] of [
      ['plan-types:list', {}],
      ['plan-types:list', { harness: 'other' }],
      ['plan-types:get', { harness: 'papercusp', kind: 'plan-type', typeId: 'acme/checklist', slug: SLUG }],
      ['plan-types:list', { harness: 'papercusp', workItemId: 'WI-1' }],
      ['cupboard:search', {}],
      ['cupboard:search', { kind: 'all' }],
      ['cupboard:search', { kind: 'plan' }],
      ['cupboard:search', { kind: 'rubric' }],
      ['cupboard:search', { kind: 'pack', q: SLUG }],
      ['cupboard:search', { kind: 'pack', workspaceId: 'other' }],
    ] as const) expect(plan(tool, args).allowed, `${tool} ${JSON.stringify(args)}`).toBe(false);

    for (const tool of ['plan-types:define', 'plan-types:pin', 'plan-types:retire', 'cupboard:install-plugin'])
      expect(plan(tool, {}).allowed, tool).toBe(false);
  });

  it('allows duplicate-detection bypass only when creating its own isolated scratch plan', () => {
    const create = { slug: MINE, title: 'Independent product rehearsal', harness: 'papercusp', force: true };
    expect(plan('plans:new', create).allowed).toBe(true);
    for (const args of [{ ...create, slug: SLUG }, { ...create, slug: 'other-plan' },
      { ...create, harness: 'other' }, { ...create, force: 'true' }, { ...create, force: {} },
      { ...create, force: false }]) expect(plan('plans:new', args).allowed).toBe(false);
    expect(evaluateSessionConfinement({ toolName: 'plans:new', args: create, confinement: CONFINEMENT }).allowed).toBe(false);
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
    expect(kickoff).toContain("outcome: 'conclusive'");
    expect(kickoff).toContain("outcome: 'inconclusive'");
    expect(kickoff).toContain('Empty gaps alone do not complete a review.');
    expect(kickoff).toContain('After posting your review, call session:end');
  });

  it('falls back to a discovery hint when no run hint is given', () => {
    expect(buildBlindReviewerKickoff(BRIEF, '  ')).toContain('dev:service_health');
    expect(buildBlindReviewerKickoff(BRIEF)).toContain('dev:service_health');
  });
});

describe('mintBlindGapReviewer', () => {
  const KEY = Symbol('test-confinement-key');

  function deps(brief: BlindReviewBrief | null = BRIEF) {
    // Returns unknown, like the real launcher envelope, so a case can install a refusal.
    const handler = vi.fn(async (): Promise<unknown> => ({ data: { launch: {
      opened: 1,
      ownerIds: ['su-reviewer-1'],
      freshVerdict: { sessions: [{ ownerId: 'su-reviewer-1', advSessionId: 42, sessionId: 'native-review-1' }] },
      tasks: [{ taskId: 'task-reviewer-1' }],
    } } }));
    const loadBrief = vi.fn(async () => brief);
    const launcher = vi.fn(async () => ({ handler, confinementKey: KEY }));
    const binding = {
      id: 7, workspaceId: 'ws-1', harnessSlug: 'papercusp', planSlug: SLUG, activationAuditSeq: 7,
      reviewerOwnerId: 'su-reviewer-1', advSessionId: 42, nativeSessionId: 'native-review-1',
      launchParentOwner: BLIND_GAP_REVIEW_ACTOR, accountRoute: 'auto', modelSpec: null,
      confinementSnapshot: CONFINEMENT, status: 'ready' as const, resumeLeaseId: null,
      resumeLeaseExpiresAt: null, reviewId: null,
    };
    const createSessionBinding = vi.fn<typeof createBlindReviewSessionBinding>(async (input) => ({
      ok: true as const, created: true, binding: { ...binding, reviewerOwnerId: input.reviewerOwnerId, confinementSnapshot: input.confinement },
    }));
    const findSessionBinding = vi.fn(async () => null as typeof binding | null);
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    const acquireSessionResume = vi.fn(async () => ({ ok: true as const, binding: { ...binding, status: 'resuming' as const, resumeLeaseId: 'lease-1' }, leaseId: 'lease-1' }));
    const releaseSessionResume = vi.fn(async () => true);
    const readConfinement = vi.fn(async () => {
      const call = handler.mock.calls.at(-1) as unknown as [unknown, Record<symbol, ReturnType<typeof blindReviewerConfinement>>];
      return call?.[1][KEY] ?? null;
    });
    const knownTools = async () => new Set(['capability:bash', 'testing:run', 'work_items:create', 'coord:send', 'events:emit']);
    return { handler, loadBrief, launcher, binding, findSessionBinding, createSessionBinding, killTask,
      acquireSessionResume, releaseSessionResume, readConfinement,
      deps: { loadBrief, launcher, findSessionBinding, createSessionBinding, killTask,
        acquireSessionResume, releaseSessionResume, readConfinement, knownTools } };
  }

  // EI-27120299877087815: review #109 was told to call tools its ceiling refuses.
  it('refuses a howToRun naming a registered tool outside the ceiling before launching', async () => {
    const d = deps();
    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp',
      howToRun: 'Create a scratch item with work_items:create, then do not call coord:send.', ctx: { workspaceId: 'ws-1' } }, d.deps);
    expect(result).toMatchObject({ ok: false, code: 'how_to_run_outside_ceiling', refusedTools: ['coord:send', 'work_items:create'] });
    expect(result.ok === false && result.message).toContain('capability:bash');
    expect(d.launcher).not.toHaveBeenCalled();
    expect(d.handler).not.toHaveBeenCalled();
  });

  it('launches a howToRun naming only admitted tools and unregistered event keys', async () => {
    const d = deps();
    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp',
      howToRun: 'Use capability:bash; a park on work-item:done:WI-1 or events:custom-thing must clear.', ctx: { workspaceId: 'ws-1' } }, d.deps);
    expect(result.ok).toBe(true);
    expect(d.handler).toHaveBeenCalledTimes(1);
  });

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

  // launch-agent's err(): every refusal before the spawn loop carries this proof.
  const preSpawnRefusal = () => ({ isError: true, content: [{ type: 'text', text: 'account_walled' }],
    data: { ok: false, error: 'account_walled', launchFailure: { stage: 'pre-spawn', processesOpened: 0 } } });

  it('falls through to the next backend only when a launch is refused, and stops at the first that spawns', async () => {
    const d = deps();
    // First backend (claude opus) refused before spawn — e.g. every Claude account walled.
    d.handler.mockImplementationOnce(async () => preSpawnRefusal());
    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } }, d.deps);
    expect(result.ok).toBe(true);
    expect(d.handler).toHaveBeenCalledTimes(2);
    const agents = d.handler.mock.calls.map(c => (c as unknown as [{ agent: string; model?: string }])[0]);
    expect(agents.map(a => a.agent)).toEqual(BLIND_REVIEWER_BACKENDS.map(b => b.agent));
    expect(agents[0]).toMatchObject({ agent: 'claude', model: 'opus', effort: 'xhigh' });
    expect(agents[1]).toMatchObject({ agent: 'codex' });
    expect(agents[1]).not.toHaveProperty('model');
  });

  it('returns the last refusal when every backend refuses, without spawning past the ladder', async () => {
    const d = deps();
    const refusal = preSpawnRefusal();
    d.handler.mockImplementation(async () => refusal);
    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } }, d.deps);
    expect(d.handler).toHaveBeenCalledTimes(BLIND_REVIEWER_BACKENDS.length);
    expect(result).toMatchObject({ ok: true, launch: refusal, binding: null });
    expect(d.createSessionBinding).not.toHaveBeenCalled();
  });

  it('never falls through on an isError that does not prove no process started (it may follow a spawn)', async () => {
    const d = deps();
    const unproven = { isError: true, content: [{ type: 'text', text: 'verifier timed out after spawn' }] };
    d.handler.mockImplementation(async () => unproven);
    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } }, d.deps);
    expect(d.handler).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, launch: unproven, binding: null, launchStatus: 'uncertain' });
  });

  it('binds an exact native receipt carried with isError and reuses the activation launch key', async () => {
    const d = deps();
    const partial = { isError: true, data: { launch: { opened: 1, partial: true,
      ownerIds: ['su-reviewer-1'], freshVerdict: { sessions: [
        { ownerId: 'su-reviewer-1', advSessionId: 42, sessionId: 'native-review-1' },
      ] } } } };
    d.handler.mockResolvedValue(partial);
    const first = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } }, d.deps);
    const replay = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } }, d.deps);
    expect(first).toMatchObject({ ok: true, launchStatus: 'partial', binding: {
      reviewerOwnerId: 'su-reviewer-1', advSessionId: 42, nativeSessionId: 'native-review-1',
    } });
    expect(replay).toMatchObject({ ok: true, launchStatus: 'partial', binding: {
      reviewerOwnerId: 'su-reviewer-1', nativeSessionId: 'native-review-1',
    } });
    const keys = d.handler.mock.calls.map(call =>
      (call as unknown as [{ idempotencyKey: string }])[0].idempotencyKey);
    expect(keys[0]).toMatch(/^blind-review-mint:[a-f0-9]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(d.createSessionBinding).toHaveBeenCalledTimes(2);

    const nextActivation = deps({ ...BRIEF, activationAuditSeq: BRIEF.activationAuditSeq + 1 });
    await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } }, nextActivation.deps);
    const nextKey = (nextActivation.handler.mock.calls[0] as unknown as [{ idempotencyKey: string }])[0].idempotencyKey;
    expect(nextKey).not.toBe(keys[0]);
  });

  it('reuses the active activation binding before launch', async () => {
    const d = deps();
    d.findSessionBinding.mockResolvedValue(d.binding);

    const result = await mintBlindGapReviewer({
      slug: SLUG, harness: 'papercusp', requestKey: 'mint-retry-v1', ctx: { workspaceId: 'ws-1' },
    }, d.deps);

    expect(result).toMatchObject({
      ok: true, launchStatus: 'bound', binding: d.binding,
      launch: { data: { deduped: true, launch: { deduped: true, opened: 0, mode: 'deduped' } } },
    });
    expect(d.findSessionBinding).toHaveBeenCalledWith({ workspaceId: 'ws-1', planSlug: SLUG, activationAuditSeq: 7 });
    expect(d.launcher).not.toHaveBeenCalled();
    expect(d.handler).not.toHaveBeenCalled();
    expect(d.createSessionBinding).not.toHaveBeenCalled();
  });

  it('reconciles a completed launch whose verifier timed out, including same-key replay', async () => {
    const d = deps();
    const launch = { requestKind: 'capability:launch-agent', launchState: 'completed',
      mode: 'fresh', opened: 1, failed: 0, partial: false, expectedCount: 1,
      spawnAttempted: true, startedAt: 1700000000000, ownerIds: ['su-reviewer-1'],
      tasks: [{ taskId: 'task-reviewer-1', ownerId: 'su-reviewer-1' }] };
    d.handler.mockResolvedValue({ data: { launch } });
    const probeLaunchSessions = vi.fn(async () => [{ ownerId: 'su-reviewer-1',
      advSessionId: 42, sessionId: 'native-review-1' }] as FreshLaunchSessionProbe[]);
    const input = { slug: SLUG, harness: 'papercusp', requestKey: 'same-request', ctx: { workspaceId: 'ws-1' } };
    expect(await mintBlindGapReviewer(input, { ...d.deps, probeLaunchSessions }))
      .toMatchObject({ ok: true, launchStatus: 'bound', binding: { advSessionId: 42, nativeSessionId: 'native-review-1' } });
    d.handler.mockResolvedValue({ data: { deduped: true, launch: { ...launch, deduped: true } } });
    expect(await mintBlindGapReviewer(input, { ...d.deps, probeLaunchSessions }))
      .toMatchObject({ ok: true, launchStatus: 'bound', binding: { reviewerOwnerId: 'su-reviewer-1' } });
    expect(probeLaunchSessions).toHaveBeenCalledWith({ workspaceId: 'ws-1',
      launcherOwnerId: BLIND_GAP_REVIEW_ACTOR, since: launch.startedAt, expectedOwnerIds: ['su-reviewer-1'] });
    expect(d.handler).toHaveBeenCalledTimes(2);
    const keys = d.handler.mock.calls.map(call => (call as unknown as [{ idempotencyKey: string }])[0].idempotencyKey);
    expect(keys[1]).toBe(keys[0]);
    expect(d.createSessionBinding).toHaveBeenCalledTimes(2);
  });

  it('reports the persisted scratch scope when the activation is already bound', async () => {
    const d = deps();
    const scratch = { scratchPrefix: 'blind-review-scratch-aabbccddeeff-', reviewedSlug: SLUG, harness: 'papercusp' };
    d.findSessionBinding.mockResolvedValue({ ...d.binding,
      confinementSnapshot: blindReviewerConfinement(SLUG, undefined, scratch) });
    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } }, d.deps);
    expect(result).toMatchObject({ ok: true, scratchPrefix: scratch.scratchPrefix });
    expect(result.ok && result.kickoff).toContain(scratch.scratchPrefix);
    expect(d.launcher).not.toHaveBeenCalled();
  });

  it.each([
    [],
    [{ ownerId: 'su-other', advSessionId: 42, sessionId: 'native-other' }],
    [{ ownerId: 'su-reviewer-1', advSessionId: 0, sessionId: 'native-review-1' }],
    [{ ownerId: 'su-reviewer-1', advSessionId: 42, sessionId: null }],
    [{ ownerId: 'su-reviewer-1', advSessionId: 42, sessionId: 'native-review-1' },
      { ownerId: 'su-reviewer-1', advSessionId: 43, sessionId: 'native-review-2' }],
  ].map(sessions => ({ sessions })))('keeps ambiguous completed-launch identities unbound: %j', async ({ sessions }) => {
    const d = deps();
    d.handler.mockResolvedValue({ data: { launch: { requestKind: 'capability:launch-agent',
      launchState: 'completed', mode: 'fresh', opened: 1, failed: 0, partial: false,
      expectedCount: 1, spawnAttempted: true, startedAt: 1700000000000,
      ownerIds: ['su-reviewer-1'], tasks: [{ ownerId: 'su-reviewer-1' }] } } });
    const probeLaunchSessions = vi.fn(async () => sessions as FreshLaunchSessionProbe[]);
    expect(await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } },
      { ...d.deps, probeLaunchSessions })).toMatchObject({ ok: true, launchStatus: 'uncertain', binding: null });
    expect(d.createSessionBinding).not.toHaveBeenCalled();
    expect(d.handler).toHaveBeenCalledTimes(1);
  });

  it.each([
    { launchState: 'spawning' }, { partial: true }, { spawnAttempted: false },
    { tasks: [{ ownerId: 'su-other' }] }, { startedAt: 0 },
    { freshVerdict: { sessions: [] } },
  ])('does not reconcile incomplete or contradictory launch evidence: %j', async changed => {
    const d = deps();
    d.handler.mockResolvedValue({ data: { launch: { requestKind: 'capability:launch-agent',
      launchState: 'completed', mode: 'fresh', opened: 1, failed: 0, partial: false,
      expectedCount: 1, spawnAttempted: true, startedAt: 1700000000000,
      ownerIds: ['su-reviewer-1'], tasks: [{ ownerId: 'su-reviewer-1' }], ...changed } } });
    const probeLaunchSessions = vi.fn(async () => [] as FreshLaunchSessionProbe[]);
    expect(await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } },
      { ...d.deps, probeLaunchSessions })).toMatchObject({ ok: true, launchStatus: 'uncertain' });
    expect(probeLaunchSessions).not.toHaveBeenCalled();
    expect(d.createSessionBinding).not.toHaveBeenCalled();
  });

  it('preserves the original scratch boundary when reconciling a same-key reviewer launch', async () => {
    const d = deps();
    const scratch = { scratchPrefix: 'blind-review-scratch-aabbccddeeff-', reviewedSlug: SLUG, harness: 'papercusp' };
    const original = blindReviewerConfinement(SLUG, undefined, scratch);
    d.readConfinement.mockResolvedValue(original);
    d.handler.mockResolvedValue({ data: { launch: { requestKind: 'capability:launch-agent',
      launchState: 'completed', mode: 'deduped', opened: 1, failed: 0, partial: false,
      expectedCount: 1, spawnAttempted: true, startedAt: 1700000000000,
      ownerIds: ['su-reviewer-1'], tasks: [{ taskId: 'original-task', ownerId: 'su-reviewer-1' }] } } });
    d.createSessionBinding.mockImplementation(async input => {
      expect(input.confinement).toEqual(original);
      return { ok: true, created: true, binding: { ...d.binding, confinementSnapshot: input.confinement } };
    });
    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp',
      requestKey: 'original-request', ctx: { workspaceId: 'ws-1' } }, { ...d.deps,
      probeLaunchSessions: async () => [{ ownerId: 'su-reviewer-1', advSessionId: 42, sessionId: 'native-review-1' } as FreshLaunchSessionProbe] });
    expect(result).toMatchObject({ ok: true, launchStatus: 'bound', scratchPrefix: scratch.scratchPrefix });
    expect(result.ok && result.kickoff).toContain(scratch.scratchPrefix);
    expect(d.readConfinement).toHaveBeenCalledWith('su-reviewer-1', 'ws-1');
    expect(d.handler).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'missing declaration', change: () => null },
    { label: 'expired effective ceiling', change: (c: ReturnType<typeof blindReviewerConfinement>) => ({ ...c, denyOutside: [], reason: 'launch ceiling expired' }) },
    { label: 'changed ceiling', change: (c: ReturnType<typeof blindReviewerConfinement>) => ({ ...c, denyOutside: [...c.denyOutside!, 'coord:send'] }) },
    { label: 'changed product reads', change: (c: ReturnType<typeof blindReviewerConfinement>) => ({ ...c, denyProductReadsOutside: { harness: 'papercusp', docsHarness: 'papercusp', docsSlugs: [], testFiles: ['other.test.ts'] } }) },
    { label: 'changed plan', change: (c: ReturnType<typeof blindReviewerConfinement>) => ({ ...c, denyPlansOutside: { ...c.denyPlansOutside!, reviewedSlug: 'another-plan' } }) },
    { label: 'changed harness', change: (c: ReturnType<typeof blindReviewerConfinement>) => ({ ...c, denyPlansOutside: { ...c.denyPlansOutside!, harness: 'another-harness' } }) },
    { label: 'invalid prefix', change: (c: ReturnType<typeof blindReviewerConfinement>) => ({ ...c, denyPlansOutside: { ...c.denyPlansOutside!, scratchPrefix: 'blind-' } }) },
    { label: 'changed attribution', change: (c: ReturnType<typeof blindReviewerConfinement>) => ({ ...c, imposedBy: 'su-author' }) },
  ])('refuses reconciled identity with $label instead of changing its confinement', async ({ change }) => {
    const d = deps();
    const original = blindReviewerConfinement(SLUG, undefined,
      { scratchPrefix: 'blind-review-scratch-aabbccddeeff-', reviewedSlug: SLUG, harness: 'papercusp' });
    d.readConfinement.mockResolvedValue(change(original));
    d.handler.mockResolvedValue({ data: { launch: { requestKind: 'capability:launch-agent',
      launchState: 'completed', mode: 'deduped', opened: 1, failed: 0, partial: false,
      expectedCount: 1, spawnAttempted: true, startedAt: 1700000000000,
      ownerIds: ['su-reviewer-1'], tasks: [{ ownerId: 'su-reviewer-1' }] } } });
    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } },
      { ...d.deps, probeLaunchSessions: async () => [{ ownerId: 'su-reviewer-1', advSessionId: 42,
        sessionId: 'native-review-1' } as FreshLaunchSessionProbe] });
    expect(result).toMatchObject({ ok: false, code: 'session_binding_failed',
      message: expect.stringContaining('confinement') });
    expect(d.createSessionBinding).not.toHaveBeenCalled();
    expect(d.handler).toHaveBeenCalledTimes(1);
  });

  it('reports an unavailable reconciliation probe without launching another reviewer', async () => {
    const d = deps();
    d.handler.mockResolvedValue({ data: { launch: { requestKind: 'capability:launch-agent',
      launchState: 'completed', mode: 'fresh', opened: 1, failed: 0, partial: false,
      expectedCount: 1, spawnAttempted: true, startedAt: 1700000000000,
      ownerIds: ['su-reviewer-1'], tasks: [{ ownerId: 'su-reviewer-1' }] } } });
    const probeLaunchSessions = vi.fn(async (): Promise<FreshLaunchSessionProbe[]> => { throw new Error('probe unavailable'); });
    expect(await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } },
      { ...d.deps, probeLaunchSessions })).toMatchObject({ ok: false, code: 'session_binding_failed',
      message: expect.stringContaining('probe unavailable') });
    expect(d.createSessionBinding).not.toHaveBeenCalled();
    expect(d.handler).toHaveBeenCalledTimes(1);
  });

  it('fails closed if the existing-binding lookup is unavailable', async () => {
    const d = deps();
    d.findSessionBinding.mockRejectedValue(new Error('binding store unavailable'));

    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } }, d.deps);

    expect(result).toMatchObject({ ok: false, code: 'session_binding_failed' });
    expect(result.ok && result.launch).toBeFalsy();
    expect(d.launcher).not.toHaveBeenCalled();
    expect(d.handler).not.toHaveBeenCalled();
  });

  it('terminates the exact new task when an activation binding conflicts', async () => {
    const d = deps();
    d.handler.mockResolvedValue({ data: { launch: {
      opened: 1,
      ownerIds: ['su-reviewer-1'],
      freshVerdict: { sessions: [{ ownerId: 'su-reviewer-1', advSessionId: 42, sessionId: 'native-review-1' }] },
      tasks: [{ taskId: 'task-duplicate-reviewer' }],
    } } });
    d.createSessionBinding.mockResolvedValue({
      ok: false, code: 'binding_conflict', message: 'A different reviewer session is already bound to this plan activation.',
    });

    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } }, d.deps);

    expect(result).toMatchObject({ ok: false, code: 'session_binding_failed' });
    expect(result.ok === false && result.message).toContain('no longer running');
    expect(d.killTask).toHaveBeenCalledWith('task-duplicate-reviewer');
  });

  it('uses requestKey to distinguish mint retries while preserving the default activation key', async () => {
    const d = deps();
    const input = { slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } };
    await mintBlindGapReviewer({ ...input, requestKey: 'mint-request-v1' }, d.deps);
    await mintBlindGapReviewer({ ...input, requestKey: 'mint-request-v1' }, d.deps);
    await mintBlindGapReviewer({ ...input, requestKey: 'mint-request-v2' }, d.deps);
    const keys = d.handler.mock.calls.map(call =>
      (call as unknown as [{ idempotencyKey: string }])[0].idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('uses the exact ADV row to bind a delayed native session id', async () => {
    const d = deps();
    const delayed = { isError: true, data: { launch: { opened: 1, partial: true,
      ownerIds: ['su-reviewer-1'], freshVerdict: { sessions: [
        { ownerId: 'su-reviewer-1', advSessionId: 42, sessionId: null },
      ] } } } };
    d.handler.mockResolvedValue(delayed);
    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } }, d.deps);
    expect(result).toMatchObject({ ok: true, launchStatus: 'partial', binding: { nativeSessionId: 'native-review-1' } });
    expect(d.createSessionBinding).toHaveBeenCalledWith(expect.objectContaining({
      reviewerOwnerId: 'su-reviewer-1', advSessionId: 42, nativeSessionId: null,
    }));
  });

  it('keeps a thrown or lost launch reply uncertain and does not continue the backend ladder', async () => {
    const d = deps();
    d.handler.mockRejectedValue(new Error('reply lost after spawn'));
    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } }, d.deps);
    expect(result).toMatchObject({ ok: true, launchStatus: 'uncertain', binding: null,
      launch: { uncertain: 'reply lost after spawn' } });
    expect(d.handler).toHaveBeenCalledTimes(1);
    expect(d.createSessionBinding).not.toHaveBeenCalled();
  });

  it.each([
    [{ data: { launchFailure: { stage: 'pre-spawn', processesOpened: 0 } } }, true],
    [{ data: { launch: { opened: 0, partial: false, tasks: [] } } }, true],
    [{ isError: true }, false],
    [{ data: { launchFailure: { stage: 'pre-spawn', processesOpened: 1 } } }, false],
    [{ data: { launch: { mode: 'deduped', opened: 0, partial: false, tasks: [] } } }, false],
    [{ data: { launch: { opened: 0, partial: true, tasks: [] } } }, false],
    [{ data: { launch: { opened: 1, ownerIds: ['su-x'] } } }, false],
    [null, false],
  ])('launchProvablyNotStarted(%j) is %s', (receipt, expected) => {
    expect(launchProvablyNotStarted(receipt)).toBe(expected);
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
    // The first backend on the ladder launches: Claude Opus at xhigh (owner directive #2503).
    expect(args).toEqual({
      brief: result.kickoff,
      harness: 'papercusp',
      headless: true,
      agent: 'claude',
      model: 'opus',
      effort: 'xhigh',
      account: 'auto',
      mcpTarget: 'spawn-host',
      idempotencyKey: expect.stringMatching(/^blind-review-mint:[a-f0-9]{64}$/),
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
    expect(d.createSessionBinding).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1', harnessSlug: 'papercusp', planSlug: SLUG, activationAuditSeq: 7,
      reviewerOwnerId: 'su-reviewer-1', advSessionId: 42, nativeSessionId: 'native-review-1',
      launchParentOwner: BLIND_GAP_REVIEW_ACTOR,
    }));
  });

  it('recovers only the bound native transcript in place under the system recruiter and releases its lease', async () => {
    const d = deps();
    const result = await resumeBlindGapReviewer({
      slug: SLUG, harness: 'papercusp', recruiterOwnerId: 'su-author',
      ctx: { workspaceId: 'ws-1', ownerId: 'su-author' },
    }, d.deps);
    // awaitable-review-post-events-2026-10-27 R-2: the resumed binding's id, which keys its post event.
    expect(result).toMatchObject({ ok: true, activationAuditSeq: 7, reviewerOwnerId: 'su-reviewer-1', leaseReleased: true, bindingId: 7 });
    const [args, ctx] = d.handler.mock.calls[0] as unknown as [Record<string, unknown>, Record<PropertyKey, unknown>];
    expect(args).toMatchObject({ resume: { sessionId: 'native-review-1' }, fork: false, headless: true, harness: 'papercusp' });
    expect(args).not.toHaveProperty('agent');
    expect(args).not.toHaveProperty('account');
    expect(args).not.toHaveProperty('model');
    expect(ctx.ownerId).toBe(BLIND_GAP_REVIEW_ACTOR);
    expect(ctx[INTERNAL_BLIND_REVIEW_RESUME]).toMatchObject({ bindingId: 7, leaseId: 'lease-1', nativeSessionId: 'native-review-1' });
    expect(ctx[KEY]).toEqual(CONFINEMENT);
    expect(d.releaseSessionResume).toHaveBeenCalledWith(7, 'lease-1');
  });

  it('refuses a reviewer from recruiting its own recovery', async () => {
    const d = deps();
    const result = await resumeBlindGapReviewer({
      slug: SLUG, harness: 'papercusp', recruiterOwnerId: 'su-reviewer-1',
      ctx: { workspaceId: 'ws-1', ownerId: 'su-reviewer-1' },
    }, d.deps);
    expect(result).toMatchObject({ ok: false, code: 'recruiter_only' });
    expect(d.launcher).not.toHaveBeenCalled();
    expect(d.releaseSessionResume).toHaveBeenCalledWith(7, 'lease-1');
  });

  it.each([
    { isError: true, data: { error: 'confinement_mismatch',
      launchFailure: { stage: 'pre-spawn', processesOpened: 0 } },
      content: [{ type: 'text', text: 'less specific fallback' }] },
    { isError: true, structuredContent: { error: 'confinement_mismatch',
      launchFailure: { stage: 'pre-spawn', processesOpened: 0 } } },
    { isError: true, data: { launchFailure: { stage: 'pre-spawn', processesOpened: 0 } },
      content: [null, { type: 'image', text: 'ignore image' }, { type: 'text', text: ' ' },
        { type: 'text', text: 'confinement_mismatch' }] },
  ])('preserves the launcher refusal and proven pre-spawn result, releasing the lease', async launch => {
    const d = deps();
    d.handler.mockResolvedValueOnce(launch);
    const result = await resumeBlindGapReviewer({
      slug: SLUG, harness: 'papercusp', recruiterOwnerId: 'su-author',
      ctx: { workspaceId: 'ws-1', ownerId: 'su-author' },
    }, d.deps);
    expect(result).toMatchObject({ ok: false, code: 'resume_failed',
      message: expect.stringContaining('confinement_mismatch') });
    if (result.ok) return;
    expect(result.message).toContain('Launcher receipt proves no process started.');
    expect(result.message).not.toContain('less specific fallback');
    expect(result.message).not.toContain('ignore image');
    expect(d.handler).toHaveBeenCalledTimes(1);
    expect(d.releaseSessionResume).toHaveBeenCalledWith(7, 'lease-1');
  });

  it.each([undefined, 'x'.repeat(4000)])('bounds refusal text without inferring no spawn from isError', async detail => {
    const d = deps();
    d.handler.mockResolvedValueOnce({ isError: true,
      ...(detail ? { content: [{ type: 'text', text: detail }] } : {}) });
    const result = await resumeBlindGapReviewer({
      slug: SLUG, harness: 'papercusp', recruiterOwnerId: 'su-author',
      ctx: { workspaceId: 'ws-1', ownerId: 'su-author' },
    }, d.deps);
    expect(result).toMatchObject({ ok: false, code: 'resume_failed' });
    if (result.ok) return;
    expect(result.message).toContain('does not prove whether a process started; reconcile before retrying.');
    expect(result.message.length).toBeLessThan(2300);
    if (detail) expect(result.message).toContain('x'.repeat(2000));
    expect(d.handler).toHaveBeenCalledTimes(1);
    expect(d.releaseSessionResume).toHaveBeenCalledWith(7, 'lease-1');
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

  it.each(['no mapped sources', 'only excluded sources'] as const)('refuses a brief with no user turns (%s) before loading the launcher', async sourceCase => {
    const d = deps({
      ...BRIEF,
      ownerTurns: [],
      unverifiedTurns: [],
      excludedRefs: sourceCase === 'only excluded sources'
        ? [{ ref: 'codex:assistant:1', reason: 'not-owner' }]
        : [],
    });
    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } }, d.deps);
    expect(result).toMatchObject({ ok: false, code: 'no_source_turns' });
    expect(d.loadBrief).toHaveBeenCalledTimes(1);
    expect(d.launcher).not.toHaveBeenCalled();
    expect(d.handler).not.toHaveBeenCalled();
  });

  // Owner directive #2499 (2026-10-27): the mint no longer demands an authenticated owner
  // turn. A brief carrying only unverified-origin user turns launches a reviewer.
  it('mints from a brief whose only turns are unverified-origin user turns', async () => {
    const d = deps({
      ...BRIEF,
      ownerTurns: [],
      unverifiedTurns: [{ ref: 'codex:pre-stamp:1', text: 'Make the export button produce a CSV.' }],
    });
    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } }, d.deps);
    expect(result.ok).toBe(true);
    expect(d.handler).toHaveBeenCalledTimes(1);
  });
});
