import { describe, expect, it } from 'vitest';
import {
  compileFootprint,
  normalizeRepoPath,
  outOfPlanConditionKey,
  reconcilePlanFootprint,
  type FootprintCommit,
  type FootprintDeps,
  type OutOfPlanFiling,
  type PlanFootprintCoverage,
} from './footprint';

const SLUG = 'footprint-fixture-plan';
const HARNESS = 'papercusp';
const DRIVER = 'su-driver';
const FOOTPRINT = ['packages/operator-core/lib/spec-conformance/**', 'packages/operator-core/lib/agent-tools/plans/conformance.ts'];

function plan(conformance?: unknown | string): string {
  const section =
    conformance === undefined
      ? ''
      : typeof conformance === 'string'
        ? `## Conformance\n\n${conformance}\n`
        : `## Conformance\n\n\`\`\`conformance\n${JSON.stringify(conformance)}\n\`\`\`\n`;
  return `# Fixture plan\n\n## Requirements\n\n(none needed for footprint reconciliation)\n\n${section}`;
}

interface Finding {
  id: string;
  conditionKey: string;
  assignee: string | null;
  uncovered: OutOfPlanFiling['uncovered'];
  open: boolean;
}

function world(opts: { commits?: FootprintCommit[]; coverage?: Partial<PlanFootprintCoverage>; headSha?: string | null } = {}) {
  const findings: Finding[] = [];
  const calls = { listCommitsSince: [] as Array<string | null>, readPlanCoverage: 0, resolvePlanDriver: 0 };
  let nextId = 1;
  const state = {
    commits: opts.commits ?? [],
    coverage: { filesChanged: [], heldLocks: [], ...opts.coverage } as PlanFootprintCoverage,
    headSha: opts.headSha === undefined ? 'head-sha-2' : opts.headSha,
  };
  const deps: FootprintDeps = {
    async listCommitsSince(sinceSha) {
      calls.listCommitsSince.push(sinceSha);
      return { headSha: state.headSha, commits: state.commits };
    },
    async readPlanCoverage() {
      calls.readPlanCoverage += 1;
      return state.coverage;
    },
    async resolvePlanDriver() {
      calls.resolvePlanDriver += 1;
      return DRIVER;
    },
    async upsertOutOfPlanFinding(filing) {
      const incumbent = findings.find((f) => f.open && f.conditionKey === filing.conditionKey);
      if (incumbent) {
        incumbent.uncovered = filing.uncovered;
        return { id: incumbent.id, created: false };
      }
      const finding: Finding = { id: `EI-FINDING-${nextId++}`, conditionKey: filing.conditionKey, assignee: filing.assignee, uncovered: filing.uncovered, open: true };
      findings.push(finding);
      return { id: finding.id, created: true };
    },
  };
  return {
    state,
    calls,
    findings,
    run: (planContent = plan({ footprint: { paths: FOOTPRINT } }), sinceSha: string | null = 'base-sha-1') =>
      reconcilePlanFootprint({ planSlug: SLUG, harnessSlug: HARNESS, planContent, sinceSha }, deps),
  };
}

const IN_FOOTPRINT = 'packages/operator-core/lib/spec-conformance/conformance-run.ts';
const IN_FOOTPRINT_2 = 'packages/operator-core/lib/agent-tools/plans/conformance.ts';
const OUTSIDE = 'packages/operator-core/lib/coord/condition-upsert.ts';

