/**
 * PIN: every clause of the GOAL-mode contract maps to the goal-mode-e2e criteria that
 * enforce it, and any edit to a clause forces that mapping (and the rubric) to be
 * re-reviewed (WI-10005180, owner directives #1240/#1241).
 *
 * The failure this guards: goal-mode-e2e graded the goal holder "pass" on planning while
 * the contract's default route (rule 1, "NOT IN A PLAN YET → plans:new") had no criterion
 * whose method could fail it, and the drain-fence and spend clauses were revised in the
 * contract after the rubric was written. Section-level coverage could not see either.
 *
 * When this test fails because the contract changed: re-read the changed clause, check the
 * criteria it maps to still enforce it (revise goal-mode-e2e with rubrics:propose if not),
 * then update the clause's sha256 / criteria here and bump rubricRevision/attestedAt.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { segmentGoalContract } from './goal-contract-clauses';
import manifest from './goal-contract-rubric-coverage.json';

const REPO_ROOT = resolve(__dirname, '../../../..');
const contractPath = process.env.GOAL_CONTRACT_PATH ?? resolve(REPO_ROOT, manifest.contract);

interface ManifestClause {
  id: string;
  sha256: string;
  criteria?: string[];
  informational?: string;
}

const clauses = manifest.clauses as ManifestClause[];
const rubricKeys = new Set(manifest.rubricKeys);

describe('goal contract → goal-mode-e2e coverage pin', () => {
  const live = segmentGoalContract(readFileSync(contractPath, 'utf8'));

  it('segments the contract at sub-obligation granularity (positive control)', () => {
    const ids = live.map((c) => c.id);
    // The clauses whose absence from the rubric went unnoticed must each be their own segment.
    for (const id of ['not-in-a-plan-yet', 'already-started', 'a-launch-refusal-is-scoped-to-that-one-call-never-a-verdict-', 'the-floor-is-concrete', 'spend-accounting-has', 'scope', 'corrections-preempt-the-report-cadence', 'before']) {
      expect(ids).toContain(id);
    }
    expect(live.length).toBeGreaterThanOrEqual(40);
  });

  it('every live clause is in the coverage manifest', () => {
    const known = new Set(clauses.map((c) => c.id));
    const missing = live.filter((c) => !known.has(c.id)).map((c) => `${c.id} (line ${c.line}: ${c.leadIn})`);
    expect(missing, 'new contract clause(s) with no rubric mapping — map them to goal-mode-e2e criteria').toEqual([]);
  });

  it('no manifest clause is stale', () => {
    const liveIds = new Set(live.map((c) => c.id));
    expect(clauses.filter((c) => !liveIds.has(c.id)).map((c) => c.id)).toEqual([]);
  });

  it('no clause changed since the rubric coverage was last attested', () => {
    const pinned = new Map(clauses.map((c) => [c.id, c.sha256]));
    const changed = live
      .filter((c) => pinned.has(c.id) && !c.sha256.startsWith(pinned.get(c.id) as string))
      .map((c) => `${c.id} (line ${c.line})`);
    expect(changed, 'contract clause text changed — re-check its goal-mode-e2e criteria, then re-pin').toEqual([]);
  });

  it('every clause maps to at least one real criterion or states why it is informational', () => {
    const bad = clauses.filter((c) =>
      c.informational ? c.informational.trim().length < 10 : !(c.criteria && c.criteria.length > 0 && c.criteria.every((k) => rubricKeys.has(k))),
    );
    expect(bad.map((c) => c.id)).toEqual([]);
  });

  it('every rubric criterion is reachable from some clause or is a cross-cutting measurement', () => {
    const CROSS_CUTTING = new Set(['ladder-integrity-end-to-end', 'portfolio-activity-floor', 'task-brief-effectiveness']);
    const mapped = new Set(clauses.flatMap((c) => c.criteria ?? []));
    expect([...rubricKeys].filter((k) => !mapped.has(k) && !CROSS_CUTTING.has(k))).toEqual([]);
  });

  it('a modified clause is detected (negative control on an in-memory copy)', () => {
    const text = readFileSync(contractPath, 'utf8').replace('plans:new + plans:add-item', 'plans:add-item');
    const mutated = segmentGoalContract(text).find((c) => c.id === 'not-in-a-plan-yet');
    const pinned = clauses.find((c) => c.id === 'not-in-a-plan-yet');
    expect(mutated && pinned && mutated.sha256.startsWith(pinned.sha256)).toBe(false);
  });
});
