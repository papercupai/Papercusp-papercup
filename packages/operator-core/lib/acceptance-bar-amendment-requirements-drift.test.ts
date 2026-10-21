import { describe, expect, it } from 'vitest';
import { parseBarMappings, parseRequirementBars, validateAcceptanceBarSource } from './acceptance-bar-seed';
import {
  acceptanceBarSourceFingerprint,
  amendedRequirementBarKeys,
  applyBarMappingDelta,
  barMappingDeltaHash,
  diffAmendedCriteriaAgainstRequirements,
  normalizeBarMappingDelta,
  rerenderAmendedRequirementBlocks,
  retireRequirementBarsFromSource,
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
  it('keeps the explicit block and map plane consistent while preserving discharge edges', () => {
    const content = planContent + [
      '## Design', '### Bar-to-work map for this plan',
      '| bar | implementing plan items | evidence plane |', '|---|---|---|',
      '| R-1 | P-001, P-002 | tree |', '| R-2 | P-002 | tree |',
      '## Build', '- **P-001** `done` export', '- **P-002** `done` persist',
    ].join('\n');
    const criteria = inSyncCriteria();
    criteria[0]!.evidencePlane = 'live';
    const rendered = rerenderAmendedRequirementBlocks(content, { nextCriteria: criteria, changedBars: ['R-1'] });
    expect(rendered.content).toContain('| R-1 | P-001, P-002 | live |');
    expect(rendered.content).toContain('| R-2 | P-002 | tree |');
    expect(rendered.rerendered).toEqual(['R-1']);
    const parsed = validateAcceptanceBarSource(rendered.content);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.mappings[0]).toMatchObject({ planItemIds: ['P-001', 'P-002'], evidencePlane: 'live' });
    // Repair a historical map even when its requirement block is already current.
    const stale = rendered.content.replace('| R-1 | P-001, P-002 | live |', '| R-1 | P-001, P-002 | tree |');
    expect(validateAcceptanceBarSource(stale).ok).toBe(false);
    expect(rerenderAmendedRequirementBlocks(stale, { nextCriteria: criteria, changedBars: ['R-1'] })).toEqual(rendered);
    expect(rerenderAmendedRequirementBlocks(rendered.content, { nextCriteria: criteria, changedBars: ['R-1'] }))
      .toEqual({ content: rendered.content, rerendered: [] });
  });

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

