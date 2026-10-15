/**
 * R-22 (spec-driven-tooling-integration-2026-10-05 P-031): the retro-fit conformance report
 * returns an unenforced-requirement count for EVERY active plan. Falsifier: an active plan
 * with requirements is missing from the report.
 */
import { describe, expect, it } from 'vitest';
import {
  buildConformanceReport,
  conformanceReportRow,
  renderConformanceReportMarkdown,
  type ConformanceReportPlanInput,
} from './conformance-report';

const TESTS_CHECK = { kind: 'tests', files: ['packages/operator-core/lib/spec-conformance/conformance-report.test.ts'] };
const MANUAL_CHECK = { kind: 'instrument', instrumentKey: 'none' };

function requirement(key: string, title: string, check?: Record<string, unknown>): string {
  const block = {
    intent: { request: `${title} request`, sourceRefs: ['owner directive #1'] },
    acceptance: {
      condition: `${title} holds.`,
      falsifier: `${title} does not hold.`,
      ...(check && check.kind === 'tests' ? { requiredTestLayers: ['unit'] } : {}),
      passRatings: ['healthy'],
    },
    verification: { method: `Check ${title}.`, ...(check ? { check } : {}) },
  };
  return `**${key} — ${title}.**\n\`\`\`requirement\n${JSON.stringify(block)}\n\`\`\``;
}

function planText(opts: { requirements?: string[]; conformance?: unknown }): string {
  const requirements = opts.requirements ? `## Requirements\n\n${opts.requirements.join('\n\n')}\n\n` : '';
  const conformance =
    opts.conformance === undefined ? '' : `## Conformance\n\n\`\`\`conformance\n${JSON.stringify(opts.conformance)}\n\`\`\`\n\n`;
  return `---\ntitle: Fixture\nslug: fixture\nstatus: active\n---\n\n${requirements}${conformance}## Phase 1\n\n- **P-001** \`todo\` Build it.\n\n## Decisions\n`;
}

const pendingFalsifier = {
  id: 'silent-drift',
  failureMode: 'the behaviour drifts with nothing noticing',
  stage: 'operation',
  pendingBinding: { observation: 'a drift observation', bindWhen: 'the probe lands' },
};

const plan = (planSlug: string, status: string, content: string, harnessSlug = 'papercusp'): ConformanceReportPlanInput => ({
  planSlug,
  harnessSlug,
  status,
  content,
});

// R-1 executable (runnable tests check); R-2 falsified (manual check + a contract falsifier);
// R-3 unenforced (manual check, nothing else).
const MIXED = planText({
  requirements: [
    requirement('R-1', 'Runnable', TESTS_CHECK),
    requirement('R-2', 'Falsified', MANUAL_CHECK),
    requirement('R-3', 'Unguarded', MANUAL_CHECK),
  ],
  conformance: { requirements: { 'R-2': { violatedWhen: [pendingFalsifier] } } },
});
const ALL_ENFORCED = planText({ requirements: [requirement('R-1', 'Runnable', TESTS_CHECK)] });
const NO_REQUIREMENTS = planText({});

describe('conformance report row (R-22)', () => {
  it('counts enforcement per requirement and names the unenforced keys', () => {
    const row = conformanceReportRow(plan('mixed', 'active', MIXED));
    expect(row.applicable).toBe(true);
    expect(row.requirements).toBe(3);
    expect(row.counts).toEqual({ executable: 1, falsified: 1, 'declared-unenforced': 0, unenforced: 1 });
    expect(row.unenforced).toEqual(['R-3']);
    expect(row.pendingFalsifiers).toBe(1);
  });

  it('lists a plan without requirements as not applicable instead of dropping it', () => {
    const row = conformanceReportRow(plan('bare', 'active', NO_REQUIREMENTS));
    expect(row.applicable).toBe(false);
    expect(row.requirements).toBe(0);
    expect(row.unenforced).toEqual([]);
    expect(row.error).toBeUndefined();
  });
});

describe('conformance report census (R-22)', () => {
  const population = [
    plan('mixed', 'active', MIXED),
    plan('clean', 'ready', ALL_ENFORCED),
    plan('bare', 'active', NO_REQUIREMENTS),
    plan('other-hive', 'Active', MIXED, 'sidestage'),
    plan('done-plan', 'shipped', MIXED),
    plan('idea', 'draft', MIXED),
  ];

  it('covers EVERY active/ready plan — none missing, including requirement-less ones', () => {
    const report = buildConformanceReport(population, { now: () => '2026-10-14T00:00:00.000Z' });
    const covered = report.plans.map((row) => `${row.harnessSlug}/${row.planSlug}`).sort();
    expect(covered).toEqual(['papercusp/bare', 'papercusp/clean', 'papercusp/mixed', 'sidestage/other-hive']);
    // Every covered plan carries an unenforced count (the R-22 acceptance condition).
    for (const row of report.plans) expect(typeof row.counts.unenforced).toBe('number');
  });

  it('excludes statuses outside the population and honours an explicit status set', () => {
    const shipped = buildConformanceReport(population, { statuses: ['shipped'] });
    expect(shipped.plans.map((row) => row.planSlug)).toEqual(['done-plan']);
  });

  it('totals the census and orders the worst plans first', () => {
    const report = buildConformanceReport(population);
    expect(report.totals).toMatchObject({
      plans: 4,
      applicable: 3,
      notApplicable: 1,
      errored: 0,
      requirements: 7,
      unenforced: 2,
      plansWithUnenforced: 2,
    });
    expect(report.plans.slice(0, 2).every((row) => row.unenforced.length === 1)).toBe(true);
    expect(report.plans.at(-1)?.unenforced).toEqual([]);
  });

  it('NEGATIVE CONTROL: a population the report would drop is detected by the coverage assertion', () => {
    // If the census silently filtered requirement-less plans, the coverage list above would
    // shrink — prove the comparison is sensitive by showing the filtered variant differs.
    const report = buildConformanceReport(population);
    const applicableOnly = report.plans.filter((row) => row.applicable).map((row) => row.planSlug);
    expect(applicableOnly).not.toContain('bare');
    expect(report.plans.map((row) => row.planSlug)).toContain('bare');
  });

  it('renders a Markdown table with one row per covered plan', () => {
    const report = buildConformanceReport(population);
    const md = renderConformanceReportMarkdown(report);
    expect(md).toContain('# Spec-conformance retro-fit report');
    for (const row of report.plans) expect(md).toContain(`\`${row.planSlug}\``);
    expect(md).toContain('| R-3 |');
    expect(md).toContain('(no parseable requirements)');
  });
});
