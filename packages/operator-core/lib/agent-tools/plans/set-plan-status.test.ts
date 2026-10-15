import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizePlanStatus,
  flipPlanFrontmatterStatus,
  launchAcceptanceGraderForGate,
  shipGatePreflightResult,
  shouldEvaluateAcceptanceGate,
  tidyFilingsForTerminalPlan,
  type TerminalPlanTidyDeps,
} from './set-plan-status';
import setPlanStatusTool from './set-plan-status';
import { ACCEPTANCE_GRADING_SWEEP_ACTOR } from '../../acceptance-grader';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

const preflightMocks = vi.hoisted(() => ({
  acceptance: vi.fn(), admission: vi.fn(), row: vi.fn(), scope: vi.fn(),
  write: vi.fn(), capture: vi.fn(), launch: vi.fn(), resolveGrader: vi.fn(),
}));
vi.mock('../../plan-acceptance-gate', async (original) => ({
  ...await original<typeof import('../../plan-acceptance-gate')>(),
  evaluatePlanAcceptanceGate: preflightMocks.acceptance,
}));
vi.mock('./plan-admission-gate', async (original) => ({
  ...await original<typeof import('./plan-admission-gate')>(),
  checkPlanAdmission: preflightMocks.admission,
}));
vi.mock('./source', async (original) => ({
  ...await original<typeof import('./source')>(),
  getPlanRow: preflightMocks.row, resolvePlanScope: preflightMocks.scope,
}));
vi.mock('./with-plan-lock', async (original) => ({
  ...await original<typeof import('./with-plan-lock')>(), withPlanLock: preflightMocks.write,
}));
vi.mock('./revisions', async (original) => ({
  ...await original<typeof import('./revisions')>(), planRevisionCapture: preflightMocks.capture,
}));
vi.mock('../../acceptance-grader', async (original) => ({
  ...await original<typeof import('../../acceptance-grader')>(),
  launchAcceptanceGrader: preflightMocks.launch, resolveAcceptanceGrader: preflightMocks.resolveGrader,
}));

