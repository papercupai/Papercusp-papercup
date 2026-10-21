// acceptance-bar-atomic-retirement-2026-10-15 R-32 (unit layer): the maintained result budget
// for a malformed-source amendment refusal. The boundary cases in rubrics.integration.test.ts
// drive real malformed sources through preview and apply; these pin the formatter's contract.
import { describe, expect, it } from 'vitest';
import { ACCEPTANCE_BAR_AMENDMENT_REFUSAL_BUDGET as budget, amendmentSourceRefusal } from './rubrics';

const PREFIX = 'acceptance_bar_amendment_requirements_invalid';

describe('amendmentSourceRefusal — bounded, actionable malformed-source refusal', () => {
  it('names each problem as code: key: item: detail, in parser order', () => {
    expect(amendmentSourceRefusal('acceptance_bar_amendment_mapping_invalid', [
      { code: 'bar_mapping_unknown', barKey: 'R-2', planItemId: 'P-009', detail: 'R-2 maps to absent plan item P-009' },
      { code: 'bar_mapping_missing', barKey: 'R-3', detail: 'R-3 has no Bar-to-work map row' },
    ])).toBe(
      'acceptance_bar_amendment_mapping_invalid:bar_mapping_unknown: R-2: P-009: R-2 maps to absent plan item P-009; '
        + 'bar_mapping_missing: R-3: R-3 has no Bar-to-work map row',
    );
  });

  it('keeps a key-less problem actionable through its detail', () => {
    expect(amendmentSourceRefusal(PREFIX, [
      { code: 'bar_requirement_parse_failed', detail: 'malformed requirement record: **R-2 Second outcome**' },
    ])).toBe(`${PREFIX}:bar_requirement_parse_failed: malformed requirement record: **R-2 Second outcome**`);
  });

  it('flattens a multi-line parser detail onto one line and clips it to maxDetailChars', () => {
    const schemaError = `[\n  {\n    "code": "invalid_type",\n    "path": ["acceptance"],\n    "message": "${'y'.repeat(2_000)}"\n  }\n]`;
    const message = amendmentSourceRefusal(PREFIX, [{ code: 'bar_requirement_parse_failed', barKey: 'R-2', detail: schemaError }]);
    expect(message).not.toContain('\n');
    const detail = message.slice(`${PREFIX}:bar_requirement_parse_failed: R-2: `.length);
    expect(detail.length).toBe(budget.maxDetailChars);
    expect(detail.endsWith('…')).toBe(true);
    expect(detail.startsWith('[ { "code": "invalid_type",')).toBe(true);
  });

  it('shows at most maxProblems problems and counts the rest', () => {
    const problems = Array.from({ length: 50 }, (_, index) => ({
      code: 'bar_mapping_duplicate', barKey: `R-${index + 1}`, detail: `Bar-to-work map has duplicate row R-${index + 1}`,
    }));
    const message = amendmentSourceRefusal('acceptance_bar_amendment_mapping_invalid', problems);
    const parts = message.slice('acceptance_bar_amendment_mapping_invalid:'.length).split('; ');
    expect(parts.pop()).toBe(`+${50 - budget.maxProblems} more problem(s) not shown`);
    expect(parts).toHaveLength(budget.maxProblems);
    expect(parts[0]).toBe('bar_mapping_duplicate: R-1: Bar-to-work map has duplicate row R-1');
  });

  it('never exceeds maxMessageChars, whatever the problem count and detail size', () => {
    const problems = Array.from({ length: 1_000 }, (_, index) => ({
      code: `bar_${'z'.repeat(400)}`, barKey: `R-${index}`, planItemId: `P-${String(index).padStart(3, '0')}`, detail: 'w'.repeat(10_000),
    }));
    const message = amendmentSourceRefusal(PREFIX, problems);
    expect(message.length).toBeLessThanOrEqual(budget.maxMessageChars);
    expect(message.startsWith(`${PREFIX}:bar_`)).toBe(true);
  });

  it('leaves an in-budget refusal byte-identical to the unbounded format', () => {
    const problems = [{ code: 'bar_key_duplicate', barKey: 'R-2', detail: 'duplicate requirement key R-2' }];
    expect(amendmentSourceRefusal(PREFIX, problems)).toBe(
      `${PREFIX}:${problems.map((problem) => [problem.code, problem.barKey, problem.detail].join(': ')).join('; ')}`,
    );
  });
});
