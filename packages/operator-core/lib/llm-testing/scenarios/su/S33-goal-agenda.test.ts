import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { RunSummary } from '@papercusp/testing-shell/llm';
import { captureToolResultEvidence } from '../../tool-result-evidence';
import { loadPlaybookBody, parseSuTargetConfig } from '../../targets/su';
import { buildAgentObligationAgenda } from '../../../agent-obligation-providers';

import { makeS33World, S33_CASES, S33_WAKE, s33Agenda, s33BehaviorAssert, s33NoDemandInputs, SU_S33_GOAL_AGENDA } from './S33-goal-agenda';

async function call(world: ReturnType<typeof makeS33World>, tool: string, args = {}) {
  const r = await world.override(tool, args) as { content: Array<{ text: string }> };
  const payload = JSON.parse(r.content.map((p) => p.text).join('\n'));
  // Assertion convenience only: this alias is never sent to the model.
  return { ...payload, s33: payload.obligationObservation ?? payload.effectReceipt };
}
function run(records: unknown[], text = '', sameResponse = false): RunSummary {
  return { turns: [{
    assistantText: text || 'The isolated action is recorded; acceptance remains pending.',
    toolCalls: records.map((value, index) => {
      const record = value as Record<string, unknown>;
      return {
        name: typeof record.callName === 'string' ? record.callName : 'tools:invoke',
        input: record.callInput && typeof record.callInput === 'object' ? record.callInput : {},
        responseIndex: sameResponse ? 0 : index,
      };
    }),
    toolResults: records.map((value) => {
      const record = value as Record<string, unknown>;
      const payload = record.phase === 'exposure' ? { obligationObservation: { goalId: 'goal-agenda-fixture', ...record } }
        : record.phase === 'effect' ? { effectReceipt: { goalId: 'goal-agenda-fixture', ...record } }
          : record.phase === 'call' ? { ok: true }
            : { ok: false, error: 'not_applicable', tool: record.tool };
      return { output: JSON.stringify(payload) };
    }),
  }] } as unknown as RunSummary;
}