describe('set-plan-status handler independent ship guards (PVFR G1/G2)', () => {
  const body = (status: string) => `---\nstatus: ${status}\n---\n# Plan\n`;
  const refusal = {
    error: 'plan_admission_refused', code: 'certificate_revision_mismatch',
    hint: 'Renew the promotion admission certificate.', detail: 'Old certificate.',
    planRevisionHash: 'revision-current', policyVersion: 1,
  };
  async function run(over: Record<string, unknown> = {}) {
    const res = await setPlanStatusTool.handler(setPlanStatusTool.args.parse({
      harness: 'member', slug: 'plan-a', status: 'shipped', dryRun: true, ...over,
    }), {
      workspaceId: 'ws-test', harnessSlug: 'member', uiClientId: 'su-shipper',
      signal: new AbortController().signal, log: vi.fn(), progress: vi.fn(), metadata: vi.fn(),
    } as never);
    return (res as { data: { results: Record<string, unknown>[] } }).data.results[0]!;
  }
  function expectReadOnly() {
    for (const mock of [preflightMocks.write, preflightMocks.capture, preflightMocks.launch, preflightMocks.resolveGrader]) {
      expect(mock).not.toHaveBeenCalled();
    }
  }
  beforeEach(() => {
    for (const mock of Object.values(preflightMocks)) mock.mockReset();
    preflightMocks.scope.mockResolvedValue({ workspaceId: 'ws-test', harnessSlug: 'home' });
    preflightMocks.acceptance.mockResolvedValue({ satisfied: true });
    preflightMocks.admission.mockResolvedValue({ admitted: true });
    preflightMocks.row.mockResolvedValue({ content: body('ready') });
  });

  it('a passing acceptance gate cannot hide denied promotion admission', async () => {
    preflightMocks.admission.mockResolvedValue({ admitted: false, refusal });
    const result = await run();
    expect(result).toMatchObject({ ok: false, dryRun: true, error: 'plan_admission_refused' });
    expect(result).not.toHaveProperty('wouldShip', true);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'plan_admission_refused', repairAction: expect.any(Object) }),
    ]));
    expectReadOnly();
  });

  it.each([
    ['mismatched expectedCurrent', { content: body('draft') }, 'unexpected_status'],
    ['missing frontmatter status', { content: '# Legacy plan' }, 'no_status_line'],
    ['missing plan row', null, 'not_found'],
  ])('a passing acceptance gate cannot hide %s', async (_name, row, error) => {
    preflightMocks.row.mockResolvedValue(row);
    const result = await run({ expectedCurrent: 'ready' });
    expect(result).toMatchObject({ ok: false, dryRun: true, error });
    expect(result).not.toHaveProperty('wouldShip', true);
    if (error === 'unexpected_status') expect(result).toHaveProperty('current', 'draft');
    expectReadOnly();
  });

  it('reports acceptance, promotion and CAS blockers together without recruiting', async () => {
    const acceptance = {
      code: 'acceptance_ungraded', message: 'Needs independent grading.',
      repairAction: { kind: 'independent-grading', instruction: 'Recruit via ship door.' },
    };
    preflightMocks.acceptance.mockResolvedValue({ satisfied: false, ...acceptance, blockers: [acceptance] });
    preflightMocks.admission.mockResolvedValue({ admitted: false, refusal });
    preflightMocks.row.mockResolvedValue({ content: body('draft') });
    const result = await run({ expectedCurrent: 'ready' });
    expect(result).toMatchObject({ ok: false, error: 'acceptance_ungraded', dryRun: true });
    expect((result.blockers as { code: string }[]).map((b) => b.code)).toEqual([
      'acceptance_ungraded', 'plan_admission_refused', 'unexpected_status',
    ]);
    expect(result.message).toContain('2 more independent check(s)');
    expectReadOnly();
  });

  it('reports wouldShip only after independent guards pass in the resolved home scope', async () => {
    expect(await run({ expectedCurrent: 'ready' })).toMatchObject({ ok: true, dryRun: true, wouldShip: true });
    expect(preflightMocks.admission).toHaveBeenCalledWith({
      slug: 'plan-a', door: 'promotion', opts: { workspaceId: 'ws-test', harnessSlug: 'home' }, readOnly: true,
    });
    expect(preflightMocks.row).toHaveBeenCalledWith('plan-a', { workspaceId: 'ws-test', harnessSlug: 'home' });
    expectReadOnly();
  });

  it.each(['admission', 'row'] as const)('an unavailable %s read cannot establish wouldShip', async (read) => {
    preflightMocks[read].mockRejectedValue(new Error('read unavailable'));
    const result = await run();
    expect(result).toMatchObject({
      ok: false, dryRun: true,
      error: read === 'admission' ? 'plan_admission_unavailable' : 'plan_source_unavailable',
    });
    expect(result).not.toHaveProperty('wouldShip', true);
    expectReadOnly();
  });

  it('the actual writer still rejects a status change after a passing preflight', async () => {
    expect(await run({ expectedCurrent: 'ready' })).toHaveProperty('wouldShip', true);
    preflightMocks.capture.mockReturnValue({ afterWrite: vi.fn() });
    preflightMocks.write.mockImplementation(async (_ctx, _opts, mutate) => {
      const mutation = await mutate(body('draft'));
      expect(mutation.newBody).toBeNull();
      return { kind: 'written', value: mutation.value };
    });
    expect(await run({ dryRun: false, expectedCurrent: 'ready' })).toMatchObject({
      ok: false, error: 'unexpected_status', current: 'draft',
    });
  });
});

describe('set-plan-status public lifecycle guidance', () => {
  it('documents the completion audit gate for shipped and done', () => {
    const publicGuidance = [
      setPlanStatusTool.description,
      setPlanStatusTool.guidance?.when,
      setPlanStatusTool.guidance?.chaining,
    ].join('\n');

    expect(publicGuidance).toContain('shipped');
    expect(publicGuidance).toContain('`done`');
    expect(publicGuidance).toContain("plans:audit { phase:'completion'");
    expect(publicGuidance).toContain('AFTER implementation');
    expect(publicGuidance).toContain('as-built');
    expect(publicGuidance).toContain('peer grade');
  });

  it('documents the dropped plan-status alias', () => {
    expect(setPlanStatusTool.description).toContain('`dropped` maps to the terminal `superseded` status');
  });

  it('projects the post-implementation authoring contract to both agent clients', () => {
    for (const clientDoc of ['AGENTS.md', 'CLAUDE.md']) {
      const projected = readFileSync(resolve(ROOT, clientDoc), 'utf8');
      expect(projected).toContain('## Every plan ships with a graded acceptance rubric');
      expect(projected).toContain('After implementation is verified:');
    }
  });

  it('warns that a rubric revision invalidates independent grading as well as attestation', () => {
    const revisionWarning =
      'Any later rubric edit invalidates BOTH the attestation AND any independent grading';
    const staleWarning = 'Any later rubric edit invalidates the attestation.';

    for (const clientDoc of ['AGENTS.md', 'CLAUDE.md']) {
      const projected = readFileSync(resolve(ROOT, clientDoc), 'utf8');
      expect(projected).toContain(revisionWarning);
      expect(projected).not.toContain(staleWarning);
    }
  });
});

