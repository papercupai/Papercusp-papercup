import { describe, expect, it, vi } from 'vitest';
import { checkDraftItemStartGate } from './draft-item-start-gate';

function plan(status: string, items: Record<string, string>, template?: string): string {
  // The plan-item line format the parser reads: `- **P-NNN** \`status\` text`.
  const lines = Object.entries(items).map(([id, s]) => `- **${id}** \`${s}\` item ${id}`);
  return `---\ntitle: T\nstatus: ${status}\n${template ? `template: ${template}\n` : ''}---\n\n## Phase 1 — Work\n\n${lines.join('\n')}\n`;
}

const unaudited = { satisfied: false as const, code: 'conversation_audit_required', message: 'audit first' };
const audited = { satisfied: true as const, auditSeq: 1 };

function deps(
  content: string | null,
  gate: { satisfied: boolean; code?: string; message?: string },
  covered = false,
  terminalCovered = false,
) {
  return {
    readPlanContent: vi.fn().mockResolvedValue(content),
    evaluateGate: vi.fn().mockResolvedValue(gate),
    hasCoveringWorkItem: vi.fn().mockResolvedValue(covered),
    hasTerminalCoveringWorkItem: vi.fn().mockResolvedValue(terminalCovered),
  };
}

describe('checkDraftItemStartGate (WI-10008137)', () => {
  it.each(['draft', 'ready', 'active'])('refuses a new implementation start on %s before activation or open-cover bypass', async status => {
    const d = deps(plan(status, { 'P-001': 'todo' }), audited, true);
    const evaluateDiscovery = vi.fn(async () => ({ ok: false as const, error: 'discovery_not_ready', nextAction: 'Resolve Q-1.' }));
    expect(await checkDraftItemStartGate({ slug: 's', itemId: 'P-001', toStatus: 'wip', ...d, evaluateDiscovery }))
      .toMatchObject({ error: 'discovery_not_ready', hint: 'Resolve Q-1.' });
    expect(d.evaluateGate).not.toHaveBeenCalled();
    expect(d.hasCoveringWorkItem).not.toHaveBeenCalled();
  });

  it('admits reconciled discovery and leaves registered task work about the draft outside item-start authority', async () => {
    const d = deps(plan('ready', { 'P-001': 'todo' }), audited);
    const evaluateDiscovery = vi.fn(async () => ({ ok: true as const }));
    expect(await checkDraftItemStartGate({ slug: 's', itemId: 'P-001', toStatus: 'wip', ...d, evaluateDiscovery })).toBeNull();
    expect(evaluateDiscovery).toHaveBeenCalledOnce();
    evaluateDiscovery.mockClear();
    expect(await checkDraftItemStartGate({ slug: 's', itemId: 'P-001', toStatus: 'todo', ...d, evaluateDiscovery })).toBeNull();
    expect(evaluateDiscovery).not.toHaveBeenCalled();
  });

  it('preserves already-started work and terminal reflection without reopening discovery', async () => {
    const evaluateDiscovery = vi.fn(async () => ({ ok: false as const, error: 'discovery_not_ready' }));
    for (const [status, terminalCovered] of [['wip', false], ['todo', true]] as const) {
      const d = deps(plan('draft', { 'P-001': status }), unaudited, false, terminalCovered);
      expect(await checkDraftItemStartGate({ slug: 's', itemId: 'P-001', toStatus: 'done', ...d, evaluateDiscovery })).toBeNull();
    }
    expect(evaluateDiscovery).not.toHaveBeenCalled();
  });

  it('fails closed when current discovery cannot be measured', async () => {
    const d = deps(plan('active', { 'P-001': 'todo' }), audited);
    await expect(checkDraftItemStartGate({ slug: 's', itemId: 'P-001', toStatus: 'wip', ...d,
      evaluateDiscovery: async () => { throw new Error('discovery read unavailable'); } })).rejects.toThrow('discovery read unavailable');
  });
  it('refuses starting a todo item on an unaudited draft plan', async () => {
    for (const toStatus of ['wip', 'done']) {
      const d = deps(plan('draft', { 'P-001': 'todo' }), unaudited);
      const out = await checkDraftItemStartGate({ slug: 's', itemId: 'P-001', toStatus, ...d });
      expect(out).toMatchObject({ ok: false, error: 'activation_audit_required', gateCode: 'conversation_audit_required' });
      expect(out?.hint).toContain("plans:audit { phase:'activation' }");
    }
  });

  it('allows todo→done reflection when a terminal linked work-item proves completion', async () => {
    const d = deps(plan('draft', { 'P-001': 'todo' }), unaudited, false, true);
    expect(await checkDraftItemStartGate({ slug: 's', itemId: 'P-001', toStatus: 'done', ...d })).toBeNull();
    expect(d.evaluateGate).not.toHaveBeenCalled();
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
