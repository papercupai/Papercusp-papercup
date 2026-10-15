/**
 * acceptance-grader-select.bar-critique.test.ts — SPEC-P-007-GRADE-ELIGIBLE at the UNIT layer.
 *
 * D-004: critiquing a plan's bars is not implementing them, so the RESPONDER of a
 * bar-critique consult stays eligible to grade that plan's acceptance rubric,
 * while the REQUESTER (the plan author asking for critique) is still excluded.
 * The exclusion set is one SQL statement built by computeGraderExclusions; the
 * integration suite (acceptance-grader-select.integration.test.ts) proves the
 * behaviour against real Postgres. This file pins the statement the real
 * function issues: the responder branch filters the bar-critique policy, the
 * requester branch never does, and the filtered literal is the shared
 * BAR_CRITIQUE_POLICY constant (so a rename of the policy cannot silently turn
 * the filter into a no-op).
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { computeGraderExclusions } from './acceptance-grader-select';
import { BAR_CRITIQUE_POLICY } from './selection-policies';

function capturingSql(rows: Array<{ owner: string }>) {
  const statements: string[] = [];
  const sql = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    statements.push(strings.join('$?'));
    return rows;
  }) as unknown as Sql;
  return { sql, statements };
}

/** Split the UNION into its branches and pick the one selecting `column`. */
function branchSelecting(statement: string, column: string): string {
  const branches = statement.split(/\bUNION\b/);
  const hit = branches.filter((b) => new RegExp(`SELECT\\s+${column.replace('.', '\\.')}\\b`).test(b));
  expect(hit).toHaveLength(1);
  return hit[0];
}

describe('computeGraderExclusions bar-critique eligibility (SPEC-P-007-GRADE-ELIGIBLE, unit)', () => {
  it('SPEC-P-007-GRADE-ELIGIBLE: the responder branch excludes bar-critique consults by the shared policy literal', async () => {
    const { sql, statements } = capturingSql([]);
    await computeGraderExclusions(sql, 'ws-unit', 'plan-x');
    expect(statements).toHaveLength(1);
    const responder = branchSelecting(statements[0], 'cs.responder_id');
    expect(responder).toContain(`COALESCE(cs.routing->>'policy', '') <> '${BAR_CRITIQUE_POLICY}'`);
  });

  it('SPEC-P-007-GRADE-ELIGIBLE: the requester branch carries no policy filter, so a bar-critique requester stays excluded', async () => {
    const { sql, statements } = capturingSql([]);
    await computeGraderExclusions(sql, 'ws-unit', 'plan-x');
    const requester = branchSelecting(statements[0], 'cs.requester_id');
    expect(requester).not.toMatch(/routing->>'policy'/);
    expect(requester).not.toContain(BAR_CRITIQUE_POLICY);
  });

  it('SPEC-P-007-GRADE-ELIGIBLE: returned owners are the query rows plus explicit extras, de-duplicated', async () => {
    const { sql } = capturingSql([{ owner: 'su-requester' }, { owner: 'su-implementer' }]);
    const out = await computeGraderExclusions(sql, 'ws-unit', 'plan-x', ['su-implementer', null, 'su-shipper']);
    expect(out.sort()).toEqual(['su-implementer', 'su-requester', 'su-shipper']);
  });
});