describe('set-plan-status idempotent-completion opt-in (EI-21122694679454626)', () => {
  it.each([true, false])('boolean current=%s omits caller testimony before ship-gate evaluation', (current) => {
    const request = { slug: 'plan-a', status: 'shipped' };
    const aliased = setPlanStatusTool.args.parse({ ...request, current });
    const omitted = setPlanStatusTool.args.parse(request);
    expect(aliased.current).toBe(current);
    expect({ ...aliased, current: undefined }).toEqual({ ...omitted, current: undefined });
    expect(setPlanStatusTool.args.safeParse({ ...request, current: 'fresh' }).success).toBe(false);
  });

  it('declares idempotent:true so a committed-but-slow flip is reported as success', () => {
    expect((setPlanStatusTool as { idempotent?: boolean }).idempotent).toBe(true);
  });
});

describe('set-plan-status acceptance-grader launch deadline', () => {
  it('covers the bounded headless judge launch path so its outcome reaches the recruiter', () => {
    expect((setPlanStatusTool as { timeoutSec?: number }).timeoutSec).toBe(90);
  });
});

// Caller-DX (watchdog P-006): plans:set-plan-status previously zod-REJECTED the
// status words agents reach for ('active' from old plans, 'done' confused with the
// item-status verb). Now they are accepted + mapped to the canonical settable form,
// echoing `mappedFrom`, so the confusing reject (vs plans:set-status) stops recurring.
describe('normalizePlanStatus (P-006)', () => {
  it('maps the legacy/confused aliases to canonical, reporting mappedFrom', () => {
    expect(normalizePlanStatus('active')).toEqual({ status: 'ready', mappedFrom: 'active' });
    expect(normalizePlanStatus('done')).toEqual({ status: 'shipped', mappedFrom: 'done' });
    expect(normalizePlanStatus('dropped')).toEqual({ status: 'superseded', mappedFrom: 'dropped' });
  });

  it('accepts dropped in the public status schema', () => {
    expect(setPlanStatusTool.args.safeParse({
      harness: 'papercusp',
      slug: 'plan-a',
      status: 'dropped',
      expectedCurrent: 'draft',
    }).success).toBe(true);
  });

  it('passes a canonical status through with no mappedFrom', () => {
    for (const s of ['draft', 'ready', 'shipped', 'superseded']) {
      expect(normalizePlanStatus(s)).toEqual({ status: s });
    }
  });
});

