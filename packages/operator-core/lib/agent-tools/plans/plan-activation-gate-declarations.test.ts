/**
 * The lifecycle-door activation gate re-checks the reuse and libraries declaration
 * sections on the plan's CURRENT content (plan-reuse-and-library-declarations-2026-10-20
 * R-3, D-013 #1). A recorded activation audit is not enough: a section removed or
 * broken after the audit refuses at plans:start and at a draft→ready/active write.
 *
 * Same tagged-template `tx` stub as plan-activation-gate-item-provenance.test.ts: each
 * test states exactly what the audit recorded and what the stored plan holds.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  activationGateRefusalValue,
  evaluateConversationActivationGate,
  isActivationGateRefusalValue,
} from './plan-activation-gate';

const SCOPE = { workspaceId: 'ws', harnessSlug: 'papercusp', planSlug: 'plan-a' } as const;

const REUSE =
  '\n## Existing infrastructure reused\n\n```reuse\n' +
  '{"searched":[],"reused":[],"newSurfaces":[],"notApplicable":"Prose-only plan; no code surface."}\n```\n';
const LIBRARIES =
  '\n## Third-party libraries\n\n```libraries\n{"needs":[],"notApplicable":"No library could do this."}\n```\n';

const plan = (status: string | null, sections: string) =>
  `---\ntitle: Plan A\nslug: plan-a\n${status === null ? '' : `status: ${status}\n`}created: 2026-10-20\n` +
  `updated: 2026-10-20\nowner: test\n---\n\n## Items\n\n- **P-001** \`todo\` Do the thing.\n${sections}`;

function txFor(rows: { activation?: unknown; auditSeq?: number; content: string }) {
  const calls: string[] = [];
  const tx = (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    calls.push(text);
    if (text.includes('harness_shared.plan_audits')) {
      return Promise.resolve(
        rows.activation === undefined ? [] : [{ audit_seq: rows.auditSeq ?? 3, activation: rows.activation }],
      );
    }
    if (text.includes('harness_shared.harness_plans')) return Promise.resolve([{ content: rows.content }]);
    return Promise.reject(new Error(`unexpected query: ${text.slice(0, 80)}`));
  };
  return { tx, calls };
}

/** An activation audit recorded while the declaration gate applied (audit.ts writes this). */
const gatedAudit = {
  sourceRanges: [],
  mappings: [],
  declarationsCheck: { enforced: true, reuse: 'not-applicable', libraries: 'not-applicable' },
};

