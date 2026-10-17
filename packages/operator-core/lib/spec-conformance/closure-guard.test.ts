import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CompletionRecordSchema } from '../coord-lifecycle/records';
import {
  evaluateConformanceClosure,
  evaluateConformanceClosureAssessment,
  type ConformanceClosureDeps,
  type RequirementClosureDeclaration,
} from './closure-guard';
import type { ConformanceCheckVerdict, OpenDriftAlarm } from './conformance-run';

function requirement(key: string, manual = false, withoutCheck = false): string {
  const verification = withoutCheck
    ? { method: 'The check is not available yet.' }
    : { method: 'Run the check.', check: manual ? { kind: 'instrument', instrumentKey: 'none' } : { kind: 'tests', files: ['fixture.test.ts'] } };
  return `**${key} — Outcome.**\n\`\`\`requirement\n${JSON.stringify({
    intent: { request: `Deliver ${key}.`, sourceRefs: ['P-001'] },
    acceptance: { condition: `${key} holds.`, falsifier: `${key} fails.` },
    verification,
  })}\n\`\`\`\n`;
}
function plan(options: { manual?: boolean; malformed?: boolean; deviation?: 'proposed' | 'approved'; withoutCheck?: 'R-1' | 'R-2' } = {}): string {
  const proposal = { op: 'propose', requirement: 'R-1', reason: 'Replaced.', proposedBy: 'su-test' };
  const approval = { op: 'approve', requirement: 'R-1', proposal: 'D-001', approvedBy: 'su-test', ownerSourced: false };
  const decisions = options.deviation ? `### D-001 — Proposal\n\`\`\`deviation\n${JSON.stringify(proposal)}\n\`\`\`\n` +
    (options.deviation === 'approved' ? `### D-002 — Approval\n\`\`\`deviation\n${JSON.stringify(approval)}\n\`\`\`\n` : '') : '';
  return `---\nslug: fixture\nstatus: active\n---\n## Requirements\n${requirement('R-1', options.manual, options.withoutCheck === 'R-1')}${requirement('R-2', false, options.withoutCheck === 'R-2')}
## Design
### Bar-to-work map for this plan
| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001 | tree |
| R-2 | P-002 | tree |
## Build
- **P-001** \`todo\` Deliver R-1
- **P-002** \`todo\` Deliver R-2
- **P-003** \`todo\` Unmapped support work
${options.malformed ? '## Conformance\n```conformance\n{\n```\n' : options.manual ? `## Conformance\n\`\`\`conformance\n${JSON.stringify({ requirements: { 'R-1': { unenforced: { reason: 'Owner-reviewed manual outcome.', approvalRef: 'D-003' } } } })}\n\`\`\`\n` : ''}
## Decisions
${decisions}${options.manual ? '\n### D-003 — Approved manual verification\nR-1 is explicitly unenforced; the manual review supplies the outcome.\n' : ''}`;
}
function world(verdict: ConformanceCheckVerdict | null = 'pass', alarms: OpenDriftAlarm[] = []) {
  const deps: ConformanceClosureDeps = { listOpenDriftAlarms: vi.fn(async () => alarms), readDoneWhenVerdict: vi.fn(async () => verdict) };
  const run = (completion: RequirementClosureDeclaration, planContent = plan(), planItemIds = ['P-001']) =>
    evaluateConformanceClosure({ completion, planContent, planItemIds }, deps);
  const assess = (completion: RequirementClosureDeclaration, planContent = plan(), planItemIds = ['P-001']) =>
    evaluateConformanceClosureAssessment({ completion, planContent, planItemIds }, deps);
  return { deps, run, assess };
}
describe('spec-discharging closure (R-16/R-18/R-19)', () => {
  it.each(['plan.md', 'report.md'])('lets the shipped bug-triage %s close only with executable passing proof', async (file) => {
    const content = readFileSync(new URL(`../../../../libs/papercusp/plugins/bug-triage/${file}`, import.meta.url), 'utf8');
    const passing = world('pass');
    expect(await passing.run({ discharges: ['R-1'] }, content)).toBeNull();
    expect(passing.deps.readDoneWhenVerdict).toHaveBeenCalledWith(expect.objectContaining({
      barKey: 'R-1', doneWhen: 'executable',
    }));
    for (const verdict of [null, 'fail', 'error'] as const) {
      expect(await world(verdict).run({ discharges: ['R-1'] }, content))
        .toMatchObject({ code: 'conformance_done_when_not_passing', requirements: ['R-1'] });
    }
  });
  it('requires a mapped requirement declaration before check reads', async () => {
    const w = world();
    expect(await w.run({})).toMatchObject({ code: 'conformance_requirements_missing', requirements: ['R-1'] });
    expect(w.deps.readDoneWhenVerdict).not.toHaveBeenCalled();
    expect(w.deps.listOpenDriftAlarms).not.toHaveBeenCalled();
  });
  it('returns mapped and declared requirement keys alongside the refusal assessment', async () => {
    const assessment = await world().assess({ contributesTo: ['R-999'] });
    expect(assessment).toMatchObject({
      applicable: true,
      mappedRequirements: ['R-1'],
      declaredRequirements: ['R-999'],
      declarationSatisfied: false,
      refusal: { code: 'conformance_requirement_unmapped', requirements: ['R-999'] },
    });
  });
  it('returns declaration metadata when the mapped requirement passes', async () => {
    const assessment = await world().assess({ discharges: ['R-1'], contributesTo: ['R-1'] });
    expect(assessment).toMatchObject({
      applicable: true,
      mappedRequirements: ['R-1'],
      declaredRequirements: ['R-1'],
      declarationSatisfied: true,
      refusal: null,
    });
  });
  it('allows a passing discharged requirement', async () => {
    const w = world();
    expect(await w.run({ discharges: ['R-1'] })).toBeNull();
    expect(w.deps.readDoneWhenVerdict).toHaveBeenCalledOnce();
  });
  it.each(['fail', 'error', null] as const)('refuses discharged done-when verdict %s', async (verdict) => {
    expect(await world(verdict).run({ discharges: ['R-1'] })).toMatchObject({ code: 'conformance_done_when_not_passing', requirements: ['R-1'] });
  });
  it('allows contribution without claiming discharge', async () => {
    const w = world('fail');
    expect(await w.run({ contributesTo: ['R-1'] })).toBeNull();
    expect(w.deps.readDoneWhenVerdict).not.toHaveBeenCalled();
  });
  it('blocks a contribution on an open mapped drift alarm', async () => {
    expect(await world('pass', [{ id: 'EI-drift', barKey: 'R-1', doneWhenRegressed: false }]).run({ contributesTo: ['R-1'] }))
      .toMatchObject({ code: 'conformance_drift_alarm_open', alarmIds: ['EI-drift'] });
  });
  it('does not let a different named requirement bypass an alarm on the mapped population', async () => {
    const w = world('pass', [{ id: 'EI-drift', barKey: 'R-2', doneWhenRegressed: true }]);
    expect(await w.run({ contributesTo: ['R-1'] }, plan(), ['P-001', 'P-002']))
      .toMatchObject({ code: 'conformance_drift_alarm_open', requirements: ['R-2'] });
  });
  it('ignores alarms on unrelated requirements', async () => {
    expect(await world('pass', [{ id: 'EI-other', barKey: 'R-2', doneWhenRegressed: true }]).run({ discharges: ['R-1'] })).toBeNull();
  });
  it.each(['R-2', 'R-999'])('refuses an unmapped declaration %s', async (key) => {
    expect(await world().run({ discharges: [key] })).toMatchObject({ code: 'conformance_requirement_unmapped', requirements: [key] });
  });
  it('leaves support items without mapped requirements unaffected', async () => {
    const w = world('fail');
    expect(await w.run({}, plan(), ['P-003'])).toBeNull();
    expect(w.deps.listOpenDriftAlarms).not.toHaveBeenCalled();
  });
  it('does not block a mapped item on an unrelated requirement that is unenforced', async () => {
    const w = world('pass');
    expect(await w.run({ discharges: ['R-1'] }, plan({ withoutCheck: 'R-2' }), ['P-001'])).toBeNull();
    expect(w.deps.readDoneWhenVerdict).toHaveBeenCalledOnce();
  });
  it('returns the mapped requirement keys when a plan-level blocker applies to this item', async () => {
    const assessment = await world('pass').assess({ discharges: ['R-1'] }, plan({ withoutCheck: 'R-1' }), ['P-001']);
    expect(assessment).toMatchObject({
      applicable: true,
      mappedRequirements: ['R-1'],
      refusal: { code: 'conformance_contract_invalid', requirements: ['R-1'] },
    });
  });
  it('does not require manual checks to have executable results', async () => {
    const w = world(null);
    expect(await w.run({ discharges: ['R-1'] }, plan({ manual: true }))).toBeNull();
    expect(w.deps.readDoneWhenVerdict).not.toHaveBeenCalled();
  });
  it('refuses an unreadable conformance contract', async () => {
    expect(await world().run({ discharges: ['R-1'] }, plan({ malformed: true }))).toMatchObject({ code: 'conformance_contract_invalid' });
  });
  it('allows a recorded approved deviation instead of a pass or alarm resolution', async () => {
    const w = world('fail', [{ id: 'EI-drift', barKey: 'R-1', doneWhenRegressed: true }]);
    expect(await w.run({ discharges: ['R-1'] }, plan({ deviation: 'approved' }))).toBeNull();
    expect(w.deps.readDoneWhenVerdict).not.toHaveBeenCalled();
  });
  it('does not treat a proposed deviation as approved', async () => {
    expect(await world('fail', [{ id: 'EI-drift', barKey: 'R-1', doneWhenRegressed: true }]).run({ discharges: ['R-1'] }, plan({ deviation: 'proposed' })))
      .toMatchObject({ code: 'conformance_drift_alarm_open' });
  });
  it('preserves requirement declarations in the completion schema', () => {
    expect(CompletionRecordSchema.parse({ workItem: 'WI-test', summary: 'Done', discharges: ['R-1'], contributesTo: ['R-2'] }))
      .toMatchObject({ discharges: ['R-1'], contributesTo: ['R-2'] });
  });
});
