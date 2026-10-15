import { describe, expect, it } from 'vitest';
import { parseRequirementBars } from './acceptance-bar-seed';
import {
  amendedRequirementBarKeys,
  diffAmendedCriteriaAgainstRequirements,
  rerenderAmendedRequirementBlocks,
} from './acceptance-bar-amendment-requirements-drift';

// EI-24816459669484550: a rubric amendment can leave the plan's ## Requirements block
// disagreeing with the canonical rubric. These cases parse REAL plan text, so the
// falsifier -> driftMarkers mapping is exercised end to end, not restated by hand.

const sections = {
  intent: { request: 'Export every matching customer.', sourceRefs: ['session_turn:export'] },
  acceptance: {
    condition: 'Every matching ID appears exactly once with correct values.',
    falsifier: 'Any ID is missing or duplicated.',
    evidencePlane: 'tree',
    requiredScope: ['filters', 'pagination'],
    requiredTestLayers: ['e2e'],
  },
  verification: {
    method: 'Export a multi-page fixture and compare all expected rows.',
    check: { kind: 'instrument', instrumentKey: 'none' },
  },
};

const planContent = [
  '# Drift target',
  '',
  '## Requirements',
  '',
  '**R-1 — Complete export.**',
  '```requirement',
  JSON.stringify(sections),
  '```',
  '',
  '**R-2 — Legacy prose outcome.** The writer persists one canonical bar.',
  '',
  '## Items',
  '',
].join('\n');

function bars() {
  const parsed = parseRequirementBars(planContent);
  if (!parsed.ok) throw new Error(`fixture plan failed to parse: ${JSON.stringify(parsed.problems)}`);
  return parsed.bars;
}

// The rubric criteria exactly as the plan seeds them (R-2's driftMarkers is the generated
// sentence a legacy prose BAR receives, which the plan itself never states).
const inSyncCriteria = (): Array<Record<string, unknown>> => [
  {
    key: 'r-1', barKey: 'R-1', model: sections.acceptance.condition,
    driftMarkers: sections.acceptance.falsifier,
    method: sections.verification.method,
    check: { ...sections.verification.check },
    requiredScope: [...sections.acceptance.requiredScope],
    requiredTestLayers: [...sections.acceptance.requiredTestLayers],
    evidencePlane: sections.acceptance.evidencePlane,
  },
  {
    key: 'r-2', barKey: 'R-2', model: 'The writer persists one canonical bar.',
    driftMarkers: 'R-2 is falsified when the required outcome is absent, contradicted, or cannot be evidenced.',
  },
];

