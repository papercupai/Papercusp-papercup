/**
 * WI-2142026 — the WIRING half. `safety-slot-key-intent.test.ts` proves the
 * detector is right; this file proves the handler actually SURFACES it, which is
 * a different claim and the one that regresses silently.
 *
 * The detector sits beside the slot-normalization branch, several hundred lines
 * above the receipt it feeds. Any later edit that reorders that block, or that
 * rebuilds the response object without carrying the field, leaves a tool that
 * still detects the near-miss perfectly and tells nobody — a pure-unit green the
 * whole time.
 *
 * The other load-bearing assertion here is NEGATIVE: the warning must not have
 * changed the write. A disclosure that quietly rewrote the caller's upsert key
 * would fork their fact, which is precisely why this detector reports instead of
 * repairing — so `assertFact` is asserted to have received the ORIGINAL key.
 *
 * ⚠ The store is mocked. A green here says the receipt carries the warning and
 * the write is untouched; it says nothing about cap behaviour itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentFact, AssertFactInput } from '../../agent-facts/store';

const h = vi.hoisted(() => {
  const boundedTx = { query: vi.fn(), marker: 'bounded-org-txn' };
  return {
    assertFact: vi.fn<(input: AssertFactInput, inject?: unknown) => Promise<AgentFact>>(),
    boundedTx,
    boundedOrgTxn: vi.fn(async (fn: (tx: typeof boundedTx) => Promise<AgentFact>) => fn(boundedTx)),
  };
});

vi.mock('../../agent-facts/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-facts/store')>();
  return { ...actual, assertFact: h.assertFact };
});
vi.mock('../../pg-bounded-txn', () => ({ boundedOrgTxn: h.boundedOrgTxn }));

import assertTool from './assert';

function storedFact(input: AssertFactInput): AgentFact {
  return {
    scope: input.scope,
    scopeRef: input.scopeRef ?? null,
    key: input.key,
    body: input.body,
    sourceRef: input.sourceRef ?? null,
    audienceScope: input.audienceScope ?? null,
    sourceProvenance: input.sourceProvenance ?? null,
    confidence: input.confidence ?? null,
    measurement: null,
    kind: input.kind ?? null,
    dependsOn: [...(input.dependsOn ?? [])],
    claim: input.claim ?? null,
    enforcement: input.enforcement ?? null,
    settledBy: input.settledBy ?? null,
    createdBy: input.createdBy,
    updatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-08T00:00:00.000Z',
  } as AgentFact;
}

type Receipt = {
  ok?: boolean;
  slotIntentWarning?: { slot: string; matchedPrefix: string; suggestedKey: string; note: string };
  absenceWarning?: string;
};

async function assertAndRead(
  args: Record<string, unknown>,
): Promise<{ receipt: Receipt; writtenKey: string | undefined; writtenBody: string | undefined }> {
  const result = (await assertTool.handler({ ...args } as never, {
    isSuperuser: true,
    uiClientId: 'su-test-slot-intent',
  } as never)) as { content: { text: string }[] };
  return {
    receipt: JSON.parse(result.content[0].text) as Receipt,
    writtenKey: h.assertFact.mock.calls[0]?.[0]?.key,
    writtenBody: h.assertFact.mock.calls[0]?.[0]?.body,
  };
}

const BASE = { scope: 'workspace', body: 'BYOC live-host gates are owner-authority.', ttlSec: 604800 };

describe('facts:assert — safety-slot key-intent warning reaches the receipt', () => {
  beforeEach(() => {
    h.assertFact.mockReset();
    h.assertFact.mockImplementation(async (input) => storedFact(input));
    h.boundedOrgTxn.mockReset();
    h.boundedOrgTxn.mockImplementation(async (fn) => fn(h.boundedTx));
  });

  it('surfaces the warning for a near-miss key, naming the slot and the repair', async () => {
    const { receipt } = await assertAndRead({
      ...BASE,
      key: 'wall-unified-web-portal-blocked-on-byoc-gates',
    });

    expect(receipt.slotIntentWarning).toBeDefined();
    expect(receipt.slotIntentWarning?.slot).toBe('wall');
    expect(receipt.slotIntentWarning?.matchedPrefix).toBe('wall-');
    expect(receipt.slotIntentWarning?.suggestedKey).toBe(
      'wall:unified-web-portal-blocked-on-byoc-gates',
    );
    expect(receipt.slotIntentWarning?.note).toContain("slot:'wall'");
  });

  it('WARNS WITHOUT ALTERING THE WRITE — the fact still lands under the caller\'s original key', async () => {
    const { receipt, writtenKey } = await assertAndRead({
      ...BASE,
      key: 'wall-unified-web-portal-blocked-on-byoc-gates',
    });

    // The disclosure fired...
    expect(receipt.slotIntentWarning).toBeDefined();
    // ...and the write happened anyway, unmodified. Rewriting the key here would
    // move the upsert target and fork the caller's fact on their next re-assert.
    expect(h.assertFact).toHaveBeenCalledTimes(1);
    expect(writtenKey).toBe('wall-unified-web-portal-blocked-on-byoc-gates');
    expect(receipt.ok).toBe(true);
  });

  it('stays silent when the caller passed slot — and the key IS normalized on that path', async () => {
    const { receipt, writtenKey } = await assertAndRead({
      ...BASE,
      key: 'unified-web-portal-blocked-on-byoc-gates',
      slot: 'wall',
    });

    expect(receipt.slotIntentWarning).toBeUndefined();
    expect(writtenKey).toBe('wall:unified-web-portal-blocked-on-byoc-gates');
  });

  it('stays silent on an already-canonical key asserted without slot (the WI-2141838 path)', async () => {
    const { receipt, writtenKey } = await assertAndRead({
      ...BASE,
      key: 'wall:unified-web-portal-blocked-on-byoc-gates',
    });

    expect(receipt.slotIntentWarning).toBeUndefined();
    expect(writtenKey).toBe('wall:unified-web-portal-blocked-on-byoc-gates');
  });

  it('CONTROL: an ordinary key that merely mentions a wall gets no warning', async () => {
    const { receipt } = await assertAndRead({ ...BASE, key: 'auth-401-is-not-an-owner-wall' });
    expect(receipt.slotIntentWarning).toBeUndefined();
  });

  it('does not treat generated guard-rail boilerplate as an authored absence claim', async () => {
    const body = 'The result-door spill is complete and retains every expected row and evidence field.';
    const { receipt, writtenBody } = await assertAndRead({
      ...BASE,
      key: 'result-door-spill-retains-evidence',
      body,
      slot: 'guard-rail',
    });

    expect(receipt.absenceWarning).toBeUndefined();
    expect(writtenBody).toBe(`🛡️ GUARD RAIL — do not repeat: ${body}`);
  });

  it('does not warn on a normative must-not rule that mentions a result', async () => {
    const body = 'Oversized metadata overflow must not refuse the result.';
    const { receipt, writtenBody } = await assertAndRead({
      ...BASE,
      key: 'metadata-overflow-must-not-refuse-result',
      body,
      slot: 'guard-rail',
    });

    expect(receipt.absenceWarning).toBeUndefined();
    expect(writtenBody).toBe(`🛡️ GUARD RAIL — do not repeat: ${body}`);
  });

  it('still warns when the guard-rail author actually makes an absence claim', async () => {
    const body = 'No membership exists for this agent.';
    const { receipt, writtenBody } = await assertAndRead({
      ...BASE,
      key: 'membership-absence-for-agent',
      body,
      slot: 'guard-rail',
    });

    expect(receipt.absenceWarning).toContain('"no" near "membership"');
    expect(writtenBody).toBe(`🛡️ GUARD RAIL — do not repeat: ${body}`);
  });
});
