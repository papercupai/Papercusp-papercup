/**
 * meta:define-datatype — the nature gates added by enterprise-data-sources-2026-10-01 P-008
 * (D-001 / D-013). The refusals run before any write, so the registry reads are mocked and
 * the test pins only the decision: a NEW datatype must state its nature (no default), work
 * must state its audience, and the built-in item kinds can never be re-declared.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ getDatatype: vi.fn(), upsertDatatype: vi.fn() }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../coordination/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/identity')>()),
  resolveAgentIdentity: () => ({ ownerId: 'su-test', kind: 'superuser' }),
}));
vi.mock('../../datatype-registry-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../datatype-registry-store')>()),
  getDatatype: m.getDatatype,
  upsertDatatype: m.upsertDatatype,
}));

import declare from './declare';

type Reply = { ok: boolean; reason?: string; message?: string };
const CTX = { workspaceId: 'ws-test', harnessSlug: 'papercusp' };

async function call(args: Record<string, unknown>): Promise<Reply> {
  const out = (await declare.handler(
    { tier: 'generic-kind', description: 'a test datatype', ...args } as never,
    CTX as never,
  )) as { data: Reply };
  return out.data;
}

beforeEach(() => {
  m.getDatatype.mockReset().mockResolvedValue(null);
  m.upsertDatatype.mockReset();
});

describe('meta:define-datatype nature gates (P-008)', () => {
  it('refuses a NEW datatype with no nature, and writes nothing', async () => {
    const r = await call({ name: 'pipeline-deal-2' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('nature_required');
    expect(r.message).toMatch(/work \| record \| document \| event/);
    expect(m.upsertDatatype).not.toHaveBeenCalled();
  });

  it('refuses work with no audience, and data with an audience', async () => {
    expect((await call({ name: 'triage-request', nature: 'work' })).reason).toBe('audience_required');
    expect((await call({ name: 'ledger-entry', nature: 'record', audience: 'agent' })).reason).toBe(
      'audience_not_allowed',
    );
    expect(m.upsertDatatype).not.toHaveBeenCalled();
  });

  it('an in-place update may omit nature: the stored nature passes the gate', async () => {
    m.getDatatype.mockResolvedValue({ id: 'ledger-entry', nature: 'record', audience: null, selfImprovement: null });
    const r = await call({ name: 'ledger-entry' });
    // The nature gate passed; the next gate (P-010 self-improvement) is what refuses here.
    expect(r.reason).not.toBe('nature_required');
    expect(r.reason).toBe('self_improvement_required');
  });

  it('a changed nature drops the stored audience instead of carrying it across', async () => {
    m.getDatatype.mockResolvedValue({ id: 'triage-request', nature: 'work', audience: 'agent', selfImprovement: null });
    // work → record: the stored agent audience must not ride along (it would violate the CHECK).
    const r = await call({ name: 'triage-request', nature: 'record' });
    expect(r.reason).not.toBe('audience_not_allowed');
    expect(r.reason).toBe('self_improvement_required');
  });

  it('refuses re-declaring a built-in item kind by id, for every built-in kind', async () => {
    for (const kind of ['feature', 'chunk', 'bug', 'change', 'task']) {
      const r = await call({ name: kind, nature: 'record' });
      expect(r.ok, kind).toBe(false);
      expect(r.reason, kind).toBe('builtin_reserved');
    }
    expect(m.getDatatype).not.toHaveBeenCalled();
  });

  it('refuses a datatype whose work_item_kind would shadow a built-in kind', async () => {
    const r = await call({ name: 'my-defects', workItemKind: 'bug', nature: 'work', audience: 'agent' });
    expect(r.reason).toBe('builtin_reserved');
    expect(r.message).toMatch(/"bug" is a built-in work item kind/);
    expect(m.getDatatype).not.toHaveBeenCalled();
  });
});