describe('diffAmendedCriteriaAgainstRequirements', () => {
  it('fixture sanity: the three-section R-1 carries its falsifier as driftMarkers, the prose R-2 has none', () => {
    const [r1, r2] = bars();
    expect(r1!.criterion?.driftMarkers).toBe(sections.acceptance.falsifier);
    expect(r2!.criterion).toBeUndefined();
  });

  it('reports nothing when the amended rubric agrees with the plan', () => {
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: inSyncCriteria(), changedBars: ['R-1'],
    });
    expect(drift).toEqual({ inSync: true, entries: [], action: null });
  });

  it('ignores whitespace-only differences, because the canonical writer collapses BAR text', () => {
    const criteria = inSyncCriteria();
    criteria[0]!.model = `  ${sections.acceptance.condition.replace(/ /g, '\n  ')}  `;
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: criteria, changedBars: ['R-1'],
    });
    expect(drift.inSync).toBe(true);
  });

  it('flags the R-13 incident shape: model patched to match, driftMarkers left on the superseded falsifier', () => {
    const criteria = inSyncCriteria();
    criteria[0]!.driftMarkers = 'An ingested ticket creates a work_items row.';
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: criteria, changedBars: ['R-1'],
    });
    expect(drift.inSync).toBe(false);
    expect(drift.entries).toEqual([
      { barKey: 'R-1', changedByAmendment: true, kind: 'text-differs', fields: ['driftMarkers'] },
    ]);
    expect(drift.action).toContain('R-1 (driftMarkers)');
  });

  it('flags a reworded model the plan block was never updated to match', () => {
    const criteria = inSyncCriteria();
    criteria[0]!.model = 'Every matching ID appears at least once.';
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: criteria, changedBars: ['R-1'],
    });
    expect(drift.entries).toEqual([
      { barKey: 'R-1', changedByAmendment: true, kind: 'text-differs', fields: ['model'] },
    ]);
  });

  it('never compares driftMarkers for a legacy prose BAR (its falsifier is generated, not authored)', () => {
    const criteria = inSyncCriteria();
    criteria[1]!.driftMarkers = 'Anything at all.';
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: criteria, changedBars: ['R-2'],
    });
    expect(drift.inSync).toBe(true);
  });

  it('marks drift on a BAR this amendment does not touch as pre-existing', () => {
    const criteria = inSyncCriteria();
    criteria[1]!.model = 'The writer persists two bars.';
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: criteria, changedBars: ['R-1'],
    });
    expect(drift.entries).toEqual([
      { barKey: 'R-2', changedByAmendment: false, kind: 'text-differs', fields: ['model'] },
    ]);
  });

  it('skips removed BARs and non-BAR criteria, and names a BAR the plan does not carry', () => {
    const criteria: Array<Record<string, unknown>> = [
      ...inSyncCriteria(),
      { key: 'r-3', barKey: 'R-3', model: 'A new outcome.' },
      { key: 'quality', model: 'A non-BAR quality criterion.' },
    ];
    criteria[1]!.model = 'Retired text that would otherwise be drift.';
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: criteria, changedBars: ['R-2', 'R-3'], removedBars: ['R-2'],
    });
    expect(drift.entries).toEqual([
      { barKey: 'R-3', changedByAmendment: true, kind: 'missing-from-plan', fields: [] },
    ]);
    expect(drift.action).toContain('R-3 (missing from plan)');
  });

  it('orders entries by BAR number, not lexically (R-10 after R-2)', () => {
    const tenSections = { ...sections, acceptance: { ...sections.acceptance, condition: 'Ten holds.' } };
    const content = planContent.replace(
      '## Items',
      ['**R-10 — Tenth.**', '```requirement', JSON.stringify(tenSections), '```', '', '## Items'].join('\n'),
    );
    const parsed = parseRequirementBars(content);
    if (!parsed.ok) throw new Error('fixture plan failed to parse');
    const criteria: Array<Record<string, unknown>> = [
      { key: 'r-10', barKey: 'R-10', model: 'Ten drifted.', driftMarkers: sections.acceptance.falsifier },
      { ...inSyncCriteria()[1]!, model: 'Two drifted.' },
    ];
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: parsed.bars, nextCriteria: criteria, changedBars: [],
    });
    expect(drift.entries.map((entry) => entry.barKey)).toEqual(['R-2', 'R-10']);
  });

  // WI-10006829: rev 10 of acceptance-pui-chat-first-ux moved R-01's check.files to a different
  // test file; the plan block kept the old (nonexistent) files and this advisory said inSync:true.
  it('flags an amendment that moves check to different files while the plan block keeps the old check', () => {
    const criteria = inSyncCriteria();
    criteria[0]!.check = { kind: 'tests', files: ['apps/tui/lib/agent-chat-pty.integration.test.ts'] };
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: criteria, changedBars: ['R-1'],
    });
    expect(drift.inSync).toBe(false);
    expect(drift.entries).toEqual([
      { barKey: 'R-1', changedByAmendment: true, kind: 'text-differs', fields: ['check'] },
    ]);
    expect(drift.action).toContain('R-1 (check)');
  });

  it('flags a reworded method and a replication the plan block never states', () => {
    const criteria = inSyncCriteria();
    criteria[0]!.method = 'Run the PTY suite once.';
    criteria[0]!.replication = 'Re-run on a second machine.';
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: criteria, changedBars: ['R-1'],
    });
    expect(drift.entries).toEqual([
      { barKey: 'R-1', changedByAmendment: true, kind: 'text-differs', fields: ['method', 'replication'] },
    ]);
  });

  it('flags stated acceptance metadata that the amendment changed', () => {
    const criteria = inSyncCriteria();
    criteria[0]!.requiredTestLayers = ['e2e', 'unit'];
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: criteria, changedBars: ['R-1'],
    });
    expect(drift.entries).toEqual([
      { barKey: 'R-1', changedByAmendment: true, kind: 'text-differs', fields: ['requiredTestLayers'] },
    ]);
  });

  it('does not compare acceptance metadata the plan block leaves to the seeder', () => {
    const criteria = inSyncCriteria();
    // The fixture block never states evidenceRuntime, so the seeder (not the plan) owns it.
    criteria[0]!.evidenceRuntime = 'staging';
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: criteria, changedBars: ['R-1'],
    });
    expect(drift.inSync).toBe(true);
  });

  it('compares check structurally: key order and file order are not drift', () => {
    const content = planContent.replace(
      JSON.stringify(sections),
      JSON.stringify({
        ...sections,
        verification: { ...sections.verification, check: { kind: 'tests', files: ['a.test.ts', 'b.test.ts'] } },
      }),
    );
    const parsed = parseRequirementBars(content);
    if (!parsed.ok) throw new Error(`fixture plan failed to parse: ${JSON.stringify(parsed.problems)}`);
    const criteria = inSyncCriteria();
    criteria[0]!.check = { files: ['b.test.ts', 'a.test.ts'], kind: 'tests' };
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: parsed.bars, nextCriteria: criteria, changedBars: ['R-1'],
    });
    expect(drift.inSync).toBe(true);
  });

  it('never compares verification fields for a legacy prose BAR (the plan states none)', () => {
    const criteria = inSyncCriteria();
    criteria[1]!.method = 'Any method.';
    criteria[1]!.check = { kind: 'tests', files: ['x.test.ts'] };
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: criteria, changedBars: ['R-2'],
    });
    expect(drift.inSync).toBe(true);
  });

  it('WI-10006835: says which drift the apply re-renders and which still needs a manual plan edit', () => {
    const criteria = inSyncCriteria();
    criteria[0]!.check = { kind: 'tests', files: ['moved.integration.test.ts'] };
    criteria[1]!.model = 'The writer persists one canonical bar, reworded.';
    const drift = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: criteria, changedBars: ['R-1', 'R-2'],
    });
    expect(drift.rerenderedOnApply).toEqual(['R-1']);
    expect(drift.action).toContain('re-renders the explicit requirement block of R-1');
    expect(drift.action).toContain('Nothing re-renders R-2');
  });
});

