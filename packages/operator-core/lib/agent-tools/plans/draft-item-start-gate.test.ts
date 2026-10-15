import { describe, expect, it, vi } from 'vitest';
import { checkDraftItemStartGate } from './draft-item-start-gate';

function plan(status: string, items: Record<string, string>, template?: string): string {
  // The plan-item line format the parser reads: `- **P-NNN** \`status\` text`.
  const lines = Object.entries(items).map(([id, s]) => `- **${id}** \`${s}\` item ${id}`);
  return `---\ntitle: T\nstatus: ${status}\n${template ? `template: ${template}\n` : ''}---\n\n## Phase 1 — Work\n\n${lines.join('\n')}\n`;
}

const unaudited = { satisfied: false as const, code: 'conversation_audit_required', message: 'audit first' };
const audited = { satisfied: true as const, auditSeq: 1 };

function deps(content: string | null, gate: { satisfied: boolean; code?: string; message?: string }, covered = false) {
  return {
    readPlanContent: vi.fn().mockResolvedValue(content),
    evaluateGate: vi.fn().mockResolvedValue(gate),
    hasCoveringWorkItem: vi.fn().mockResolvedValue(covered),
  };
}

describe('checkDraftItemStartGate (WI-10008137)', () => {
  it('refuses starting a todo item on an unaudited draft plan', async () => {
    for (const toStatus of ['wip', 'done']) {
      const d = deps(plan('draft', { 'P-001': 'todo' }), unaudited);
      const out = await checkDraftItemStartGate({ slug: 's', itemId: 'P-001', toStatus, ...d });
      expect(out).toMatchObject({ ok: false, error: 'activation_audit_required', gateCode: 'conversation_audit_required' });
      expect(out?.hint).toContain("plans:audit { phase:'activation' }");
    }
  });

  it('allows the start once the activation audit exists', async () => {
    const d = deps(plan('draft', { 'P-001': 'todo' }), audited);
    expect(await checkDraftItemStartGate({ slug: 's', itemId: 'P-001', toStatus: 'wip', ...d })).toBeNull();
  });

  it('lets an item already in progress keep going (wip -> done)', async () => {
    const d = deps(plan('draft', { 'P-001': 'wip' }), unaudited);
    expect(await checkDraftItemStartGate({ slug: 's', itemId: 'P-001', toStatus: 'done', ...d })).toBeNull();
    expect(d.evaluateGate).not.toHaveBeenCalled();
  });

  it('lets an item covered by an open work-item through (work-item reflections, convert pickup)', async () => {
    const d = deps(plan('draft', { 'P-001': 'todo' }), unaudited, true);
    expect(await checkDraftItemStartGate({ slug: 's', itemId: 'P-001', toStatus: 'wip', ...d })).toBeNull();
  });

  it('never gates a non-draft plan or a non-start transition', async () => {
    for (const status of ['ready', 'active', 'shipped']) {
      const d = deps(plan(status, { 'P-001': 'todo' }), unaudited);
      expect(await checkDraftItemStartGate({ slug: 's', itemId: 'P-001', toStatus: 'wip', ...d })).toBeNull();
    }
    for (const toStatus of ['todo', 'blocked', 'dropped', 'needs-human']) {
      const d = deps(plan('draft', { 'P-001': 'todo' }), unaudited);
      expect(await checkDraftItemStartGate({ slug: 's', itemId: 'P-001', toStatus, ...d })).toBeNull();
      expect(d.readPlanContent).not.toHaveBeenCalled();
    }
  });

  it('defers unknown items and unreadable plans to the normal path', async () => {
    const missingItem = deps(plan('draft', { 'P-001': 'todo' }), unaudited);
    expect(await checkDraftItemStartGate({ slug: 's', itemId: 'P-999', toStatus: 'wip', ...missingItem })).toBeNull();
    const noPlan = deps(null, unaudited);
    expect(await checkDraftItemStartGate({ slug: 's', itemId: 'P-001', toStatus: 'wip', ...noPlan })).toBeNull();
  });
});