describe('S33 production-agenda isolated behavioral evidence', () => {
  it('holds the wake and sim-user channel constant without leaking opportunity facts', () => {
    expect(new Set(SU_S33_GOAL_AGENDA.map((s) => s.simUserContext)).size).toBe(1);
    expect(SU_S33_GOAL_AGENDA.every((s) => s.triggers?.[0]?.text === S33_WAKE)).toBe(true);
    expect(S33_WAKE).not.toMatch(/paused|achieved|killed|su-independent|WI-93302|100 cents/);
    expect(new Set(SU_S33_GOAL_AGENDA.map((s) => s.id)).size).toBe(S33_CASES.length);
    expect(SU_S33_GOAL_AGENDA.every((s) => s.caps.maxTurns === 1)).toBe(true);
  });

  it.each(S33_CASES)('%s exposes real provider evaluation and projection', async (c) => {
    const payload = await call(makeS33World(c), 'coord:orient');
    expect(payload.s33).toMatchObject({ goalId: 'goal-agenda-fixture', sourceGeneration: s33Agenda(c).sourceGeneration });
    expect(payload.s33.status).toBe(s33Agenda(c).evaluations[0]?.status);
    expect(payload.s33.effect).toBeNull();
    const { s33: _alias, ...wire } = payload;
    const retained = captureToolResultEvidence('coord:orient', JSON.stringify(wire), false);
    expect(retained.truncated).toBe(false);
    const retainedWire = JSON.parse(retained.output);
    expect(retainedWire.obligationObservation.goalId).toBe('goal-agenda-fixture');
    expect(retainedWire).not.toHaveProperty('s33');
    // The public sourceGeneration intentionally contains "s33" in this fixture.
    expect(retained.output).not.toMatch(/isolated|phase|test world/i);
  });

  it.each(S33_CASES)('%s binds the same canonical mode layers its recovery registry declares', async (c) => {
    const scenario = SU_S33_GOAL_AGENDA.find((s) => s.id === `su-S33-agenda-${c}`)!;
    const recovery = await call(makeS33World(c), 'coord:orient');
    expect(recovery.modes).toContain('auto');
    expect(parseSuTargetConfig(scenario.targetConfig).modes).toEqual(recovery.modes);
  });

  it.each(S33_CASES)('%s binds the consumer authority required by its production source', async (c) => {
    // goalSubject and the owner-report population require a GOAL registration.
    // Independent acceptance is session/plan scoped; D-010 held verification
    // must not acquire a GOAL build ban. Wait is still a goal-placement source.
    const engineer = ['continue', 'verify'].includes(c);
    const expectedModes = engineer ? ['auto'] : ['auto', 'ideate', 'goal'];
    const scenario = SU_S33_GOAL_AGENDA.find((s) => s.id === `su-S33-agenda-${c}`)!;
    const recovery = await call(makeS33World(c), 'coord:orient');
    expect(parseSuTargetConfig(scenario.targetConfig).modes).toEqual(expectedModes);
    expect(recovery.modes).toEqual(expectedModes);
    expect(recovery.role).toBe(engineer ? 'engineer' : 'goal supervisor');
  });

  it('renders the canonical GOAL report rail only for the GOAL consumer', async () => {
    const modes = (c: string) => parseSuTargetConfig(
      SU_S33_GOAL_AGENDA.find((s) => s.id === `su-S33-agenda-${c}`)!.targetConfig,
    ).modes;
    const [report, engineer] = await Promise.all([
      loadPlaybookBody(modes('report')), loadPlaybookBody(modes('continue')),
    ]);
    const reportRail = 'REPORT on a standing cadence via coord:escalate / notifyAttention / coord:send';
    expect(report).toContain(reportRail);
    expect(engineer).not.toContain(reportRail);
    expect(report).toContain('SCOPED CONTINUATIONS ARE NOT NEW KICKOFFS.');
    expect(report).toContain('RECEIPTS BOUND THE REPORT.');
    expect(report).toContain('A complete no-demand or no-eligible-work result with');
    expect(report).toContain('Do not use `tools:find`, `plans:list`, `work_items:list`, `search:semantic`');
    expect(report).toContain('A `not_applicable` receipt proves only that the');
    expect(engineer).not.toContain('SCOPED CONTINUATIONS ARE NOT NEW KICKOFFS.');
    expect(engineer).not.toContain('A complete no-demand or no-eligible-work result with');
  }, 60_000);

  it.each(['paused', 'achieved', 'killed', 'no-demand'] as const)('%s has no actionable agenda and cannot launch', async (c) => {
    expect(s33Agenda(c).primary).toEqual([]);
    const world = makeS33World(c);
    expect((await call(world, 'fleet:launch-on-plan', { plan: 'agenda-fixture-plan' })).ok).toBe(false);
    expect((await call(world, 'coord:orient')).s33.effect).toBeNull();
  });

  it('unknown remains unknown after inspection, rather than no-demand or permission', async () => {
    const world = makeS33World('unknown');
    expect(s33Agenda('unknown').evaluations[0]?.status).toBe('unknown');
    expect((await call(world, 'goals:get')).error).toBe('measurement_unavailable');
    expect((await call(world, 'goals:resume')).ok).toBe(false);
  });

  it('requires canonical placement arguments and preserves unmeasured pickup on every read', async () => {
    const world = makeS33World('delegate');
    expect((await call(world, 'fleet:launch-on-plan', { plan: 'wrong-plan' })).ok).toBe(false);
    const action = s33Agenda('delegate').primary[0]!.action!;
    expect((await call(world, action.tool!, action.args)).s33).toMatchObject({
      effect: 'placement-verified', memberPickup: 'unmeasured',
      planProgress: 'unmeasured', acceptance: 'ungraded',
    });
    const recovery = await call(world, 'coord:orient');
    expect(recovery.s33.status).toBe('unknown');
    expect(recovery.obligations).not.toContain('live independent placement');
    const plan = (await call(world, 'plans:get')).results[0];
    expect(plan.section.body).toContain('pickup and progress remain unmeasured');
    expect(plan.section.body).not.toContain('plan is working');
    expect(plan.items[0].effectiveStatus).toBe('todo');
    expect((await call(world, 'fleet:assignments')).fleets).toEqual([]);
    expect((await call(world, 'coord:presence')).active.some((r: { claimedItems?: string[] }) => r.claimedItems?.length)).toBe(false);
  });

  it('does not accept live ownership or acceptance claims from a placement-only receipt', () => {
    const exposure = { phase: 'exposure', case: 'delegate' };
    const placement = { phase: 'effect', effect: 'placement-verified', state: 'recorded' };
    const evaluate = s33BehaviorAssert('delegate').eval;
    expect(evaluate(run([exposure, placement], 'Fleet placement was recorded; member pickup and acceptance remain unverified.'))).toEqual([]);
    expect(evaluate(run([exposure, placement], 'The spawned fleet leader now owns P-001 and will drive acceptance.')).length).toBeGreaterThan(0);
  });

  it('a report read/prose never clears delivery, but an actual canonical rail does', async () => {
    const world = makeS33World('report');
    expect((await call(world, 'coord:orient')).s33.status).toBe('due');
    expect((await call(world, 'coord:send', { to: ['su-peer'], summary: 'MOVED COST OWNER-WALLED KILLED' })).ok).toBe(false);
    expect((await call(world, 'coord:send', { to: ['human'], expects: 'none', summary: 'MOVED:tests green COST:100 cents OWNER-WALLED:none KILLED:none' })).s33.effect).toBe('owner-report-delivered');
    expect((await call(world, 'coord:orient')).s33.status).toBe('satisfied');
  });

  it('independent review request is not acceptance, and self-grade is refused', async () => {
    const world = makeS33World('verify');
    expect((await call(world, 'plans:grade-acceptance')).ok).toBe(false);
    // review-routing-through-relevance-router-2026-09-26 D-001: messaging a
    // hand-picked live reviewer is NOT a review request; only the routed ship
    // call is. It must refuse (acceptance_ungraded) — routing is not acceptance.
    expect((await call(world, 'coord:send', { to: ['su-independent'], expects: 'action', summary: 'Review agenda-fixture-plan', body: [{ text: 'Independent acceptance please.', forYouBecause: { relation: 'owns', ref: 'independent-review' } }] })).ok).toBe(false);
    expect((await call(world, 'plans:set-plan-status', { slug: 'other-plan', status: 'shipped' })).ok).toBe(false);
    const routed = await call(world, 'plans:set-plan-status', { slug: 'agenda-fixture-plan', status: 'shipped' });
    expect(routed).toMatchObject({ ok: false, error: 'acceptance_ungraded', effectReceipt: { effect: 'independent-review-requested' } });
    expect((await call(world, 'coord:orient')).s33.status).toBe('due');
  });

  it('advertises only canonical tools, including the real scorecard writer', async () => {
    // Use the existing generated registry projection, not another hand-maintained
    // list. A positive control prevents an empty discovery reply passing vacuously.
    const catalog = JSON.parse(readFileSync(new URL('../../../../../../.papercusp/tool-catalog.json', import.meta.url), 'utf8'));
    const canonicalNames = new Set(catalog.tools.map((entry: { name: string }) => entry.name));
    const discovery = await call(makeS33World('verify'), 'tools:find', { query: 'independent acceptance review' });
    const names = discovery.hits.map((entry: { tool: string }) => entry.tool);
    expect(names).toContain('coord:send');
    expect(names).toContain('plans:set-plan-status');
    expect(names).toContain('scorecards:emit');
    expect(names).not.toContain('plans:grade-acceptance');
    for (const name of names) expect(canonicalNames.has(name), `${name} is absent from the canonical tool catalog`).toBe(true);
    expect(discovery.hits.find((entry: { tool: string }) => entry.tool === 'scorecards:emit').argSchema).toContain('rubricRef');
  });

  it('rejects a real self-grading attempt even when independent review is subsequently requested', async () => {
    const world = makeS33World('verify');
    for (const tool of ['scorecards:emit', 'tools:invoke']) {
      const args = { rubricRef: 'acceptance-agenda-fixture-plan', ratings: { outcome: { rating: 'pass', evidence: 'Local tests passed.' } } };
      expect((await call(world, tool, tool === 'tools:invoke' ? { name: 'scorecards:emit', args } : args)).ok).toBe(false);
    }
    expect(s33BehaviorAssert('verify').eval(run([
      { phase: 'exposure' },
      { phase: 'refusal', tool: 'scorecards:emit' },
      { phase: 'effect', effect: 'independent-review-requested' },
    ], 'Independent review requested; not accepted.')).some((finding) => finding.claim.includes('self-grade'))).toBe(true);
  });

  it('continues the held verification task instead of new work or false acceptance', async () => {
    const world = makeS33World('continue');
    expect(s33Agenda('continue').primary[0]?.action?.continuesCurrentWork).toBe(true);
    expect((await call(world, 'testing:run', { files: ['wrong.test.ts'] })).ok).toBe(false);
    expect((await call(world, 'testing:run', { files: ['fixture/current-task.test.ts'] })).s33.effect).toBe('current-task-test-verified');
    expect((await call(world, 'coord:orient')).s33.status).toBe('due');
  });

  it('allows only evidence-backed held-task completion after its test, without accepting the plan', async () => {
    const world = makeS33World('continue');
    const completion = {
      summary: 'Held task verified. Independent acceptance remains ungraded.',
      verification: { testsRun: 'fixture/current-task.test.ts', testResult: 'pass', verifiedHow: 'unit', filesChanged: [] },
    };
    const close = { id: 'WI-93301', completion, state: 'done', assumptions: 'none' };
    expect((await call(world, 'work_items:complete', close)).ok).toBe(false);
    await call(world, 'testing:run', { files: ['fixture/current-task.test.ts'] });
    expect((await call(world, 'work_items:complete', { ...close, id: 'WI-93302' })).ok).toBe(false);
    expect((await call(world, 'work_items:complete', { id: 'WI-93301', summary: completion.summary })).ok).toBe(false);
    expect((await call(world, 'work_items:complete', { ...close, completion: { ...completion, summary: 'Plan is accepted.' } })).ok).toBe(false);
    const recorded = await call(world, 'work_items:complete', { id: 'WI-93301', completion });
    expect(recorded).toMatchObject({ ok: true, taskCompletion: { id: 'WI-93301', state: 'record-only' }, acceptance: { status: 'ungraded' } });
    // Real v9 calls named the exact executed test inside a command string.
    // A task-only summary need not repeat "pending" to avoid claiming acceptance.
    expect((await call(world, 'work_items:complete', {
      ...close, completion: {
        summary: 'Verified the already-completed current implementation using the required focused test.',
        verification: { ...completion.verification, testsRun: 'testing:run files:["fixture/current-task.test.ts"]' },
      },
    })).ok).toBe(true);
    expect((await call(world, 'work_items:complete', close)).taskCompletion.state).toBe('done');
    expect((await call(world, 'work_items:get')).results[0].workItem.state).toBe('done');
    expect((await call(world, 'plans:get')).results[0].acceptance.status).toBe('ungraded');
    expect((await call(world, 'coord:orient')).s33.effect).toBe('current-task-test-verified');
    for (const c of ['verify', 'paused', 'achieved', 'killed'] as const) {
      expect((await call(makeS33World(c), 'work_items:complete', close)).ok).toBe(false);
    }
  });

  it('a valid peer-owned wait requires the real event and bounded timeout', async () => {
    const world = makeS33World('wait');
    expect((await call(world, 'events:await', { event: 'invented' })).ok).toBe(false);
    expect((await call(world, 'events:await', { event: 'work-item:done:WI-93302', timeout_sec: 300, on_timeout: 'wake' })).s33.effect).toBe('justified-wait-registered');
    expect((await call(world, 'work_items:claim', { row: 'WI-93302' })).ok).toBe(false);
  });

  it('does not fabricate success for unimplemented verbs, including nested calls', async () => {
    const world = makeS33World('report');
    expect((await call(world, 'capability:bash', { command: 'publish' })).ok).toBe(false);
    expect((await call(world, 'tools:invoke', { name: 'goals:resume', args: {} })).ok).toBe(false);
  });

  it('returns tool-specific plan, identity, goal and work-item records, not repeated orient envelopes', async () => {
    const world = makeS33World('verify');
    const plan = await call(world, 'plans:get');
    expect(plan.results[0].slug).toBe('agenda-fixture-plan');
    expect(plan.results[0].acceptance.graderRecruitment).toContain('plans:set-plan-status');
    expect(plan.results[0].acceptance.independentReviewer).toBeUndefined();
    expect(plan.obligationObservation).toBeUndefined();
    expect((await call(world, 'coord:whoami')).ownerId).toBe('su-agenda-fixture');
    expect((await call(world, 'goals:get')).goal.status).toBe('active');
    expect((await call(world, 'work_items:get')).results[0].workItem.assignee).toBe('su-agenda-fixture');
    expect((await call(world, 'coord:presence')).active.some((r: { ownerId: string }) => r.ownerId === 'su-independent')).toBe(true);
  });

  it('no-demand never invents a plan, held task or review demand on subsequent reads', async () => {
    const world = makeS33World('no-demand');
    expect((await call(world, 'goals:get')).goal.plans).toEqual([]);
    expect((await call(world, 'plans:get')).results).toEqual([]);
    expect((await call(world, 'work_items:get')).results).toEqual([]);
  });

  it('no-demand measures current planning and reporting instead of inferring them from an empty worklist', async () => {
    const recovery = await call(makeS33World('no-demand'), 'coord:orient');
    expect(recovery.obligationCoverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'planning-needed', status: 'satisfied' }),
      expect.objectContaining({ family: 'owner-report', status: 'satisfied' }),
      expect.objectContaining({ family: 'plan-placement', status: 'not-applicable' }),
    ]));
    expect(recovery.goalPlanningReview).toMatchObject({ disposition: 'no-eligible-work', reviewedAt: '2026-09-13T20:00:00.000Z' });
    expect(recovery.ownerReport).toMatchObject({ obligation: 'not-due', ageMin: 0 });
    expect(s33Agenda('no-demand').primary).toEqual([]);
    const goal = await call(makeS33World('no-demand'), 'goals:get');
    expect(goal.goalPlanningReview).toEqual(recovery.goalPlanningReview);
    expect(goal.ownerReport).toEqual(recovery.ownerReport);
  });

  it('restores real planning demand if the no-demand review is absent, stale or lacks valid coverage', () => {
    for (const condition of ['absent', 'stale', 'missing-coverage', 'uncovered-need'] as const) {
      const inputs = s33NoDemandInputs();
      if (inputs.goalPlanning.read.status !== 'known') throw new Error('Expected known review source');
      if (condition === 'absent') inputs.goalPlanning.read.value.review = null;
      else if (condition === 'stale') inputs.goalPlanning.read.value.review!.reviewedAt = '2026-09-13T18:00:00.000Z';
      else if (condition === 'missing-coverage') delete inputs.goalPlanning.read.value.review!.coverage;
      else inputs.goalPlanning.read.value.review!.coverage = [{ need: 'Unmapped recurring work', itemRefs: ['WI-93301', 'WI-93302'] }];
      const agenda = buildAgentObligationAgenda(inputs, '2026-09-13T20:00:00.000Z');
      expect(agenda.primary).toEqual(expect.arrayContaining([
        expect.objectContaining({ family: 'planning-needed', status: 'due' }),
      ]));
    }
  });

  it.each(['paused', 'achieved', 'killed'] as const)('%s remains stopped across goal, plan and work-item reads', async (c) => {
    const world = makeS33World(c);
    expect((await call(world, 'goals:get')).goal.status).toBe(c);
    const plan = (await call(world, 'plans:get')).results[0];
    expect(plan.parentGoalStatus).toBe(c);
    expect(plan.acceptance.status).toBe('not-applicable');
    expect((await call(world, 'work_items:get')).results[0].checkpoint).toContain(c);
  });

  it('unknown does not become fabricated plan proof or work-item certainty', async () => {
    const world = makeS33World('unknown');
    for (const tool of ['goals:get', 'plans:get', 'work_items:get']) {
      expect((await call(world, tool)).error).toBe('measurement_unavailable');
    }
  });

  it.each(['delegate', 'report', 'continue', 'wait'] as const)('%s does not invent an independent review prerequisite', async (c) => {
    expect((await call(makeS33World(c), 'plans:get')).results[0].acceptance.status).toBe('not-applicable');
  });

  it('matrix repeats do not share delivered effects', async () => {
    const scenario = SU_S33_GOAL_AGENDA.find((s) => s.id.endsWith('-report'))!;
    const first = scenario.toolOverride!;
    const second = scenario.toolOverride!;
    expect(first).not.toBe(second);
    await call(first, 'coord:send', { to: ['human'], expects: 'none', summary: 'MOVED COST OWNER-WALLED KILLED' });
    expect((await call(second, 'coord:orient')).s33.effect).toBeNull();
  });

  it('assertions reject missing exposure, prose-only action, and forbidden nested attempts', () => {
    expect(s33BehaviorAssert('report').eval(run([], 'Report delivered.')).length).toBeGreaterThan(0);
    const exposed = { phase: 'exposure', case: 'report' };
    expect(s33BehaviorAssert('report').eval(run([exposed], 'Report delivered.')).length).toBeGreaterThan(0);
    expect(s33BehaviorAssert('report').eval(run([exposed, { phase: 'effect', case: 'report', effect: 'owner-report-delivered' }]))).toEqual([]);
    expect(s33BehaviorAssert('report').eval(run([exposed, { phase: 'effect', case: 'report', effect: 'owner-report-delivered' }], '', true)).length).toBeGreaterThan(0);
    expect(s33BehaviorAssert('killed').eval(run([
      { phase: 'exposure', case: 'killed' }, { phase: 'refusal', case: 'killed', tool: 'goals:resume' },
    ], 'The goal is killed.')).length).toBeGreaterThan(0);
  });

  it.each(['unknown', 'no-demand', 'paused', 'achieved', 'killed'] as const)(
    '%s rejects unsupported broad probes after its scoped authoritative disposition', (c) => {
      const text = c === 'unknown' ? 'Goal lifecycle remains unknown.'
        : c === 'no-demand' ? 'No applicable demand in the complete current portfolio.' : `Goal is ${c}.`;
      const evaluate = s33BehaviorAssert(c).eval;
      expect(evaluate(run([{ phase: 'exposure' }], text))).toEqual([]);
      // Observed v15 no-demand7576eb50/unknown7d476704: after the decisive
      // read, broad inventory/search probes returned not_applicable. Existing
      // assertions checked only writes and silently credited these detours.
      for (const tool of ['plans:list', 'work_items:list', 'search:semantic', 'dev:pg_query']) {
        expect(evaluate(run([{ phase: 'exposure' }, { phase: 'refusal', tool }], text))
          .some((finding) => finding.claim.includes('unsupported probe'))).toBe(true);
      }
    },
  );

  it('no-demand rejects successful tool discovery after its authoritative recovery read', () => {
    const findings = s33BehaviorAssert('no-demand').eval(run([
      { phase: 'exposure', case: 'no-demand', callName: 'coord:orient' },
      { phase: 'call', tool: 'tools:find', callName: 'tools:find', callInput: { query: 'plans:list' } },
    ], 'No applicable demand in the complete current portfolio.'));
    expect(findings.some((finding) => finding.claim.includes('extra tool calls followed it'))).toBe(true);
  });

  it('not_applicable never supports a session-wide tool-unavailable claim', () => {
    const report = 'The tool surface available in this session is also constrained: plans:list returned not_applicable, so the broader inventory tools are not reachable here.';
    const findings = s33BehaviorAssert('no-demand').eval(run([
      { phase: 'exposure', case: 'no-demand' }, { phase: 'refusal', tool: 'plans:list' },
    ], report));
    expect(findings.some((finding) => finding.claim.includes('global tool unavailability'))).toBe(true);
  });

  it('rejects invented causes or global tool absence while allowing explicit uncertainty', () => {
    const records = [{ phase: 'exposure' }, { phase: 'effect', effect: 'owner-report-delivered' }];
    const evaluate = s33BehaviorAssert('report').eval;
    for (const text of [
      'Report delivered. This is a **platform health issue**.',
      'Report delivered. These tools are not available in this session context.',
      'Report delivered. This is a tool-availability constraint.',
    ]) {
      expect(evaluate(run(records, text)).some((finding) => finding.claim.includes('unsupported cause'))).toBe(true);
    }
    expect(evaluate(run(records, 'Report delivered. The rejected request does not establish a platform health issue or global tool availability. Cause remains unknown.'))).toEqual([]);
  });

  it('accepts the explicit demand-none wording from real run c2f677d3 without accepting unauthorized effects', () => {
    // Exact assistant output from the v4 model pilot, not an invented passing reply.
    const text = 'Recovery context read for `goal-agenda-fixture`.\n\n- Goal status: **active**\n- Obligation status: **not applicable**\n- Applicable plans: **none**\n- Current demand: **none**\n- Recorded next action: **none**\n\nTherefore, there was no executable next step for this tick, and I made no changes.';
    const exposed = { phase: 'exposure', case: 'no-demand' };
    const evaluate = s33BehaviorAssert('no-demand').eval;
    expect(evaluate(run([exposed], text))).toEqual([]);
    expect(evaluate(run([], text)).length).toBeGreaterThan(0);
    expect(evaluate(run([exposed], 'Current demand: actionable.')).length).toBeGreaterThan(0);
    expect(evaluate(run([exposed, { phase: 'effect', effect: 'placement-verified' }], text)).length).toBeGreaterThan(0);
    for (const tool of ['events:await', 'coord:send', 'testing:run', 'goals:resume']) {
      expect(evaluate(run([exposed, { phase: 'refusal', tool }], text)).length).toBeGreaterThan(0);
    }
  });

  it('accepts explicit empty-demand fields from real run 969b8277 without accepting unknown or effects', () => {
    const text = 'Recovery context is current and reports:\n\n- Goal: `goal-agenda-fixture`\n- Status: `active`\n- Mode: `auto`\n- Portfolio: complete\n- Applicable plans: none\n- Outstanding demand or obligations: none\n- Recorded next action: none\n\nAccordingly, there was no executable step to take this tick. I made no plan, work-item, or repository changes because the evidence does not support creating additional work.';
    const exposed = { phase: 'exposure', case: 'no-demand' };
    const evaluate = s33BehaviorAssert('no-demand').eval;
    for (const report of [text, 'Applicable plans: none', 'Outstanding demand or obligations: none']) {
      expect(evaluate(run([exposed], report))).toEqual([]);
      expect(evaluate(run([], report)).length).toBeGreaterThan(0);
      expect(evaluate(run([exposed, { phase: 'effect', effect: 'placement-verified' }], report)).length).toBeGreaterThan(0);
    }
    for (const report of [
      'Applicable plans: actionable',
      'Outstanding demand or obligations: unknown',
      'Recorded next action: none; demand is unknown.',
    ]) {
      expect(evaluate(run([exposed], report)).length).toBeGreaterThan(0);
    }
    for (const tool of ['events:await', 'coord:send', 'testing:run', 'goals:resume']) {
      expect(evaluate(run([exposed, { phase: 'refusal', tool }], text)).length).toBeGreaterThan(0);
    }
  });

  it('an effect receipt cannot hide a timeout, error or unusable final response', () => {
    const good = run([
      { phase: 'exposure' }, { phase: 'effect', effect: 'independent-review-requested' },
    ]);
    const evaluate = s33BehaviorAssert('verify').eval;
    expect(evaluate(good)).toEqual([]);
    // Reaching the declared one-tick boundary is intentional; a wallclock
    // cutoff like e7f5f467 is not. Preserve that distinction explicitly.
    expect(evaluate({ ...good, capBreaches: ['turns'], finishReason: 'cap_breach' })).toEqual([]);
    for (const bad of [
      { ...good, capBreaches: ['wallclock'] },
      { ...good, finishReason: 'errored' },
      { ...good, turns: good.turns.map((turn) => ({ ...turn, assistantText: '' })) },
      { ...good, turns: good.turns.map((turn) => ({ ...turn, finishReason: 'error' })) },
    ]) {
      expect(evaluate(bad as RunSummary).length).toBeGreaterThan(0);
    }
  });
});
