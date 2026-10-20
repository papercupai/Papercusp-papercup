/**
 * The lifecycle-door activation gate refuses items added after an ENFORCED activation
 * audit that the audit never resolved (plan-item-provenance-2026-09-29 P-003, R-4).
 *
 * The gate reads two rows through the transaction: the latest activation audit and
 * the current plan body. `tx` is a tagged-template stub that serves each by query
 * text, so every test states exactly what the audit resolved and what the plan holds.
 */
import { describe, expect, it } from 'vitest';
import {
  activationGateRefusalValue,
  evaluateConversationActivationGate,
  isActivationGateRefusalValue,
} from './plan-activation-gate';

const SCOPE = { workspaceId: 'ws', harnessSlug: 'papercusp', planSlug: 'plan-a' } as const;

const plan = (items: string[], status = 'active') =>
  `---\ntitle: Plan A\nslug: plan-a\nstatus: ${status}\ncreated: 2026-09-29\nupdated: 2026-09-29\nowner: test\n---\n\n## Items\n\n${items.join('\n')}\n`;

function txFor(rows: { activation?: unknown; auditSeq?: number; content: string }) {
  const calls: string[] = [];
  const tx = (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    calls.push(text);
    if (text.includes('harness_shared.plan_audits')) {
      return Promise.resolve(
        rows.activation === undefined ? [] : [{ audit_seq: rows.auditSeq ?? 2, activation: rows.activation }],
      );
    }
    if (text.includes('harness_shared.harness_plans')) return Promise.resolve([{ content: rows.content }]);
    return Promise.reject(new Error(`unexpected query: ${text.slice(0, 80)}`));
  };
  return { tx, calls };
}

const enforced = (items: Record<string, string>) => ({
  sourceRanges: [],
  mappings: [],
  itemProvenanceCheck: { enforced: true, items, unresolved: [] },
});

describe('evaluateConversationActivationGate — item provenance (R-4)', () => {
  it('passes when every current item was resolved by the enforced audit', async () => {
    const { tx } = txFor({
      activation: enforced({ 'P-001': 'owner', 'P-002': 'derived' }),
      content: plan(['- **P-001** `todo` A.', '- **P-002** `wip` B.']),
    });

    await expect(evaluateConversationActivationGate(tx as never, SCOPE)).resolves.toEqual({ satisfied: true, auditSeq: 2 });
  });

  it('refuses item_provenance_unresolved naming an item added after the enforced audit', async () => {
    const { tx } = txFor({
      activation: enforced({ 'P-001': 'owner' }),
      auditSeq: 7,
      content: plan(['- **P-001** `todo` A.', '- **P-002** `todo` Added later by an agent.']),
    });

    const verdict = await evaluateConversationActivationGate(tx as never, SCOPE);

    expect(verdict).toMatchObject({
      satisfied: false,
      code: 'item_provenance_unresolved',
      auditSeq: 7,
      unresolvedItems: ['P-002'],
    });
    expect(verdict.message).toContain('P-002');
    expect(verdict.message).toContain('#7');
  });

  it('ignores a dropped item the audit never saw', async () => {
    const { tx } = txFor({
      activation: enforced({ 'P-001': 'owner' }),
      content: plan(['- **P-001** `todo` A.', '- **P-002** `dropped` Abandoned idea.']),
    });

    await expect(evaluateConversationActivationGate(tx as never, SCOPE)).resolves.toMatchObject({ satisfied: true });
  });

  it('reads an activation payload stored as a JSON string', async () => {
    const { tx } = txFor({
      activation: JSON.stringify(enforced({ 'P-001': 'owner' })),
      content: plan(['- **P-001** `todo` A.', '- **P-002** `todo` New.']),
    });

    await expect(evaluateConversationActivationGate(tx as never, SCOPE)).resolves.toMatchObject({
      satisfied: false,
      code: 'item_provenance_unresolved',
      unresolvedItems: ['P-002'],
    });
  });

  it('does not enforce a legacy (unenforced) audit, and reads the plan only for its status', async () => {
    const { tx, calls } = txFor({
      activation: { sourceRanges: [], mappings: [], itemProvenanceCheck: { enforced: false, items: { 'P-001': 'unresolved' }, unresolved: ['P-001'] } },
      content: plan(['- **P-001** `todo` A.', '- **P-002** `todo` B.']),
    });

    await expect(evaluateConversationActivationGate(tx as never, SCOPE)).resolves.toEqual({ satisfied: true, auditSeq: 2 });
    // The provenance check reads nothing for an unenforced audit. The one read is the
    // declaration gate's stored-status lookup, which runs for every audit row
    // (plan-reuse-and-library-declarations-2026-10-20 D-013 #1, EI-26528805324626265);
    // this fixture is active, so the declaration sections are not required.
    expect(calls.filter((text) => text.includes('harness_plans'))).toHaveLength(1);
  });

  it('does not enforce an audit recorded before item provenance existed', async () => {
    const { tx } = txFor({
      activation: { sourceRanges: [], mappings: [] },
      content: plan(['- **P-001** `todo` A.']),
    });

    await expect(evaluateConversationActivationGate(tx as never, SCOPE)).resolves.toEqual({ satisfied: true, auditSeq: 2 });
  });

  it('still refuses conversation_audit_required for a draft with no activation audit', async () => {
    const { tx } = txFor({ content: plan(['- **P-001** `todo` A.'], 'draft') });

    await expect(evaluateConversationActivationGate(tx as never, SCOPE)).resolves.toMatchObject({
      satisfied: false,
      code: 'conversation_audit_required',
    });
  });
});

describe('activationGateRefusalValue — the lifecycle-door refusal carries the gate verdict', () => {
  it('keeps an item-provenance refusal distinct from a missing audit', () => {
    const value = activationGateRefusalValue('plan-a', {
      satisfied: false,
      code: 'item_provenance_unresolved',
      message: 'P-002 has no provenance',
      unresolvedItems: ['P-002'],
    });

    expect(value).toEqual({ ok: false, code: 'item_provenance_unresolved', message: 'P-002 has no provenance', unresolvedItems: ['P-002'] });
    expect(isActivationGateRefusalValue(value)).toBe(true);
  });

  it('falls back to the conversation-audit refusal when the verdict names no code', () => {
    const value = activationGateRefusalValue('plan-a', { satisfied: false });

    expect(value.code).toBe('conversation_audit_required');
    expect(value.message).toContain("plans:audit { phase:'activation'");
    expect(value).not.toHaveProperty('unresolvedItems');
    expect(isActivationGateRefusalValue(value)).toBe(true);
  });

  it('rejects values that are not activation-gate refusals', () => {
    expect(isActivationGateRefusalValue({ ok: false, code: 'plan_not_found', message: 'x' })).toBe(false);
    expect(isActivationGateRefusalValue({ ok: true, code: 'item_provenance_unresolved', message: 'x' })).toBe(false);
    expect(isActivationGateRefusalValue(null)).toBe(false);
  });
});
