/**
 * R-6 of plan personal-data-reader-set-labels-2026-10-01: content the agent
 * reads cannot loosen its own label. Releasing a disclosure or loosening a
 * privacy rule needs an owner-typed turn captured by the hook, in THIS session,
 * not declined, carrying the release code for THIS request, and newer than what
 * it releases (D-002 as amended by D-005). Tightening needs nothing.
 *
 * release-authority.ts and disclosure-labels.ts run for real; only the stores
 * are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerDirectiveRow } from '../../owner-directives';

const mocks = vi.hoisted(() => ({
  getOwnerDirective: vi.fn(),
  findCaptured: vi.fn(),
  recordOwnerDirective: vi.fn(),
  loadReleasable: vi.fn(),
  release: vi.fn(),
  listRules: vi.fn(),
  upsertRule: vi.fn(),
  deleteRule: vi.fn(),
}));

vi.mock('../../auth', () => ({ getSessionUserOrDefault: async () => ({ id: 'user-1' }) }));
vi.mock('../_disclosure-subject', () => ({
  disclosureSubject: (ctx: { agent?: string | null }) => ctx.agent ?? null,
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'su-agent' }) }));
vi.mock('../../owner-directives', () => ({
  getOwnerDirective: mocks.getOwnerDirective,
  findCapturedDirectiveContaining: mocks.findCaptured,
  recordOwnerDirective: mocks.recordOwnerDirective,
  countOpenOwnerDirectives: async () => 1,
  directiveNeedsSummary: () => false,
  OWNER_DIRECTIVE_VERBATIM_MAX: 16000,
}));
vi.mock('../../personal-vault/disclosure-ledger', () => ({
  loadReleasableDisclosures: mocks.loadReleasable,
  releaseDisclosures: mocks.release,
  listPrivacyRuleRows: mocks.listRules,
  upsertPrivacyRule: mocks.upsertRule,
  deletePrivacyRule: mocks.deleteRule,
}));

import captureTool from '../orders/capture';
import { releaseCode } from '../../personal-vault/release-authority';
import { classifyCallOrigin } from '../../telemetry-call-origin';
import declassifyTool from './declassify';
import privacyRulesTool from './privacy-rules';

const AGENT = 'su-agent';
const DELIVERED = new Date('2026-10-01T11:00:00Z');
const OWNER_TYPED = Date.parse('2026-10-01T12:00:00Z');
const DOC = '00000000-0000-4000-8000-000000000001';
const ALL_CODE = releaseCode(AGENT, 'declassify:all');

/** Every personal:* tool answers with a `data` envelope; narrow the handler's declared union to it. */
function dataOf(result: unknown): Record<string, unknown> {
  return (result as { data: Record<string, unknown> }).data;
}

function ctx(agent: string | null = AGENT) {
  return { workspaceId: 'ws-1', principal: { workspaceId: 'ws-1' }, tx: {}, agent } as never;
}

function directive(overrides: Partial<OwnerDirectiveRow> = {}): OwnerDirectiveRow {
  return {
    id: 41,
    workspaceId: 'ws-1',
    ownerId: 'owner',
    sessionRef: 'native-session',
    sourceTurnRef: 'native-session:abc',
    verbatimText: `ok, release ${ALL_CODE}`,
    recordedBy: AGENT,
    createdAtMs: OWNER_TYPED,
    dispositionedAtMs: null,
    dispositionStatus: null,
    dispositionNote: null,
    dispositionedBy: null,
    summaryText: null,
    summaryBy: null,
    summaryAtMs: null,
    capturedByHook: true,
    ...overrides,
  };
}

function rule(matchKind: 'source' | 'sender' | 'sender-domain', matchValue: string, level: 'unrestricted' | 'participants' | 'sender-only') {
  return {
    id: `${matchKind}-${matchValue}`,
    matchKind,
    matchValue,
    level,
    createdBy: 'owner',
    updatedBy: 'owner',
    updatedAt: new Date('2026-10-01T10:00:00Z'),
    authorityRef: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadReleasable.mockResolvedValue([
    { id: 'row-1', documentId: DOC, level: 'sender-only', readerSet: ['alice@example.com'], deliveredAt: DELIVERED },
  ]);
  mocks.release.mockResolvedValue([DOC]);
  mocks.findCaptured.mockResolvedValue(null);
  mocks.getOwnerDirective.mockResolvedValue(null);
  mocks.listRules.mockResolvedValue([rule('source', 'gmail', 'sender-only')]);
  mocks.upsertRule.mockImplementation(async (_sql, params) => ({ ...rule(params.matchKind, params.matchValue, params.level), authorityRef: params.authorityRef }));
  mocks.deleteRule.mockResolvedValue(rule('source', 'gmail', 'sender-only'));
});

