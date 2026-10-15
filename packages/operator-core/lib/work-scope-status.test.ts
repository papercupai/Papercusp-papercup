/**
 * work-scope-status.test.ts — the status LENS behind `state:read { cell:'workspace.workScope' }`,
 * the `workScope.policy` sync query and the read-only tool `workspace:work_scope_status`
 * (WI-2145092, the D-003 residue of plan workspace-work-scope-policy-2026-09-04).
 *
 * The assessor is exercised end-to-end by cell-assessment-reality.test.ts (producibility,
 * closure, sign); this file pins the PAYLOAD contract the cell registration declares —
 * headline `mode`, evidence `enforced` + `allowHarnesses`, assessment `assessments.policy` —
 * and that the tool projects it unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store: { policy: Record<string, unknown> } = { policy: {} };
vi.mock('./pot-control-policy', () => ({
  placementOverride: vi.fn(() => store.policy),
  readPotControlPolicy: vi.fn(async () => store.policy),
  writePotControlPolicy: vi.fn(async (patch: Record<string, unknown>) => {
    store.policy = { ...store.policy, ...patch };
    return store.policy;
  }),
  refreshPotControlPolicy: vi.fn(async () => {}),
}));

const { assessWorkScope, buildWorkScopeStatusPayload, WORK_SCOPE_LEDGER_CAP } = await import('./work-scope-policy');
const { WORK_SCOPE_CELL } = await import('./cell-registrations');
const { default: statusTool } = await import('./agent-tools/pot/work-scope-status');

const decision = (i: number) => ({
  at: `2026-09-05T00:00:${String(i).padStart(2, '0')}Z`,
  site: 'work_items:claim',
  verdict: 'denied' as const,
  harness: 'sidestage',
  subject: `WI-${i}`,
});

beforeEach(() => {
  store.policy = {};
});

describe('assessWorkScope — one code, derived from the gates’ own predicate', () => {
  it('absent ← no row; off ← mode off OR an enforce row with an empty allow-list; enforce ← enforce + allow-list', () => {
    expect(assessWorkScope(null)).toBe('absent');
    expect(assessWorkScope({ mode: 'off', allowHarnesses: ['papercusp'] })).toBe('off');
    expect(assessWorkScope({ mode: 'enforce', allowHarnesses: [] })).toBe('off');
    expect(assessWorkScope({ mode: 'enforce', allowHarnesses: ['  '] })).toBe('off');
    expect(assessWorkScope({ mode: 'enforce', allowHarnesses: ['papercusp', 'papercusp/*'] })).toBe('enforce');
  });
});

describe('buildWorkScopeStatusPayload', () => {
  it('projects an absent policy as a measured absent state, not a failed read', () => {
    const p = buildWorkScopeStatusPayload(null);
    expect(p).toEqual({
      ok: true,
      mode: null,
      enforced: false,
      allowHarnesses: [],
      exceptions: 0,
      setBy: null,
      reason: null,
      updatedAt: null,
      ledger: { counts: { denied: 0, held: 0, rehomed: 0 }, recent: [] },
      assessments: { policy: 'absent' },
    });
  });

  it('projects an enforced policy with its ledger tail (newest last), bounded by `recent` and the ring cap', () => {
    const entries = Array.from({ length: 15 }, (_, i) => decision(i));
    const policy = {
      mode: 'enforce' as const,
      allowHarnesses: ['papercusp'],
      exceptions: [{ plan: 'x', reason: 'because' }],
      setBy: 'role:su',
      reason: 'owner: papercusp only',
      updatedAt: '2026-09-05T02:37:07Z',
      ledger: { entries, counts: { denied: 15, held: 2, rehomed: 5 } },
    };
    const p = buildWorkScopeStatusPayload(policy, { recent: 3 });
    expect(p.mode).toBe('enforce');
    expect(p.enforced).toBe(true);
    expect(p.assessments.policy).toBe('enforce');
    expect(p.exceptions).toBe(1);
    expect(p.ledger.counts).toEqual({ denied: 15, held: 2, rehomed: 5 });
    expect(p.ledger.recent.map((d) => d.subject)).toEqual(['WI-12', 'WI-13', 'WI-14']);
    expect(buildWorkScopeStatusPayload(policy).ledger.recent).toHaveLength(10);
    expect(buildWorkScopeStatusPayload(policy, { recent: 0 }).ledger.recent).toEqual([]);
    expect(buildWorkScopeStatusPayload(policy, { recent: WORK_SCOPE_LEDGER_CAP * 2 }).ledger.recent).toHaveLength(15);
  });

  it('carries every path the workspace.workScope cell registration declares — headline, evidence, assessment', () => {
    const p = buildWorkScopeStatusPayload({ mode: 'enforce', allowHarnesses: ['papercusp'] }) as unknown as Record<string, unknown>;
    const walk = (path: string) => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], p);
    expect(walk(WORK_SCOPE_CELL.headline)).toBe('enforce');
    expect(walk(WORK_SCOPE_CELL.assessment!.path)).toBe('enforce');
    for (const e of WORK_SCOPE_CELL.assessment!.evidence) expect(walk(e), `evidence path ${e}`).not.toBeUndefined();
    expect(Object.keys(WORK_SCOPE_CELL.assessment!.codes).sort()).toEqual(['absent', 'enforce', 'off']);
  });
});

describe('workspace:work_scope_status — the read-only resolver the cell dispatcher may call', () => {
  it('admits the evidence-scoped roles already allowed through state:read', () => {
    expect(statusTool.agentRoles).toContain('release-fixer');
    expect(statusTool.agentRoles).toContain('judge');
  });

  it('is the cell’s declared poll tool, read-only, and projects the payload unchanged', async () => {
    expect(WORK_SCOPE_CELL.changeSignal).toEqual({ kind: 'poll', tool: 'workspace:work_scope_status', path: 'mode' });
    expect(statusTool.name).toBe('workspace:work_scope_status');
    expect(statusTool.capability).toBe('intel:read');

    store.policy = {
      workScope: {
        mode: 'enforce',
        allowHarnesses: ['papercusp'],
        ledger: { entries: [decision(1), decision(2)], counts: { denied: 2, held: 0, rehomed: 0 } },
      },
    };
    const res = await statusTool.handler({ recent: 1 } as never, {} as never);
    const text = (res as { content: { text: string }[] }).content[0]!.text;
    const payload = JSON.parse(text) as ReturnType<typeof buildWorkScopeStatusPayload>;
    expect(payload.mode).toBe('enforce');
    expect(payload.assessments.policy).toBe('enforce');
    expect(payload.ledger.recent.map((d) => d.subject)).toEqual(['WI-2']);
    expect(payload).toEqual(buildWorkScopeStatusPayload(store.policy.workScope as never, { recent: 1 }));
  });

  it('reads absent when the row has no workScope key', async () => {
    const res = await statusTool.handler({} as never, {} as never);
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0]!.text) as { assessments: { policy: string }; mode: null };
    expect(payload.mode).toBeNull();
    expect(payload.assessments.policy).toBe('absent');
  });
});
