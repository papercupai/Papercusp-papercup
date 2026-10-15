/**
 * EI-25692833751908142 — the judge's narrow door for independent-verification bindings.
 *
 * Three properties, each against the real code:
 *   1. The `judge` principal holds the door's capability but NOT plans:write, so it can call
 *      this verb and still cannot call plans:bind-spec-evidence (role-principal-caps.ts).
 *   2. The door accepts ONLY evidenceKind 'independent-verification': any other kind, a
 *      fromTestRun derivation, retract and supersedeAtRevision are refused at argument
 *      validation, before any store write.
 *   3. An accepted call reaches plans:bind-spec-evidence's handler with the same binding
 *      (the store-side checks are reused, never re-implemented).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const innerHandler = vi.fn();

vi.mock('./bind-spec-evidence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bind-spec-evidence')>();
  return {
    ...actual,
    default: { ...actual.default, handler: (...a: unknown[]) => innerHandler(...a) },
  };
});

import tool, { INDEPENDENT_VERIFICATION_WRITE_CAPABILITY } from './bind-independent-verification';
import bindSpecEvidence from './bind-spec-evidence';
import { loadRoleCapabilities } from '../../endpoint-route/routes/transport/role-principal-caps';

const FP = 'a'.repeat(64);

function binding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workItemId: 'WI-1',
    specId: 'AUTO-BAR-R-4-P-004',
    specRevision: 7,
    evidenceKind: 'independent-verification',
    verifiesBindingId: 37389,
    evidenceRef: 'plans:verification-health on :3170',
    sourceFingerprint: FP,
    details: { note: 're-observed triageGaps 0 at 14:12Z' },
    ...over,
  };
}

function fakeTx(rows: Array<{ capabilities: string[] }>) {
  const tx = (async () => rows) as unknown as Parameters<typeof loadRoleCapabilities>[0];
  return tx;
}

beforeEach(() => {
  innerHandler.mockReset();
  innerHandler.mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
});

describe('plans:bind-independent-verification — capability', () => {
  it('declares its own narrow capability, not plans:write', () => {
    expect(tool.capability).toBe(INDEPENDENT_VERIFICATION_WRITE_CAPABILITY);
    expect(tool.capability).not.toBe(bindSpecEvidence.capability);
    expect(tool.agentRoles).toContain('judge');
  });

  it('judge holds the door capability and still lacks plans:write', { timeout: 60_000 }, async () => {
    const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'judge');
    expect(caps.has(INDEPENDENT_VERIFICATION_WRITE_CAPABILITY)).toBe(true);
    expect(caps.has('plans:write')).toBe(false);
  });
});

describe('plans:bind-independent-verification — only independent-verification gets through', () => {
  it('accepts a hand-built independent-verification binding and forwards it unchanged', async () => {
    const parsed = tool.args.parse({ slug: 'p', harness: 'papercusp', binding: binding() });
    await tool.handler(parsed as never, { role: 'judge' } as never);
    expect(innerHandler).toHaveBeenCalledTimes(1);
    const [innerArgs] = innerHandler.mock.calls[0] as [Record<string, unknown>];
    expect(innerArgs).toMatchObject({ slug: 'p', harness: 'papercusp', binding: binding() });
    expect(innerArgs).not.toHaveProperty('retract');
    expect(innerArgs).not.toHaveProperty('supersedeAtRevision');
  });

  it('accepts items, all independent-verification', async () => {
    const parsed = tool.args.parse({ slug: 'p', items: [binding(), binding({ specId: 'AUTO-BAR-R-5-P-005' })] });
    await tool.handler(parsed as never, {} as never);
    const [innerArgs] = innerHandler.mock.calls[0] as [{ items: unknown[] }];
    expect(innerArgs.items).toHaveLength(2);
  });

  it.each(['test', 'operational', 'manual', 'check'])('refuses evidenceKind %s', (kind) => {
    const r = tool.args.safeParse({ slug: 'p', binding: binding({ evidenceKind: kind, verifiesBindingId: undefined }) });
    expect(r.success).toBe(false);
  });

  it('refuses one non-independent item inside items', () => {
    const r = tool.args.safeParse({
      slug: 'p',
      items: [binding(), binding({ evidenceKind: 'test', verifiesBindingId: undefined })],
    });
    expect(r.success).toBe(false);
  });

  it('refuses fromTestRun, retract and supersedeAtRevision (no such inputs on this door)', () => {
    expect(tool.args.safeParse({ slug: 'p', binding: { fromTestRun: 5, workItemId: 'WI-1' } }).success).toBe(false);
    // The schema is strict: an inner-verb-only key is refused, never silently stripped.
    expect(
      tool.args.safeParse({ slug: 'p', binding: binding(), retract: [{ bindingId: 1, reason: 'x'.repeat(20) }] }).success,
    ).toBe(false);
    expect(tool.args.safeParse({ slug: 'p', binding: binding(), supersedeAtRevision: true }).success).toBe(false);
  });

  it('requires exactly one of binding or items', () => {
    expect(tool.args.safeParse({ slug: 'p' }).success).toBe(false);
    expect(tool.args.safeParse({ slug: 'p', binding: binding(), items: [binding()] }).success).toBe(false);
  });

  it('CONTROL: the same non-independent binding IS valid on plans:bind-spec-evidence', () => {
    const b = binding({ evidenceKind: 'operational', verifiesBindingId: undefined });
    expect(bindSpecEvidence.args.safeParse({ slug: 'p', binding: b }).success).toBe(true);
    expect(tool.args.safeParse({ slug: 'p', binding: b }).success).toBe(false);
  });
});