describe('evaluateConversationActivationGate — declarations re-check (R-3, D-013 #1)', () => {
  it('passes a ready plan whose current content still carries both sections', async () => {
    const { tx } = txFor({ activation: gatedAudit, content: plan('ready', REUSE + LIBRARIES) });

    await expect(evaluateConversationActivationGate(tx as never, SCOPE)).resolves.toEqual({ satisfied: true, auditSeq: 3 });
  });

  it('R-3: plans:start refuses after a recorded audit when a section is later removed', async () => {
    const { tx } = txFor({ activation: gatedAudit, auditSeq: 9, content: plan('ready', LIBRARIES) });

    const verdict = await evaluateConversationActivationGate(tx as never, SCOPE);

    expect(verdict).toMatchObject({
      satisfied: false,
      code: 'plan_declarations_invalid',
      auditSeq: 9,
      declarationBlockers: [{ code: 'plan_declarations_invalid', section: 'Existing infrastructure reused', status: 'missing' }],
    });
    expect(verdict.declarationBlockers).toHaveLength(1);
    expect(verdict.message).toContain('#9');
    expect(verdict.message).toContain('Existing infrastructure reused');

    const refusal = activationGateRefusalValue('plan-a', verdict);
    expect(refusal).toMatchObject({ ok: false, code: 'plan_declarations_invalid', declarationBlockers: verdict.declarationBlockers });
    expect(isActivationGateRefusalValue(refusal)).toBe(true);
  });

  it('refuses a section whose JSON was broken after the audit, naming the field', async () => {
    const broken = '\n## Third-party libraries\n\n```libraries\n{"needs":[{"need":""}],"notApplicable":null}\n```\n';
    const { tx } = txFor({ activation: gatedAudit, content: plan('ready', REUSE + broken) });

    const verdict = await evaluateConversationActivationGate(tx as never, SCOPE);

    expect(verdict).toMatchObject({ satisfied: false, code: 'plan_declarations_invalid' });
    expect(verdict.declarationBlockers?.[0]).toMatchObject({ section: 'Third-party libraries', status: 'invalid' });
    expect(verdict.declarationBlockers?.[0]?.detail).toMatch(/needs\.0/);
  });

  it('judges the pending write body, gated by the STORED status, so draft→active cannot drop a section', async () => {
    const { tx } = txFor({ activation: gatedAudit, content: plan('draft', REUSE + LIBRARIES) });

    const verdict = await evaluateConversationActivationGate(tx as never, {
      ...SCOPE,
      pendingContent: plan('active', LIBRARIES),
    });

    expect(verdict).toMatchObject({ satisfied: false, code: 'plan_declarations_invalid' });
  });

  it('fails closed for a plan with no status', async () => {
    const { tx } = txFor({ activation: gatedAudit, content: plan(null, LIBRARIES) });

    await expect(evaluateConversationActivationGate(tx as never, SCOPE)).resolves.toMatchObject({
      satisfied: false,
      code: 'plan_declarations_invalid',
    });
  });

  it('does not retrofit a plan that is already active', async () => {
    const { tx } = txFor({ activation: gatedAudit, content: plan('active', '') });

    await expect(evaluateConversationActivationGate(tx as never, SCOPE)).resolves.toEqual({ satisfied: true, auditSeq: 3 });
  });

  // EI-26528805324626265: an audit recorded before the gate no longer waves a draft or
  // ready plan through. The door judges the plan's status and current content, not the
  // audit row's age (D-013 #1; D-004 #1 retrofits by status).
  const legacyAudit = { sourceRanges: [], mappings: [] };

  it('R-3: refuses a ready plan with no sections even when its audit predates the gate', async () => {
    const { tx, calls } = txFor({ activation: legacyAudit, auditSeq: 4, content: plan('ready', '') });

    const verdict = await evaluateConversationActivationGate(tx as never, SCOPE);

    expect(verdict).toMatchObject({ satisfied: false, code: 'plan_declarations_invalid', auditSeq: 4 });
    expect(verdict.declarationBlockers?.map((blocker) => blocker.section)).toEqual([
      'Existing infrastructure reused',
      'Third-party libraries',
    ]);
    expect(verdict.message).toContain('activation audit #4 predates the declaration gate');
    expect(verdict.message).not.toContain('passed activation audit');
    expect(calls.filter((text) => text.includes('harness_plans'))).toHaveLength(1);
  });

  it('R-3: refuses a draft plan with no sections when its audit predates the gate', async () => {
    const { tx } = txFor({ activation: legacyAudit, content: plan('draft', REUSE) });

    await expect(evaluateConversationActivationGate(tx as never, SCOPE)).resolves.toMatchObject({
      satisfied: false,
      code: 'plan_declarations_invalid',
      declarationBlockers: [{ section: 'Third-party libraries', status: 'missing' }],
    });
  });

  it('passes a legacy-audited ready plan whose current content carries both sections', async () => {
    const { tx } = txFor({ activation: legacyAudit, content: plan('ready', REUSE + LIBRARIES) });

    await expect(evaluateConversationActivationGate(tx as never, SCOPE)).resolves.toEqual({ satisfied: true, auditSeq: 3 });
  });

  it('does not retrofit an active plan whose audit predates the gate', async () => {
    const { tx } = txFor({ activation: legacyAudit, content: plan('active', '') });

    await expect(evaluateConversationActivationGate(tx as never, SCOPE)).resolves.toEqual({ satisfied: true, auditSeq: 3 });
  });

  it('R-3: a ready plan with no activation audit is grandfathered for the audit, not for the sections', async () => {
    const { tx } = txFor({ content: plan('ready', '') });

    const verdict = await evaluateConversationActivationGate(tx as never, SCOPE);

    expect(verdict).toMatchObject({ satisfied: false, code: 'plan_declarations_invalid' });
    expect(verdict).not.toHaveProperty('auditSeq');
    expect(verdict.message).toContain('it has no activation audit');
  });

  it('keeps grandfathering an active plan with no activation audit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tx } = txFor({ content: plan('active', '') });

    await expect(evaluateConversationActivationGate(tx as never, SCOPE)).resolves.toMatchObject({
      satisfied: true,
      grandfathered: true,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('grandfathered'));
    warn.mockRestore();
  });

  it('a ready plan with no audit but both sections keeps the audit grandfathering', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tx } = txFor({ content: plan('ready', REUSE + LIBRARIES) });

    await expect(evaluateConversationActivationGate(tx as never, SCOPE)).resolves.toMatchObject({
      satisfied: true,
      grandfathered: true,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('grandfathered'));
    warn.mockRestore();
  });

  it('reads a declarationsCheck stored as a JSON string', async () => {
    const { tx } = txFor({ activation: JSON.stringify(gatedAudit), content: plan('ready', '') });

    await expect(evaluateConversationActivationGate(tx as never, SCOPE)).resolves.toMatchObject({
      satisfied: false,
      code: 'plan_declarations_invalid',
    });
  });
});