// WI-10006835: the apply re-renders the changed BARs' explicit blocks. Each case round-trips through
// the REAL parser and the drift diff, so "in sync after apply" is measured, not restated.
describe('rerenderAmendedRequirementBlocks', () => {
  const amended = (): Array<Record<string, unknown>> => {
    const criteria = inSyncCriteria();
    // The pui-chat-first-ux rev 10 shape: the amendment moved check.files and reworded the method.
    criteria[0]!.check = { kind: 'tests', files: ['packages/x/moved.integration.test.ts'] };
    criteria[0]!.method = 'Run the moved PTY suite against the current build.';
    criteria[0]!.driftMarkers = 'Any ID is missing, duplicated, or out of order.';
    return criteria;
  };

  it('rewrites a changed explicit block so the plan reads in sync with the amended rubric', () => {
    const before = diffAmendedCriteriaAgainstRequirements({
      requirementBars: bars(), nextCriteria: amended(), changedBars: ['R-1'],
    });
    expect(before.inSync).toBe(false);

    const result = rerenderAmendedRequirementBlocks(planContent, { nextCriteria: amended(), changedBars: ['R-1'] });
    expect(result.rerendered).toEqual(['R-1']);
    const parsed = parseRequirementBars(result.content);
    if (!parsed.ok) throw new Error(`re-rendered plan failed to parse: ${JSON.stringify(parsed.problems)}`);
    const after = diffAmendedCriteriaAgainstRequirements({
      requirementBars: parsed.bars, nextCriteria: amended(), changedBars: ['R-1'],
    });
    expect(after).toEqual({ inSync: true, entries: [], action: null });
    // Intent is the plan's own record of the request; the amendment never rewrites it.
    expect(parsed.bars[0]!.criterion?.intent).toEqual(sections.intent);
  });

  it('leaves legacy prose, unchanged BARs and every other line byte-identical', () => {
    const result = rerenderAmendedRequirementBlocks(planContent, { nextCriteria: amended(), changedBars: ['R-1'] });
    const beforeLines = planContent.split('\n');
    const afterLines = result.content.split('\n');
    expect(afterLines).toHaveLength(beforeLines.length);
    const differing = beforeLines.flatMap((line, index) => (line === afterLines[index] ? [] : [index]));
    // Only the single JSON line of R-1's block changes.
    expect(differing).toEqual([beforeLines.indexOf(JSON.stringify(sections))]);

    const prose = rerenderAmendedRequirementBlocks(planContent, {
      nextCriteria: [{ ...inSyncCriteria()[1]!, model: 'Reworded prose outcome.' }], changedBars: ['R-2'],
    });
    expect(prose).toEqual({ content: planContent, rerendered: [] });
  });

  it('is a no-op when the amended criterion already matches the block, or the BAR did not change', () => {
    expect(rerenderAmendedRequirementBlocks(planContent, { nextCriteria: inSyncCriteria(), changedBars: ['R-1'] }))
      .toEqual({ content: planContent, rerendered: [] });
    expect(rerenderAmendedRequirementBlocks(planContent, { nextCriteria: amended(), changedBars: [] }))
      .toEqual({ content: planContent, rerendered: [] });
  });

  it('EI-25970739425963382: detects and renders every stated acceptance field', () => {
    const acceptance = { ...sections.acceptance, mandatory: true, role: 'outcome', passRatings: ['pass'], coversBarKeys: ['R-1'] };
    const content = planContent.replace(JSON.stringify(sections), JSON.stringify({ ...sections, acceptance }));
    const parsed = parseRequirementBars(content);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
    const criteria = inSyncCriteria();
    Object.assign(criteria[0]!, { mandatory: false, role: 'disclosure', passRatings: ['partial'], coversBarKeys: ['R-2'] });
    const before = diffAmendedCriteriaAgainstRequirements({ requirementBars: parsed.bars, nextCriteria: criteria, changedBars: ['R-1'] });
    expect(before.entries[0]?.fields).toEqual(['passRatings', 'mandatory', 'role', 'coversBarKeys']);
    const rendered = rerenderAmendedRequirementBlocks(content, { nextCriteria: criteria, changedBars: ['R-1'] });
    const after = parseRequirementBars(rendered.content);
    if (!after.ok) throw new Error(JSON.stringify(after.problems));
    expect(after.bars[0]!.criterion).toMatchObject({ mandatory: false, role: 'disclosure', passRatings: ['partial'], coversBarKeys: ['R-2'] });
    expect(diffAmendedCriteriaAgainstRequirements({ requirementBars: after.bars, nextCriteria: criteria, changedBars: ['R-1'] }).inSync).toBe(true);
  });

  it('EI-25970739425963382: renders replication and declared production configuration independently of meaning selection', () => {
    const prior = inSyncCriteria();
    const criteria = inSyncCriteria();
    Object.assign(criteria[0]!, { replication: 'Repeat the export on a fresh fixture.', productionConfiguration: { flags: { 'papercusp-loops': true } } });
    const changedBars = amendedRequirementBarKeys(prior, criteria);
    expect(changedBars).toEqual(['R-1']);
    const rendered = rerenderAmendedRequirementBlocks(planContent, { nextCriteria: criteria, changedBars });
    const parsed = parseRequirementBars(rendered.content);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
    expect(parsed.bars[0]!.criterion).toMatchObject({ replication: 'Repeat the export on a fresh fixture.', productionConfiguration: { flags: { 'papercusp-loops': true } } });
    expect(diffAmendedCriteriaAgainstRequirements({ requirementBars: parsed.bars, nextCriteria: criteria, changedBars }).inSync).toBe(true);
    expect(amendedRequirementBarKeys(prior, inSyncCriteria())).toEqual([]);
  });
});
