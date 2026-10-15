import { describe, expect, it } from 'vitest';
import { conformanceActivationVerdict } from './activation-gate';
import { evaluateRequirementEnforcement, parseConformanceContract } from './conformance-contract';

const TESTS_CHECK = { kind: 'tests', files: ['packages/operator-core/lib/spec-conformance/activation-gate.test.ts'] };
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

function plan(opts: { requirements: string[]; conformance?: unknown | string; decisions?: string }): string {
  const conformance =
    opts.conformance === undefined
      ? ''
      : typeof opts.conformance === 'string'
        ? `## Conformance\n\n${opts.conformance}\n`
        : `## Conformance\n\n\`\`\`conformance\n${JSON.stringify(opts.conformance)}\n\`\`\`\n`;
  return `---
title: Conformance fixture
slug: conformance-fixture
status: draft
created: 2026-10-14
updated: 2026-10-14
---

## Requirements

${opts.requirements.join('\n\n')}

${conformance}
## Phase 1

- **P-001** \`todo\` Build it.

## Decisions

${opts.decisions ?? ''}
`;
}

const pendingFalsifier = {
  id: 'url-only-close',
  failureMode: 'closed on a bare URL',
  stage: 'delivery',
  pendingBinding: { observation: 'a done disposition whose note is only URLs', bindWhen: 'P-021 lands' },
};