describe('set-plan-status expectedCurrent vocabulary', () => {
  it('public chaining teaches the read-only all-blockers dryRun preflight', () => {
    expect(setPlanStatusTool.guidance!.chaining).toContain('dryRun:true');
    expect(setPlanStatusTool.guidance!.chaining).toContain('read-only all-blockers preflight');
    expect(setPlanStatusTool.guidance!.chaining).toContain('no status write, forced-past stamp or grader recruitment');
  });
  it('accepts the derived awaiting-acceptance lifecycle state as a guard', () => {
    const parsed = setPlanStatusTool.args.safeParse({
      harness: 'papercusp',
      slug: 'plan-a',
      status: 'shipped',
      expectedCurrent: 'awaiting-acceptance',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('set-plan-status BAR proof metadata force', () => {
  it('accepts the reasoned waiver only for a shipped target', () => {
    expect(setPlanStatusTool.args.safeParse({
      harness: 'papercusp',
      slug: 'plan-a',
      status: 'shipped',
      force: { reason: 'BAR proof metadata is stale; recorded evidence remains reviewable.', acceptanceBarProofMetadata: true },
    }).success).toBe(true);

    expect(setPlanStatusTool.args.safeParse({
      harness: 'papercusp',
      slug: 'plan-a',
      status: 'superseded',
      force: { reason: 'reason', acceptanceBarProofMetadata: true },
    }).success).toBe(false);
  });
});

describe('set-plan-status dryRun ship preflight (plan-verification-friction-reduction-2026-10-11 P-001)', () => {
  const parse = (over: Record<string, unknown>) =>
    setPlanStatusTool.args.safeParse({ harness: 'papercusp', slug: 'plan-a', status: 'shipped', dryRun: true, ...over });

  it('accepts dryRun only for a shipped target', () => {
    expect(parse({}).success).toBe(true);
    expect(parse({ status: 'done' }).success).toBe(true);
    expect(parse({ status: 'superseded' }).success).toBe(false);
    expect(parse({ status: 'ready' }).success).toBe(false);
    expect(parse({ expectedCurrent: 'shipped' }).success).toBe(false);
    expect(parse({
      expectedCurrent: 'ready',
      restoreShippedRevision: { seq: 1, contentHash: 'a'.repeat(64), expectedVersion: 2, expectedContentHash: 'b'.repeat(64) },
    }).success).toBe(false);
  });

  it('a refused preflight carries every blocker and names the extra ones in its message', () => {
    const repairAction = { kind: 'diagnostic', instruction: 'fix it' } as never;
    const result = shipGatePreflightResult('plan-a', {
      satisfied: false,
      code: 'spec_proof_stale',
      message: 'A clause is proven only at a superseded revision.',
      repairAction,
      blockers: [
        { code: 'spec_proof_stale', message: 'A clause is proven only at a superseded revision.', repairAction },
        { code: 'acceptance_rubric_missing', message: 'no rubric', repairAction },
      ],
    } as never);

    expect(result).toMatchObject({ ok: false, slug: 'plan-a', dryRun: true, error: 'spec_proof_stale' });
    if (result.ok) throw new Error('expected a refused preflight');
    expect(result.message).toContain('A clause is proven only at a superseded revision.');
    expect(result.message).toContain('ALSO FAILING: 1 more independent check(s) — acceptance_rubric_missing');
    expect((result as { blockers?: unknown[] }).blockers).toHaveLength(2);
    // A preflight never recruits: no grader lifecycle is attached to the response.
    expect(result).not.toHaveProperty('acceptanceGrader');
  });

  it('a passing preflight reports wouldShip and the waiver a real ship would record', () => {
    const forcedPast = { reason: 'owner waiver', checks: ['acceptance_unaudited'] };
    expect(shipGatePreflightResult('plan-a', { satisfied: true, forcedPast } as never)).toEqual({
      ok: true, slug: 'plan-a', dryRun: true, wouldShip: true, forcedPast,
    });
    expect(shipGatePreflightResult('plan-a', { satisfied: true } as never)).toEqual({
      ok: true, slug: 'plan-a', dryRun: true, wouldShip: true,
    });
  });

  // R-1 (acceptance-plan-verification-friction-reduction-2026-10-11): the two halves of the
  // bar that live in the HANDLER, not in the pure response builder above. Both are pinned on
  // the source because the handler's ordering is the property: the gate must be asked for
  // every blocker, and the preflight must return before the first side effect.
  const handlerSource = () => {
    const source = readFileSync(resolve(ROOT, 'packages/operator-core/lib/agent-tools/plans/set-plan-status.ts'), 'utf8');
    const start = source.indexOf('async handler(args, ctx)');
    expect(start).toBeGreaterThan(-1);
    return source.slice(start);
  };

  it('the ship path asks the acceptance gate for every independent blocker', () => {
    const handler = handlerSource();
    const call = handler.indexOf('evaluatePlanAcceptanceGate(slug, {');
    expect(call).toBeGreaterThan(-1);
    const gateArgs = handler.slice(call, handler.indexOf('readGradingAuditDispatchSuppression', call));
    expect(gateArgs).toMatch(/^\s*collectAllBlockers: true,$/m);
  });

  it('a dryRun preflight returns before grader recruitment, the forced-past stamp and the status write', () => {
    const handler = handlerSource();
    const preflight = handler.indexOf('return shipGatePreflightResult(slug, gate, guards);');
    expect(preflight).toBeGreaterThan(-1);
    for (const sideEffect of [
      'await launchAcceptanceGraderForGate(',
      'stampForcedPastWaiver(',
      'await withPlanLock<SetPlanStatusValue>(',
    ]) {
      const at = handler.indexOf(sideEffect);
      expect(at, sideEffect).toBeGreaterThan(preflight);
    }
  });
});

describe('set-plan-status terminal repair gate (WI-38303)', () => {
  it('skips the completion gate for an explicit shipped→shipped repair replay', () => {
    expect(shouldEvaluateAcceptanceGate('shipped', 'shipped')).toBe(false);
  });

  it('keeps the completion gate for a real transition into shipped', () => {
    expect(shouldEvaluateAcceptanceGate('shipped', 'ready')).toBe(true);
    expect(shouldEvaluateAcceptanceGate('shipped')).toBe(true);
  });

  it('never applies the completion gate to non-shipped targets', () => {
    expect(shouldEvaluateAcceptanceGate('superseded')).toBe(false);
  });
});

// Sanity that mapped targets write their canonical plan-level status.
describe('flipPlanFrontmatterStatus with mapped aliases', () => {
  it.each([
    ['active', 'ready'],
    ['dropped', 'superseded'],
  ])('writes the canonical target for %s', (alias, canonical) => {
    const body = '---\ntitle: T\nstatus: draft\n---\n\n# Body\n';
    const { status } = normalizePlanStatus(alias);
    expect(status).toBe(canonical);
    const flip = flipPlanFrontmatterStatus(body, status, 'draft');
    expect(flip.oldStatus).toBe('draft');
    expect(flip.newBody).toContain(`status: ${canonical}`);
    expect(flip.code).toBeUndefined();
  });
});

describe('flipPlanFrontmatterStatus accepted YAML styles', () => {
  it.each(['', "'", '"'])('preserves %s quoting and the expected-current guard', quote => {
    const body = `---\ntitle: T\nstatus: ${quote}draft${quote}  \n---\n\n# Body\n`;
    expect(flipPlanFrontmatterStatus(body, 'ready', 'draft')).toEqual({
      oldStatus: 'draft',
      newBody: body.replace(`${quote}draft${quote}`, `${quote}ready${quote}`),
    });
    expect(flipPlanFrontmatterStatus(body, 'ready', 'shipped')).toEqual({
      oldStatus: 'draft', newBody: null, code: 'unexpected_status',
    });
  });

  it('preserves a quoted CRLF status line', () => {
    const body = '---\r\nstatus: "draft"\r\n---\r\n# Body\r\n';
    expect(flipPlanFrontmatterStatus(body, 'ready', 'draft').newBody)
      .toBe(body.replace('"draft"', '"ready"'));
  });

  it.each(['"draft\'', '\'draft"', '"draft', 'draft"'])('refuses mismatched quotes: %s', value => {
    expect(flipPlanFrontmatterStatus(`---\nstatus: ${value}\n---\n`, 'ready'))
      .toEqual({ oldStatus: null, newBody: null, code: 'no_status_line' });
  });
});

describe('launchAcceptanceGraderForGate (D-006)', () => {
  it.each([true, false])('boolean current=%s reaches the recruitment gate without caller testimony', async (current) => {
    const parsed = setPlanStatusTool.args.parse({ slug: 'plan-a', status: 'shipped', current });
    const evaluate = vi.fn(async (_slug: string, _options: { current?: unknown }) => ({ satisfied: true }));
    const launch = vi.fn();
    await launchAcceptanceGraderForGate('plan-a', { satisfied: false, code: 'plan_items_unfinished' },
      {} as never, 'papercusp', launch as never, evaluate as never, parsed.current);
    expect(evaluate).toHaveBeenCalledWith('plan-a', expect.objectContaining({ harnessSlug: 'papercusp', gradingRecruitment: true }));
    expect(evaluate.mock.calls[0]?.[1]).not.toHaveProperty('current');
    expect(launch).not.toHaveBeenCalled();
  });

  it('fails closed when recruitment has only the operator harness sentinel', async () => {
    const evaluate = vi.fn();
    await expect(launchAcceptanceGraderForGate('plan-a',
      { satisfied: false, code: 'plan_items_unfinished' },
      { workspaceId: 'ws-test', harnessSlug: '*' } as never,
      undefined, undefined, evaluate as never)).rejects.toThrow('No harness specified');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('keeps exact current evidence comparisons when evaluating the ceremony recruitment tail', async () => {
    const current = [{
      planSlug: 'plan-a', specId: 'delivery', specRevision: 3,
      specFingerprint: 'spec-current', evidenceKind: 'operational' as const,
      evidenceRef: 'delivery-receipt', sourceFingerprint: 'source-current',
      environmentFingerprint: 'environment-current',
    }];
    const evaluate = vi.fn(async (_slug: string, options: { current?: unknown }) => ({
      satisfied: false,
      code: options.current === current ? 'acceptance_ungraded' : 'acceptance_bar_contract_not_ready',
    }));
    const launch = vi.fn(async () => ({ state: 'launched' as const,
      idempotencyKey: 'acceptance-grader:key', label: 'acceptance-grader:rubric:key' }));
    const result = await launchAcceptanceGraderForGate('plan-a',
      { satisfied: false, code: 'plan_items_unfinished' },
      { workspaceId: 'ws-test', harnessSlug: 'wrong-ambient' } as never,
      'papercusp', launch as never, evaluate as never, current);
    expect(evaluate).toHaveBeenCalledWith('plan-a', {
      harnessSlug: 'papercusp', gradingRecruitment: true, current,
    });
    expect(result?.state).toBe('launched');
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it('recruits for an audited ceremony tail while preserving the strict ship refusal and shipper exclusion', async () => {
    const strict = { satisfied: false, code: 'plan_items_unfinished' };
    const evaluate = vi.fn(async () => ({ satisfied: false, code: 'acceptance_ungraded' }));
    const launch = vi.fn(async () => ({ state: 'launched' as const,
      idempotencyKey: 'acceptance-grader:key', label: 'acceptance-grader:rubric:key' }));
    const result = await launchAcceptanceGraderForGate('plan-a', strict,
      { workspaceId: 'ws-test', harnessSlug: 'wrong-ambient', isSuperuser: true,
        uiClientId: 'su-shipper' } as never, 'papercusp', launch as never, evaluate as never);
    expect(evaluate).toHaveBeenCalledWith('plan-a', { harnessSlug: 'papercusp', gradingRecruitment: true });
    expect(result?.state).toBe('launched');
    expect(strict).toEqual({ satisfied: false, code: 'plan_items_unfinished' });
    expect(launch.mock.calls).toHaveLength(1);
    const ctx = (launch.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(ctx.acceptanceShipperOwnerId).toBe('su-shipper');
    expect(ctx.ownerId).toBe(ACCEPTANCE_GRADING_SWEEP_ACTOR);
  });
  it.each(['plan_items_unfinished', 'acceptance_bar_contract_not_ready', 'acceptance_unaudited',
    'acceptance_not_recorded'])(
    'does not recruit past implementation, BAR, audit or author refusal: %s', async code => {
      const launch = vi.fn();
      const evaluate = vi.fn(async () => ({ satisfied: false, code }));
      expect(await launchAcceptanceGraderForGate('plan-a',
        { satisfied: false, code: 'plan_items_unfinished' },
        { workspaceId: 'ws-test' } as never, 'papercusp', launch as never, evaluate as never))
        .toBeUndefined();
      expect(launch).not.toHaveBeenCalled();
    });
  it.each(['acceptance_ungraded', 'self_graded_only', 'acceptance_rubric_vetted_after_grading'])('launches once for %s', async (code) => {
    const launch = vi.fn(async () => ({
      state: 'launched' as const,
      idempotencyKey: 'acceptance-grader:key',
      label: 'acceptance-grader:rubric:key',
    }));
    const result = await launchAcceptanceGraderForGate(
      'plan-a',
      { satisfied: false, code },
      { workspaceId: 'ws-test', harnessSlug: 'papercusp' } as never,
      'sidestage',
      launch as never,
    );
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith('plan-a', {
      workspaceId: 'ws-test',
      harnessSlug: 'sidestage',
      // No attributable caller in this ctx → nothing to carry (EI-24402913315950329).
      acceptanceShipperOwnerId: null,
      // WI-10003286: both recruiting codes mean the gate found no admissible grading.
      acceptanceGateFoundNoAdmissibleGrading: true,
      uiClientId: null,
      isSuperuser: false,
      isPowerUser: false,
      principal: {
        kind: 'system',
        slug: ACCEPTANCE_GRADING_SWEEP_ACTOR,
        workspaceId: 'ws-test',
      },
      ownerId: ACCEPTANCE_GRADING_SWEEP_ACTOR,
      ownerLabel: 'acceptance grading sweep',
      userId: null,
    });
    expect(result?.state).toBe('launched');
  });

  /**
   * EI-24402913315950329. The system-actor rewrite is for launch LINEAGE; it must
   * not also erase WHO shipped. The real caller rides through as
   * `acceptanceShipperOwnerId` so the recruiter's D-009 shipper exclusion keeps
   * the implementer-shipper (and, by party collapse, its forks) off the menu.
   */
  it('carries the real ship-gate caller through the system-actor rewrite as an exclusion input', async () => {
    const launch = vi.fn(async () => ({
      state: 'launched' as const,
      idempotencyKey: 'acceptance-grader:key',
      label: 'acceptance-grader:rubric:key',
    }));
    await launchAcceptanceGraderForGate(
      'plan-a',
      { satisfied: false, code: 'acceptance_ungraded' },
      { workspaceId: 'ws-test', isSuperuser: true, uiClientId: 'su-implementer-shipper' } as never,
      'papercusp',
      launch as never,
    );
    expect(launch).toHaveBeenCalledWith(
      'plan-a',
      expect.objectContaining({
        ownerId: ACCEPTANCE_GRADING_SWEEP_ACTOR,
        acceptanceShipperOwnerId: 'su-implementer-shipper',
      }),
    );
  });

  // WI-10003286: a self_graded_only refusal that names the independent card its BAR
  // judged cohort-stale must hand that id to the recruiter, whose settlement read would
  // otherwise count the stale card as "settled" and never dispatch the fresh grading.
  it('carries the cohort-stale independent card from a self_graded_only refusal to the recruiter', async () => {
    const launch = vi.fn(async () => ({
      state: 'launched' as const,
      idempotencyKey: 'acceptance-grader:key',
      label: 'acceptance-grader:rubric:key',
    }));
    await launchAcceptanceGraderForGate(
      'plan-a',
      { satisfied: false, code: 'self_graded_only', staleGradingScorecardId: 'EI-stale-independent' },
      { workspaceId: 'ws-test', harnessSlug: 'papercusp' } as never,
      'papercusp',
      launch as never,
    );
    expect(launch).toHaveBeenCalledWith(
      'plan-a',
      expect.objectContaining({ acceptanceStaleGradingScorecardId: 'EI-stale-independent' }),
    );
  });

  it('recruits a post-vetting regrade without settling on earlier independent cards', async () => {
    const launch = vi.fn(async () => ({ state: 'launched' as const,
      idempotencyKey: 'post-vetting', label: 'post-vetting' }));
    const gate = { satisfied: false, code: 'acceptance_rubric_vetted_after_grading',
      staleGradingScorecardId: 'EI-before-vetting',
      staleGradingScorecardIds: ['EI-before-vetting', 'EI-older'] };
    await launchAcceptanceGraderForGate('plan-a', gate,
      { workspaceId: 'ws-test', isSuperuser: true, uiClientId: 'su-shipper' } as never,
      'papercusp', launch as never);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith('plan-a', expect.objectContaining({
      ownerId: ACCEPTANCE_GRADING_SWEEP_ACTOR,
      acceptanceShipperOwnerId: 'su-shipper',
      acceptanceGateFoundNoAdmissibleGrading: true,
      acceptanceStaleGradingScorecardId: 'EI-before-vetting',
      acceptanceStaleGradingScorecardIds: ['EI-before-vetting', 'EI-older'],
    }));
    expect(gate.satisfied).toBe(false);
  });

  // WI-10003286 (second half): the gate excludes the named card AND every older
  // independent card predating it. Carrying only the named id let the recruiter's
  // settlement read fall back to the older excluded card and report "settled".
  it('carries EVERY cohort-stale independent card the gate excluded, not just the named one', async () => {
    const launch = vi.fn(async () => ({
      state: 'launched' as const,
      idempotencyKey: 'acceptance-grader:key',
      label: 'acceptance-grader:rubric:key',
    }));
    await launchAcceptanceGraderForGate(
      'plan-a',
      {
        satisfied: false,
        code: 'self_graded_only',
        staleGradingScorecardId: 'EI-stale-independent',
        staleGradingScorecardIds: ['EI-stale-independent', 'EI-older-independent'],
      },
      { workspaceId: 'ws-test', harnessSlug: 'papercusp' } as never,
      'papercusp',
      launch as never,
    );
    const ctx = (launch.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(ctx.acceptanceStaleGradingScorecardId).toBe('EI-stale-independent');
    expect([...(ctx.acceptanceStaleGradingScorecardIds as string[])].sort()).toEqual([
      'EI-older-independent',
      'EI-stale-independent',
    ]);
    // The gate's verdict (no admissible independent grading) must reach the recruiter so
    // its identity-free settlement read cannot answer "settled" over it.
    expect(ctx.acceptanceGateFoundNoAdmissibleGrading).toBe(true);
  });

  it('does not recruit a judge for unrelated acceptance failures', async () => {
    const launch = vi.fn();
    const result = await launchAcceptanceGraderForGate(
      'plan-a',
      { satisfied: false, code: 'acceptance_unaudited' },
      {} as never,
      undefined,
      launch as never,
    );
    expect(result).toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('tidyFilingsForTerminalPlan — the terminal-plan tidy-up wiring (WI-10004531)', () => {
  type MockedDeps = { [K in keyof TerminalPlanTidyDeps]: Mock<TerminalPlanTidyDeps[K]> };
  function makeDeps(overrides: Partial<MockedDeps> = {}): MockedDeps {
    const deps: MockedDeps = {
      retire: vi.fn<TerminalPlanTidyDeps['retire']>(async () => 'acceptance-plan-a'),
      settle: vi.fn<TerminalPlanTidyDeps['settle']>(async () => ({ settled: ['WI-R1'], failed: [] })),
      reconcileActivationRepair: vi.fn<TerminalPlanTidyDeps['reconcileActivationRepair']>(async () => ({
        conditionKey: 'activation-audit:papercusp/plan-a',
        closed: 'WI-A1',
      })),
      ...overrides,
    };
    return deps;
  }
  const base = {
    slug: 'plan-a',
    ownerId: () => 'su-shipper',
    scope: { workspaceId: 'ws-1', harnessSlug: 'papercusp' },
  };

  it('a changed ship retires the rubric, settles reservations and closes the activation filing', async () => {
    const deps = makeDeps();

    const out = await tidyFilingsForTerminalPlan({ ...base, status: 'shipped', changed: true }, deps);

    expect(deps.retire).toHaveBeenCalledWith('plan-a', 'su-shipper', {
      harnessSlug: 'papercusp',
      terminalStatus: 'shipped',
    });
    expect(deps.settle).toHaveBeenCalledWith('plan-a', {
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      terminalStatus: 'shipped',
    });
    expect(deps.reconcileActivationRepair).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      terminalStatus: 'shipped',
    });
    expect(out).toEqual({
      acceptanceRubricRetired: 'acceptance-plan-a',
      acceptanceReviewReservations: { settled: ['WI-R1'], failed: [] },
      activationAuditRepair: { conditionKey: 'activation-audit:papercusp/plan-a', closed: 'WI-A1' },
    });
  });

  it('a repeat (unchanged) ship touches nothing and never resolves the caller identity', async () => {
    const deps = makeDeps();
    const ownerId = vi.fn(() => 'su-shipper');

    const out = await tidyFilingsForTerminalPlan({ ...base, ownerId, status: 'shipped', changed: false }, deps);

    expect(out).toEqual({});
    expect(ownerId).not.toHaveBeenCalled();
    expect(deps.retire).not.toHaveBeenCalled();
    expect(deps.settle).not.toHaveBeenCalled();
    expect(deps.reconcileActivationRepair).not.toHaveBeenCalled();
  });

  it('superseded tidies even when unchanged, repairing older terminal rows', async () => {
    const deps = makeDeps();

    await tidyFilingsForTerminalPlan({ ...base, status: 'superseded', changed: false }, deps);

    expect(deps.retire).toHaveBeenCalledTimes(1);
    expect(deps.settle.mock.calls[0]?.[1]).toMatchObject({ terminalStatus: 'superseded' });
    expect(deps.reconcileActivationRepair.mock.calls[0]?.[0]).toMatchObject({ terminalStatus: 'superseded' });
  });

  it.each(['active', 'ready', 'awaiting-acceptance', 'draft'])('non-terminal status %s is a no-op', async (status) => {
    const deps = makeDeps();

    await expect(tidyFilingsForTerminalPlan({ ...base, status, changed: true }, deps)).resolves.toEqual({});
    expect(deps.retire).not.toHaveBeenCalled();
    expect(deps.settle).not.toHaveBeenCalled();
    expect(deps.reconcileActivationRepair).not.toHaveBeenCalled();
  });

  it('a throwing settle is reported on the result and does not stop the activation close', async () => {
    const deps = makeDeps({
      settle: vi.fn<TerminalPlanTidyDeps['settle']>(async () => {
        throw new Error('pg down');
      }),
    });

    const out = await tidyFilingsForTerminalPlan({ ...base, status: 'shipped', changed: true }, deps);

    expect(out.acceptanceReviewReservations).toEqual({ error: 'pg down' });
    expect(out.activationAuditRepair).toMatchObject({ closed: 'WI-A1' });
  });

  it('omits keys with nothing to report: no live rubric, empty settlement, no open activation filing', async () => {
    const deps = makeDeps({
      retire: vi.fn<TerminalPlanTidyDeps['retire']>(async () => null),
      settle: vi.fn<TerminalPlanTidyDeps['settle']>(async () => ({ settled: [], failed: [] })),
      reconcileActivationRepair: vi.fn<TerminalPlanTidyDeps['reconcileActivationRepair']>(async () => ({
        conditionKey: 'activation-audit:papercusp/plan-a',
        closed: null,
      })),
    });

    await expect(tidyFilingsForTerminalPlan({ ...base, status: 'shipped', changed: true }, deps)).resolves.toEqual({});
  });

  it('surfaces a failed settlement row and a failed activation close', async () => {
    const deps = makeDeps({
      settle: vi.fn<TerminalPlanTidyDeps['settle']>(async () => ({
        settled: [],
        failed: [{ id: 'WI-R2', error: 'gate refused' }],
      })),
      reconcileActivationRepair: vi.fn<TerminalPlanTidyDeps['reconcileActivationRepair']>(async () => ({
        conditionKey: 'activation-audit:papercusp/plan-a',
        closed: null,
        error: 'writer unavailable',
      })),
    });

    const out = await tidyFilingsForTerminalPlan({ ...base, status: 'shipped', changed: true }, deps);

    expect(out.acceptanceReviewReservations).toEqual({ settled: [], failed: [{ id: 'WI-R2', error: 'gate refused' }] });
    expect(out.activationAuditRepair).toEqual({
      conditionKey: 'activation-audit:papercusp/plan-a',
      closed: null,
      error: 'writer unavailable',
    });
  });

  it('without a harness: skips the harness-keyed activation close and passes null to the settle', async () => {
    const deps = makeDeps();

    await tidyFilingsForTerminalPlan(
      { ...base, scope: { workspaceId: 'ws-1', harnessSlug: null }, status: 'shipped', changed: true },
      deps,
    );

    expect(deps.retire.mock.calls[0]?.[2]).toEqual({ terminalStatus: 'shipped' });
    expect(deps.settle.mock.calls[0]?.[1]).toMatchObject({ harnessSlug: null });
    expect(deps.reconcileActivationRepair).not.toHaveBeenCalled();
  });

  it('the handler routes its terminal tidy-up through this helper (no inline copy)', () => {
    const source = readFileSync(resolve(ROOT, 'packages/operator-core/lib/agent-tools/plans/set-plan-status.ts'), 'utf8');
    const handlerCalls = source.match(/await tidyFilingsForTerminalPlan\(\{/g) ?? [];
    expect(handlerCalls).toHaveLength(1);
    expect(source).toContain('...terminalTidy,');
    // The helper is the only caller of each dependency inside this module.
    expect(source.match(/await settleAcceptanceReviewReservationsForPlan\(/g) ?? []).toHaveLength(0);
    expect(source.match(/await retireAcceptanceRubricForPlan\(/g) ?? []).toHaveLength(0);
  });
});