describe('reconcilePlanFootprint — out-of-plan footprint changes are flagged (R-5)', () => {
  it('records an out-of-plan finding, assigned to the plan driver, for a footprint path no plan-linked work-item covers', async () => {
    const w = world({ commits: [{ sha: 'c1', paths: [IN_FOOTPRINT, OUTSIDE] }] });
    const outcome = await w.run();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.uncovered).toEqual([{ path: IN_FOOTPRINT, commits: ['c1'] }]);
    expect(outcome.finding).toEqual({ action: 'opened', id: 'EI-FINDING-1' });
    expect(w.findings).toHaveLength(1);
    expect(w.findings[0]).toMatchObject({
      conditionKey: outOfPlanConditionKey(HARNESS, SLUG),
      assignee: DRIVER,
      uncovered: [{ path: IN_FOOTPRINT, commits: ['c1'] }],
    });
  });

  it('treats a path named in a plan-linked completion filesChanged as covered', async () => {
    const w = world({
      commits: [{ sha: 'c1', paths: [IN_FOOTPRINT] }],
      coverage: { filesChanged: [{ workItemId: 'WI-1', paths: [IN_FOOTPRINT] }] },
    });
    const outcome = await w.run();
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.uncovered).toEqual([]);
    expect(outcome.covered).toEqual([{ path: IN_FOOTPRINT, by: { kind: 'filesChanged', workItemId: 'WI-1' } }]);
    expect(outcome.finding).toEqual({ action: 'none', id: null });
    expect(w.findings).toEqual([]);
  });

  it('treats a path locked by a holder of a plan-linked work-item as covered', async () => {
    const w = world({
      commits: [{ sha: 'c1', paths: [IN_FOOTPRINT_2] }],
      coverage: { heldLocks: [{ path: IN_FOOTPRINT_2, ownerId: 'su-holder', workItemId: 'WI-2' }] },
    });
    const outcome = await w.run();
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.uncovered).toEqual([]);
    expect(outcome.covered).toEqual([{ path: IN_FOOTPRINT_2, by: { kind: 'lock', workItemId: 'WI-2', ownerId: 'su-holder' } }]);
    expect(w.findings).toEqual([]);
  });

  it('flags only the uncovered subset when some footprint paths are covered', async () => {
    const w = world({
      commits: [
        { sha: 'c1', paths: [IN_FOOTPRINT] },
        { sha: 'c2', paths: [IN_FOOTPRINT_2, IN_FOOTPRINT] },
      ],
      coverage: { filesChanged: [{ workItemId: 'WI-1', paths: [IN_FOOTPRINT_2] }] },
    });
    const outcome = await w.run();
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.uncovered).toEqual([{ path: IN_FOOTPRINT, commits: ['c1', 'c2'] }]);
    expect(outcome.covered.map((c) => c.path)).toEqual([IN_FOOTPRINT_2]);
  });

  it('ignores paths outside the footprint and reads no coverage when nothing in the footprint changed', async () => {
    const w = world({ commits: [{ sha: 'c1', paths: [OUTSIDE, 'README.md'] }] });
    const outcome = await w.run();
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.uncovered).toEqual([]);
    expect(outcome.covered).toEqual([]);
    expect(w.calls.readPlanCoverage).toBe(0);
    expect(w.findings).toEqual([]);
  });

  it('keeps ONE finding per plan across repeated reconciliations, refreshing its paths', async () => {
    const w = world({ commits: [{ sha: 'c1', paths: [IN_FOOTPRINT] }] });
    const first = await w.run();
    w.state.commits = [{ sha: 'c3', paths: [IN_FOOTPRINT_2] }];
    const second = await w.run(undefined, 'head-sha-2');
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(first.finding.action).toBe('opened');
    expect(second.finding).toEqual({ action: 'refreshed', id: first.finding.id });
    expect(w.findings).toHaveLength(1);
    expect(w.findings[0]!.uncovered).toEqual([{ path: IN_FOOTPRINT_2, commits: ['c3'] }]);
  });

  it('reconciles from the watermark it is given and returns the head as the next watermark', async () => {
    const w = world({ commits: [], headSha: 'head-sha-9' });
    const outcome = await w.run(undefined, 'base-sha-7');
    if (!outcome.ok) throw new Error('expected ok');
    expect(w.calls.listCommitsSince).toEqual(['base-sha-7']);
    expect(outcome).toMatchObject({ declared: true, sinceSha: 'base-sha-7', headSha: 'head-sha-9', commitsScanned: 0 });
  });

  it('reconciles nothing for a plan that declares no footprint', async () => {
    const w = world({ commits: [{ sha: 'c1', paths: [IN_FOOTPRINT] }] });
    const noContract = await w.run(plan());
    const noFootprint = await w.run(plan({ requirements: {} }));
    for (const outcome of [noContract, noFootprint]) {
      if (!outcome.ok) throw new Error('expected ok');
      expect(outcome).toMatchObject({ declared: false, uncovered: [], finding: { action: 'none', id: null } });
    }
    expect(w.calls.listCommitsSince).toEqual([]);
    expect(w.findings).toEqual([]);
  });

  it('refuses a malformed contract rather than reconciling part of it', async () => {
    const w = world({ commits: [{ sha: 'c1', paths: [IN_FOOTPRINT] }] });
    const outcome = await w.run(plan('```conformance\n{not json\n```'));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problems[0]!.code).toBe('conformance_contract_invalid');
    expect(w.calls.listCommitsSince).toEqual([]);
    expect(w.findings).toEqual([]);
  });
});

describe('footprint path matching', () => {
  it('normalizes ./-prefixed and backslash paths before matching globs', () => {
    expect(normalizeRepoPath('./packages\\operator-core//lib/x.ts')).toBe('packages/operator-core/lib/x.ts');
    const inFootprint = compileFootprint(FOOTPRINT);
    expect(inFootprint(`./${IN_FOOTPRINT}`)).toBe(true);
    expect(inFootprint('packages/operator-core/lib/spec-conformance/nested/deep/file.ts')).toBe(true);
    expect(inFootprint(IN_FOOTPRINT_2)).toBe(true);
    expect(inFootprint(OUTSIDE)).toBe(false);
  });
});