describe('spec-conformance activation gate (R-1)', () => {
  it('refuses conformance_requirement_unenforced for a manual check with no falsifier and no declaration', () => {
    const verdict = conformanceActivationVerdict(plan({ requirements: [requirement('R-1', 'Manual thing', MANUAL_CHECK)] }));
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toBe('conformance_requirement_unenforced');
    expect(verdict.problems.map((p) => p.barKey)).toEqual(['R-1']);
    expect(verdict.report.requirements[0]).toMatchObject({ doneWhen: 'manual', status: 'unenforced' });
  });

  it('refuses a requirement with no verification.check at all', () => {
    const verdict = conformanceActivationVerdict(plan({ requirements: [requirement('R-1', 'Unchecked thing')] }));
    expect(verdict.error).toBe('conformance_requirement_unenforced');
    expect(verdict.report.requirements[0]?.doneWhen).toBe('absent');
  });

  it('accepts a requirement whose done-when check is executable, with no Conformance section', () => {
    const verdict = conformanceActivationVerdict(plan({ requirements: [requirement('R-1', 'Tested thing', TESTS_CHECK)] }));
    expect(verdict).toMatchObject({ ok: true, error: null, problems: [] });
    expect(verdict.report).toMatchObject({ applicable: true, contractPresent: false });
    expect(verdict.report.counts.executable).toBe(1);
  });

  it('accepts a manual requirement carried by a pendingBinding falsifier and counts it as pending', () => {
    const verdict = conformanceActivationVerdict(plan({
      requirements: [requirement('R-1', 'Manual thing', MANUAL_CHECK)],
      conformance: { requirements: { 'R-1': { violatedWhen: [pendingFalsifier] } } },
    }));
    expect(verdict.ok).toBe(true);
    expect(verdict.report.requirements[0]).toMatchObject({ status: 'falsified' });
    expect(verdict.report.counts).toMatchObject({ falsified: 1, pendingFalsifiers: 1, boundFalsifiers: 0 });
  });

  it('accepts a runnable falsifier check and counts it as bound', () => {
    const verdict = conformanceActivationVerdict(plan({
      requirements: [requirement('R-1', 'Manual thing', MANUAL_CHECK)],
      conformance: {
        requirements: {
          'R-1': {
            violatedWhen: [
              { id: 'probe-a', failureMode: 'a', stage: 'implementation', check: TESTS_CHECK },
              { id: 'probe-b', failureMode: 'b', stage: 'operation', check: TESTS_CHECK },
            ],
          },
        },
      },
    }));
    expect(verdict.ok).toBe(true);
    expect(verdict.report.counts.boundFalsifiers).toBe(2);
  });

  it('accepts an unenforced declaration approved by a Decision of the plan', () => {
    const verdict = conformanceActivationVerdict(plan({
      requirements: [requirement('R-1', 'Manual thing', MANUAL_CHECK)],
      conformance: { requirements: { 'R-1': { unenforced: { reason: 'judgment only', approvalRef: 'D-001' } } } },
      decisions: '### D-001 — Accept R-1 as judgment-only\nDate: 2026-10-14\nApproved.',
    }));
    expect(verdict.ok).toBe(true);
    expect(verdict.report.requirements[0]?.status).toBe('declared-unenforced');
  });

  it('accepts an unenforced declaration approved by a canonical session_turn ref', () => {
    const verdict = conformanceActivationVerdict(plan({
      requirements: [requirement('R-1', 'Manual thing', MANUAL_CHECK)],
      conformance: {
        requirements: { 'R-1': { unenforced: { reason: 'judgment only', approvalRef: 'session_turn:claude:abc-123:7' } } },
      },
    }));
    expect(verdict.ok).toBe(true);
  });

  it('refuses an unenforced declaration whose approvalRef names no Decision of the plan', () => {
    const verdict = conformanceActivationVerdict(plan({
      requirements: [requirement('R-1', 'Manual thing', MANUAL_CHECK)],
      conformance: { requirements: { 'R-1': { unenforced: { reason: 'judgment only', approvalRef: 'D-009' } } } },
    }));
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toBe('conformance_unenforced_unapproved');
    expect(verdict.problems.map((p) => p.code)).toEqual([
      'conformance_unenforced_unapproved',
      'conformance_requirement_unenforced',
    ]);
  });

  it('refuses a falsifier carrying both a check and a pendingBinding', () => {
    const verdict = conformanceActivationVerdict(plan({
      requirements: [requirement('R-1', 'Tested thing', TESTS_CHECK)],
      conformance: { requirements: { 'R-1': { violatedWhen: [{ ...pendingFalsifier, check: TESTS_CHECK }] } } },
    }));
    expect(verdict.error).toBe('conformance_contract_invalid');
  });

  it('refuses a manual falsifier check', () => {
    const verdict = conformanceActivationVerdict(plan({
      requirements: [requirement('R-1', 'Tested thing', TESTS_CHECK)],
      conformance: {
        requirements: { 'R-1': { violatedWhen: [{ id: 'x', failureMode: 'x', stage: 'delivery', check: MANUAL_CHECK }] } },
      },
    }));
    expect(verdict.error).toBe('conformance_contract_invalid');
    expect(verdict.problems[0]?.detail).toMatch(/cannot be manual/);
  });

  it('refuses a contract naming a requirement that does not exist', () => {
    const verdict = conformanceActivationVerdict(plan({
      requirements: [requirement('R-1', 'Tested thing', TESTS_CHECK)],
      conformance: { requirements: { 'R-9': { violatedWhen: [pendingFalsifier] } } },
    }));
    expect(verdict.error).toBe('conformance_requirement_unknown');
  });

  it('refuses duplicate falsifier ids within one requirement', () => {
    const verdict = conformanceActivationVerdict(plan({
      requirements: [requirement('R-1', 'Manual thing', MANUAL_CHECK)],
      conformance: { requirements: { 'R-1': { violatedWhen: [pendingFalsifier, pendingFalsifier] } } },
    }));
    expect(verdict.error).toBe('conformance_falsifier_duplicate');
  });

  it('refuses a Conformance section with no conformance fence, and with invalid JSON', () => {
    expect(conformanceActivationVerdict(plan({
      requirements: [requirement('R-1', 'Tested thing', TESTS_CHECK)],
      conformance: 'Prose only, no block.',
    })).error).toBe('conformance_contract_invalid');
    expect(conformanceActivationVerdict(plan({
      requirements: [requirement('R-1', 'Tested thing', TESTS_CHECK)],
      conformance: '```conformance\n{not json\n```',
    })).error).toBe('conformance_contract_invalid');
  });

  it('reports only the unenforced requirements among several', () => {
    const verdict = conformanceActivationVerdict(plan({
      requirements: [
        requirement('R-1', 'Tested thing', TESTS_CHECK),
        requirement('R-2', 'Manual thing', MANUAL_CHECK),
        requirement('R-3', 'Other manual thing', MANUAL_CHECK),
      ],
      conformance: { requirements: { 'R-3': { violatedWhen: [pendingFalsifier] } } },
    }));
    expect(verdict.problems.map((p) => p.barKey)).toEqual(['R-2']);
    expect(verdict.message).toMatch(/R-2/);
  });

  it('is not applicable, and refuses nothing, when ## Requirements is absent', () => {
    const content = plan({ requirements: [] }).replace('## Requirements', '## Context');
    const verdict = conformanceActivationVerdict(content);
    expect(verdict).toMatchObject({ ok: true, problems: [] });
    expect(verdict.report.applicable).toBe(false);
  });

  it('reads the footprint paths', () => {
    const parsed = parseConformanceContract(plan({
      requirements: [requirement('R-1', 'Tested thing', TESTS_CHECK)],
      conformance: { footprint: { paths: ['packages/x/**'] } },
    }));
    expect(parsed).toMatchObject({ ok: true, present: true, contract: { footprint: { paths: ['packages/x/**'] } } });
    expect(evaluateRequirementEnforcement(plan({
      requirements: [requirement('R-1', 'Tested thing', TESTS_CHECK)],
      conformance: { footprint: { paths: ['packages/x/**'] } },
    })).footprint).toEqual(['packages/x/**']);
  });
});