// EI-24358433996857425 (acceptance-bar-atomic-retirement-2026-10-15 D-002, R-6/R-7/R-27/R-32):
// the amendment validates the PROPOSED source, derived from the baseline and the retiring set.
describe('retireRequirementBarsFromSource', () => {
  const retirementPlan = (requirements: string[], mapRows: string[]) => [
    '# Retirement target',
    '',
    '## Requirements',
    '',
    'Intro prose stays.',
    '',
    ...requirements,
    '## Phase 1',
    '',
    '- **P-001** `done` first outcome',
    '- **P-002** `dropped` second outcome',
    '- **P-003** `todo` third outcome',
    '',
    '## Design',
    '',
    '### Bar-to-work map for this plan',
    '',
    '| BAR | Items | Evidence plane |',
    '|---|---|---|',
    ...mapRows,
    '',
    '### Other design notes',
    '',
    '| R-2 | not a map row: outside the map table |',
    '',
    '## Decisions',
    '',
  ].join('\n');
  const records = [
    '**R-1 — Complete export.**',
    '```requirement',
    JSON.stringify(sections),
    '```',
    '',
    '**R-2 — Dropped outcome.** Only dropped work discharged this.',
    'A second line of the same record.',
    '',
    '**R-3 — Third outcome.** The third outcome holds.',
    '',
  ];
  const rows = ['| R-1 | P-001 | tree |', '| R-2 | P-002 | tree |', '| R-3 | P-003 | tree |'];
  const source = retirementPlan(records, rows);
  const keys = (content: string) => {
    const parsed = parseRequirementBars(content);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
    return new Set(parsed.bars.map((bar) => bar.barKey));
  };

  it('removes exactly the retiring record and map row; every other byte survives and the result parses', () => {
    const result = retireRequirementBarsFromSource(source, ['R-2']);
    expect(result).toMatchObject({ ok: true, retired: ['R-2'], removedMapRows: ['R-2'] });
    if (!result.ok) return;
    // R-2's span is its header, its second line and its trailing blank line (records[5..7]):
    // everything up to the next R-looking record, as parseRequirementBars reads it.
    const expected = retirementPlan(
      [...records.slice(0, 5), ...records.slice(8)],
      rows.filter((row) => !row.startsWith('| R-2')),
    );
    expect(result.content).toBe(expected);
    // The survivor-preservation half of the contract: the dropped item, intro prose and the
    // look-alike row outside the map table are untouched.
    expect(result.content).toContain('- **P-002** `dropped` second outcome');
    expect(result.content).toContain('Intro prose stays.');
    expect(result.content).toContain('| R-2 | not a map row: outside the map table |');
    expect([...keys(result.content)]).toEqual(['R-1', 'R-3']);
    expect(parseBarMappings(result.content, keys(result.content)).ok).toBe(true);
  });

  it('CONTROL: without the retirement the dropped-only R-2 is still refused, so the derivation is what admits it', () => {
    const unchanged = retireRequirementBarsFromSource(source, []);
    expect(unchanged).toEqual({ ok: true, content: source, retired: [], removedMapRows: [] });
    const mappings = parseBarMappings(source, keys(source));
    expect(mappings.ok).toBe(false);
    if (!mappings.ok) expect(mappings.problems.map((problem) => problem.code)).toEqual(['bar_mapping_dropped_only']);
    // Retiring a DIFFERENT BAR leaves the dropped-only survivor refused.
    const other = retireRequirementBarsFromSource(source, ['R-3']);
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    const after = parseBarMappings(other.content, keys(other.content));
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.problems.map((problem) => `${problem.code}:${problem.barKey}`)).toEqual(['bar_mapping_dropped_only:R-2']);
  });

  it('removes an explicit ```requirement record including its whole fence', () => {
    const result = retireRequirementBarsFromSource(source, ['R-1']);
    expect(result).toMatchObject({ ok: true, retired: ['R-1'], removedMapRows: ['R-1'] });
    if (!result.ok) return;
    expect(result.content).not.toContain('```requirement');
    expect(result.content).not.toContain(JSON.stringify(sections));
    expect(result.content).toContain('**R-2 — Dropped outcome.**');
  });

  it('refuses a duplicated retiring record or map row with a bounded, actionable problem', () => {
    const duplicateRecord = retireRequirementBarsFromSource(
      retirementPlan([...records, '**R-2 — Dropped outcome again.** A copy.', ''], rows),
      ['R-2'],
    );
    expect(duplicateRecord).toEqual({
      ok: false,
      problems: [{
        code: 'retiring_bar_record_duplicate',
        barKey: 'R-2',
        detail: 'R-2 has 2 Requirements records; retire it only after removing the duplicate',
      }],
    });
    const duplicateRow = retireRequirementBarsFromSource(retirementPlan(records, [...rows, '| `R-2` | P-002 | tree |']), ['R-2']);
    expect(duplicateRow.ok).toBe(false);
    if (!duplicateRow.ok) {
      expect(duplicateRow.problems.map((problem) => problem.code)).toEqual(['retiring_bar_map_row_duplicate']);
      expect(duplicateRow.problems[0]!.detail.length).toBeLessThan(200);
    }
  });

  it('leaves a BAR already removed from the plan alone, and keeps a stale row for the parse to refuse', () => {
    const removedFirst = retirementPlan(records.slice(0, 5).concat(records.slice(8)), rows.filter((row) => !row.startsWith('| R-2')));
    expect(retireRequirementBarsFromSource(removedFirst, ['R-2'])).toEqual({
      ok: true, content: removedFirst, retired: [], removedMapRows: [],
    });
    const staleRow = retirementPlan(records.slice(0, 5).concat(records.slice(8)), rows);
    const result = retireRequirementBarsFromSource(staleRow, ['R-2']);
    expect(result).toEqual({ ok: true, content: staleRow, retired: [], removedMapRows: [] });
    const mappings = parseBarMappings(staleRow, keys(staleRow));
    expect(mappings.ok).toBe(false);
    if (!mappings.ok) expect(mappings.problems.map((problem) => problem.code)).toContain('bar_mapping_requirement_missing');
  });

  it('fingerprints only the Requirements body and the map table', () => {
    const base = acceptanceBarSourceFingerprint(source);
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    expect(acceptanceBarSourceFingerprint(`${source}\n### D-001 — A later Decision\nDate: 2026-10-21\n`)).toBe(base);
    expect(acceptanceBarSourceFingerprint(source.replace('| R-3 | P-003 | tree |', '| R-3 | P-001 | tree |'))).not.toBe(base);
    expect(acceptanceBarSourceFingerprint(source.replace('The third outcome holds.', 'The third outcome changed.'))).not.toBe(base);
    const retired = retireRequirementBarsFromSource(source, ['R-2']);
    expect(retired.ok && acceptanceBarSourceFingerprint(retired.content)).not.toBe(base);
  });

  // EI-24358433996857425 Part B (acceptance-bar-atomic-retirement-2026-10-15 R-6/R-8/R-28).
  describe('applyBarMappingDelta', () => {
    const move = (barKey: string, prior: string[], next: string[], plane: 'tree' | 'deployed' | 'live' = 'tree') => ({
      barKey,
      prior: { planItemIds: prior, evidencePlane: plane },
      next: { planItemIds: next, evidencePlane: plane },
    });

    it('R-6: rewrites exactly the moved row from its locked prior; every other byte survives and the result parses', () => {
      const result = applyBarMappingDelta(source, [move('R-2', ['P-002'], ['P-001', 'P-003'])]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.content).toBe(source.replace('| R-2 | P-002 | tree |', '| R-2 | P-001, P-003 | tree |'));
      // The look-alike row outside the map table is not a map row and is never moved.
      expect(result.content).toContain('| R-2 | not a map row: outside the map table |');
      expect(result.applied).toEqual([move('R-2', ['P-002'], ['P-001', 'P-003'])]);
      // Moving R-2 off its dropped-only item is the other repair for that state: the result parses.
      expect(parseBarMappings(result.content, keys(result.content)).ok).toBe(true);
      expect(acceptanceBarSourceFingerprint(result.content)).not.toBe(acceptanceBarSourceFingerprint(source));
    });

    it('R-6: composes with a retirement in one derivation over the same locked baseline', () => {
      const retired = retireRequirementBarsFromSource(source, ['R-1']);
      expect(retired.ok).toBe(true);
      if (!retired.ok) return;
      const moved = applyBarMappingDelta(retired.content, [move('R-2', ['P-002'], ['P-003'])]);
      expect(moved.ok).toBe(true);
      if (!moved.ok) return;
      expect(moved.content).not.toContain('| R-1 | P-001 | tree |');
      expect(moved.content).toContain('| R-2 | P-003 | tree |');
      expect([...keys(moved.content)]).toEqual(['R-2', 'R-3']);
      expect(parseBarMappings(moved.content, keys(moved.content)).ok).toBe(true);
    });

    it('R-6 COUNTER: a prior that is not the locked row refuses, naming both sides', () => {
      const result = applyBarMappingDelta(source, [move('R-3', ['P-001'], ['P-002'])]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problems).toEqual([{
        code: 'mapping_delta_prior_mismatch',
        barKey: 'R-3',
        detail: 'R-3 delta prior is P-001 (tree), but the locked row is P-003 (tree); re-derive the delta from the current map',
      }]);
      // A plane mismatch is a different map identity too.
      const plane = applyBarMappingDelta(source, [move('R-3', ['P-003'], ['P-001'], 'live')]);
      expect(plane.ok || plane.problems.map((problem) => problem.code)).toEqual(['mapping_delta_prior_mismatch']);
    });

    it('refuses a no-op, a duplicate, a missing or duplicated row, and malformed ids, with bounded details', () => {
      const cases: Array<[Parameters<typeof applyBarMappingDelta>[1], string, string]> = [
        [[move('R-1', ['P-001'], ['P-001'])], 'mapping_delta_noop', source],
        [[move('R-1', ['P-001'], ['P-003']), move('R-1', ['P-001'], ['P-002'])], 'mapping_delta_duplicate', source],
        [[move('R-9', ['P-001'], ['P-003'])], 'mapping_delta_row_missing', source],
        [[move('R-3', ['P-003'], ['P-001'])], 'mapping_delta_row_duplicate', retirementPlan(records, [...rows, '| `R-3` | P-003 | tree |'])],
        [[move('R-1', ['P-1'], ['P-003'])], 'mapping_delta_invalid', source],
        [[move('R-1', ['P-001'], [])], 'mapping_delta_invalid', source],
      ];
      for (const [delta, code, content] of cases) {
        const result = applyBarMappingDelta(content, delta);
        expect(result.ok, code).toBe(false);
        if (result.ok) continue;
        expect(result.problems.map((problem) => problem.code)).toContain(code);
        for (const problem of result.problems) expect(problem.detail.length).toBeLessThan(240);
      }
    });

    it('normalizes order so the approval, idempotency key and request hash compare one canonical delta', () => {
      const a = [move('R-10', ['P-003', 'P-001'], ['P-002']), move('R-2', ['P-002'], ['P-010', 'P-003', 'P-003'])];
      const b = [move('R-2', ['P-002'], ['P-003', 'P-010']), move('R-10', ['P-001', 'P-003'], ['P-002'])];
      expect(normalizeBarMappingDelta(a)).toEqual(normalizeBarMappingDelta(b));
      expect(normalizeBarMappingDelta(a).map((entry) => entry.barKey)).toEqual(['R-2', 'R-10']);
      expect(normalizeBarMappingDelta(a)[0]!.next.planItemIds).toEqual(['P-003', 'P-010']);
      expect(barMappingDeltaHash(a)).toBe(barMappingDeltaHash(b));
      // R-28: another map is another identity.
      expect(barMappingDeltaHash([move('R-2', ['P-002'], ['P-003'])])).not.toBe(barMappingDeltaHash([move('R-2', ['P-002'], ['P-001'])]));
    });

    it('an empty delta is the identity derivation', () => {
      expect(applyBarMappingDelta(source, [])).toEqual({ ok: true, content: source, applied: [] });
    });
  });
});