describe('personal:declassify', () => {
  it('refuses without an owner turn carrying the code, and hands back the code to relay', async () => {
    const result = await declassifyTool.handler({ all: true }, ctx());
    expect(dataOf(result)).toMatchObject({ refused: true, code: 'release_authority_required', releaseCode: ALL_CODE });
    expect((dataOf(result) as { ownerPrompt: string }).ownerPrompt).toContain(`release ${ALL_CODE}`);
    expect(mocks.findCaptured).toHaveBeenCalledWith({ workspaceId: 'ws-1', recordedBy: AGENT, token: ALL_CODE }, undefined);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('releases with a hook-captured owner turn in this session carrying the code', async () => {
    mocks.findCaptured.mockResolvedValue(directive());
    const result = await declassifyTool.handler({ all: true }, ctx());
    expect(dataOf(result)).toEqual({ ok: true, released: [DOC], releaseRef: 'owner_directive:41' });
    expect(mocks.release).toHaveBeenCalledWith({}, {
      workspaceId: 'ws-1',
      agentOwnerId: AGENT,
      ids: ['row-1'],
      deliveredBefore: new Date(OWNER_TYPED),
      releasedBy: AGENT,
      releaseRef: 'owner_directive:41',
    });
  });

  it.each([
    ['missing', null, 'release_authority_not_found'],
    ['in another workspace', directive({ workspaceId: 'ws-2' }), 'release_authority_not_found'],
    ['recorded by an agent, not the hook', directive({ capturedByHook: false }), 'release_authority_not_owner_typed'],
    ['typed into another session', directive({ recordedBy: 'su-other' }), 'release_authority_foreign'],
    ['declined', directive({ dispositionStatus: 'declined', dispositionedAtMs: OWNER_TYPED + 1 }), 'release_authority_declined'],
    ['an unrelated owner turn', directive({ verbatimText: 'continue where you left off' }), 'release_authority_code_missing'],
    ['the code for a different request', directive({ verbatimText: `release ${releaseCode(AGENT, `declassify:${DOC}`)}` }), 'release_authority_code_missing'],
    ['older than the content it would release', directive({ createdAtMs: DELIVERED.getTime() - 1 }), 'release_authority_stale'],
  ])('refuses a cited directive that is %s', async (_label, row, code) => {
    mocks.getOwnerDirective.mockResolvedValue(row);
    const result = await declassifyTool.handler({ all: true, directiveId: 41 }, ctx());
    expect(dataOf(result)).toMatchObject({ refused: true, code });
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('binds the code to the caller: another agent\'s code does not authorize this one', async () => {
    const foreignCode = releaseCode('su-other', 'declassify:all');
    mocks.getOwnerDirective.mockResolvedValue(directive({ verbatimText: `release ${foreignCode}` }));
    const result = await declassifyTool.handler({ all: true, directiveId: 41 }, ctx());
    expect(dataOf(result)).toMatchObject({ refused: true, code: 'release_authority_code_missing' });
  });

  it('a caller with no identity carries nothing and releases nothing', async () => {
    const result = await declassifyTool.handler({ all: true }, ctx(null));
    expect(dataOf(result)).toMatchObject({ ok: true, released: [] });
    expect(mocks.loadReleasable).not.toHaveBeenCalled();
  });
});

describe('personal:privacy-rules', () => {
  it('tightening is unconditional: no owner turn is consulted', async () => {
    mocks.listRules.mockResolvedValue([rule('source', 'gmail', 'participants')]);
    const result = await privacyRulesTool.handler(
      { action: 'set', matchKind: 'source', matchValue: 'Gmail', level: 'sender-only' },
      ctx(),
    );
    expect(dataOf(result)).toMatchObject({ ok: true, effect: 'tighten', rule: { matchValue: 'gmail', level: 'sender-only' } });
    expect(mocks.findCaptured).not.toHaveBeenCalled();
    expect(mocks.getOwnerDirective).not.toHaveBeenCalled();
    expect(mocks.upsertRule).toHaveBeenCalledWith({}, expect.objectContaining({ authorityRef: null, actor: AGENT }));
  });

  it('a per-sender carve-out below the source level is loosening and is refused without the owner', async () => {
    const result = await privacyRulesTool.handler(
      { action: 'set', matchKind: 'sender', matchValue: 'Alice <alice@example.com>', level: 'unrestricted' },
      ctx(),
    );
    expect(dataOf(result)).toMatchObject({
      refused: true,
      effect: 'loosen',
      code: 'release_authority_required',
      releaseCode: releaseCode(AGENT, 'privacy-rule:set:sender:alice@example.com:unrestricted'),
    });
    expect(mocks.upsertRule).not.toHaveBeenCalled();
  });

  it('deleting a restrictive rule is loosening and is refused without the owner', async () => {
    const result = await privacyRulesTool.handler({ action: 'delete', matchKind: 'source', matchValue: 'gmail' }, ctx());
    expect(dataOf(result)).toMatchObject({ refused: true, effect: 'loosen', code: 'release_authority_required' });
    expect(mocks.deleteRule).not.toHaveBeenCalled();
  });

  it('applies a loosening the owner typed the code for, recording it as authority_ref', async () => {
    const code = releaseCode(AGENT, 'privacy-rule:set:sender:alice@example.com:unrestricted');
    mocks.findCaptured.mockResolvedValue(directive({ id: 77, verbatimText: `yes, release ${code}` }));
    const result = await privacyRulesTool.handler(
      { action: 'set', matchKind: 'sender', matchValue: 'alice@example.com', level: 'unrestricted' },
      ctx(),
    );
    expect(dataOf(result)).toMatchObject({ ok: true, effect: 'loosen', rule: { authorityRef: 'owner_directive:77' } });
  });

  it('refuses a loosening whose owner turn predates the last rule change', async () => {
    const code = releaseCode(AGENT, 'privacy-rule:delete:source:gmail');
    mocks.listRules.mockResolvedValue([{ ...rule('source', 'gmail', 'sender-only'), updatedAt: new Date(OWNER_TYPED + 1) }]);
    mocks.findCaptured.mockResolvedValue(directive({ verbatimText: `release ${code}` }));
    const result = await privacyRulesTool.handler({ action: 'delete', matchKind: 'source', matchValue: 'gmail' }, ctx());
    expect(dataOf(result)).toMatchObject({ refused: true, code: 'release_authority_stale' });
    expect(mocks.deleteRule).not.toHaveBeenCalled();
  });

  it('rejects a match value that could never match a document', async () => {
    const result = await privacyRulesTool.handler({ action: 'set', matchKind: 'sender', matchValue: 'not an address', level: 'sender-only' }, ctx());
    expect(dataOf(result)).toMatchObject({ refused: true, code: 'privacy_rule_match_invalid' });
  });
});

describe('orders:capture accepts only the hook (the proof R-6 rests on)', () => {
  function captureCtx(query: Record<string, string>, headers: Record<string, string> = {}) {
    return { workspaceId: 'ws-1', requestOrigin: { query, headers } } as never;
  }
  const args = { verbatim: `release ${ALL_CODE}`, sourceTurnRef: 'native-session:abc' };

  it('refuses a model client, so an agent cannot mint an owner-typed turn', async () => {
    const result = await captureTool.handler(args, captureCtx({ superuser: '1', tools: 'seed', profile: 'su' }));
    expect(JSON.parse((result as { content: Array<{ text: string }> }).content[0].text)).toMatchObject({
      ok: false,
      error: 'hook_origin_required',
    });
    expect(mocks.recordOwnerDirective).not.toHaveBeenCalled();
  });

  it('refuses a client that only looks like the hook, so a script an agent writes cannot either', async () => {
    const lookalike = { query: { superuser: '1' }, headers: { 'user-agent': 'Python-urllib/3.12' } };
    // The fixture must classify as an UNDECLARED hook, or this case would also
    // pass against a rail that checked the origin and ignored its source.
    expect(classifyCallOrigin({ requestOrigin: lookalike })).toEqual({ origin: 'hook', source: 'derived' });

    const result = await captureTool.handler(args, captureCtx(lookalike.query, lookalike.headers));
    expect(JSON.parse((result as { content: Array<{ text: string }> }).content[0].text)).toMatchObject({
      ok: false,
      error: 'hook_origin_required',
    });
    expect(mocks.recordOwnerDirective).not.toHaveBeenCalled();
  });

  it('records a declared hook dispatch as captured by the hook', async () => {
    mocks.recordOwnerDirective.mockResolvedValue(directive({ id: 90 }));
    const result = await captureTool.handler(args, captureCtx({ superuser: '1', origin: 'hook' }));
    expect(JSON.parse((result as { content: Array<{ text: string }> }).content[0].text)).toMatchObject({ ok: true, id: 90 });
    expect(mocks.recordOwnerDirective).toHaveBeenCalledWith(expect.objectContaining({ capturedByHook: true, recordedBy: AGENT }));
  });
});
