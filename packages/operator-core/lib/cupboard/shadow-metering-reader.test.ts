/**
 * agent-economy-flywheel P-003 (E1, WI-10004287), clause AUTO-BAR-R-12:
 * "Generating shadow statements creates no payment voucher."
 *
 * The reader is the only part of shadow metering that touches Postgres, so the clause holds
 * exactly when every statement the reader can issue is a read. This drives the full
 * `readShadowStatement` path through a recording fake `sql` that answers the two queries with
 * representative rows (so pricing runs end to end, not just the empty path) and asserts:
 *   - only the plain tagged-template call is used: any other client method (`begin`, `unsafe`,
 *     `json`, `listen`, `notify`, ...) throws, so a transaction or raw write cannot slip in;
 *   - every issued statement is a read, and none names a voucher, payment, ledger or channel
 *     relation;
 *   - the statement still carries a non-zero would-have-charged amount, so "no voucher" is not
 *     the vacuous result of pricing nothing.
 * The write detector has its own positive controls so it cannot pass by matching nothing.
 *
 * The integration test (`shadow-metering-reader.integration.test.ts`) covers the SQL against
 * real migrations; this file covers the "no write" property at the unit layer the clause names.
 */
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { readIdentityOutcomeCost, readIdentityTurnBilledCost, readShadowStatement, shadowMonthBounds, type IdentityTurnUsageBinding,
  type IdentityMessageUsageBinding, type OutcomeWorkItem } from './shadow-metering-reader';
import type { FundedIdentityTurn } from './funded-turn-store';
import { identityPerUseOfferTerms, quoteIdentityInferenceTurn } from './identity-per-use-offer';

/** A write verb or side-effecting function anywhere in the statement. */
const WRITE_RE =
  /\b(insert|update|delete|merge|upsert|truncate|copy|call|create|alter|drop|grant|revoke|lock|vacuum|refresh|nextval|setval|pg_notify|lo_import|lo_unlink|set_config)\b/i;
/** Relations a payment or voucher would be written to. */
const PAYMENT_RE = /voucher|payment|ledger|channel|invoice|charge_|settle/i;

function isReadOnlyStatement(text: string): boolean {
  const trimmed = text.trim();
  return /^(select|with)\b/i.test(trimmed) && !WRITE_RE.test(trimmed) && !PAYMENT_RE.test(trimmed);
}

interface Recorded {
  text: string;
  values: unknown[];
}

describe('exact turn billed-cost evidence', () => {
  const key = 'a'.repeat(64);
  const binding: IdentityTurnUsageBinding = { workspaceId: 'workspace', ownerId: 'owner', principalId: 'payer',
    nativeSessionId: 'native-session', nativeTurnId: 'turn', specificationRevision: 'spec', stateRevision: 'state',
    usageEventKeys: [key] };
  const row = { usage_event_key: key, sample_id: '101', activation_event_id: '7', session_id: 'native-session',
    turn_id: 'turn', owner_id: 'owner', principal_id: 'payer', specification_revision: 'spec', state_revision: 'state',
    cost_source: 'provider', cost_bound: null, cost_micros: '999.000000' };
  const read = (rows: unknown[], input = binding) => readIdentityTurnBilledCost(recordingSql(() => rows).sql, input);

  it('reads an exact expected population, keeps integer cost and retained evidence identities', async () => {
    const { sql, calls } = recordingSql(() => [row]);
    expect(await readIdentityTurnBilledCost(sql, binding)).toEqual({ ok: true, billedInferenceMicros: 999n,
      samples: [{ usageEventKey: key, sampleId: '101', activationEventId: '7', billedInferenceMicros: '999' }] });
    expect(calls[0]!.text).toContain('agent_usage_samples_identity_attribution');
    expect(calls[0]!.values).toEqual(['workspace', [key]]);
    expect(isReadOnlyStatement(calls[0]!.text)).toBe(true);
  });
  it('retains distinct billed amounts for multiple requests in one native turn', async () => {
    const secondKey = 'b'.repeat(64);
    expect(await read([row, { ...row, usage_event_key: secondKey, sample_id: '102', cost_micros: '1001' }],
      { ...binding, usageEventKeys: [key, secondKey] })).toEqual({ ok: true, billedInferenceMicros: 2000n,
      samples: [{ usageEventKey: key, sampleId: '101', activationEventId: '7', billedInferenceMicros: '999' },
        { usageEventKey: secondKey, sampleId: '102', activationEventId: '7', billedInferenceMicros: '1001' }] });
  });

  const messageBinding: IdentityMessageUsageBinding = { workspaceId: 'workspace', ownerId: 'owner', principalId: 'payer',
    nativeSessionId: 'native-session', nativeMessageId: 'msg-provider', specificationRevision: 'spec',
    stateRevision: 'state', usageEventKeys: [key] };
  const messageRow = { ...row, turn_id: null, provider_response_id: 'msg-provider',
    source_id: 'message:msg-provider', response_id_source: 'native-message-id', adapter: 'claude-iso-2' };

  it('bills a canonical Claude message without inventing a native turn', async () => {
    const { sql, calls } = recordingSql(() => [messageRow]);
    expect(await readIdentityTurnBilledCost(sql, messageBinding)).toEqual({ ok: true, billedInferenceMicros: 999n,
      samples: [{ usageEventKey: key, sampleId: '101', activationEventId: '7', billedInferenceMicros: '999' }] });
    expect(calls[0]!.text).toContain("usage_provenance->>'providerResponseId'");
    expect(isReadOnlyStatement(calls[0]!.text)).toBe(true);
  });

  it('rejects mismatched Claude message provenance, fabricated turns and foreign identity', async () => {
    for (const bad of [{ provider_response_id: null }, { provider_response_id: 'msg-other' },
      { source_id: 'message:msg-other' }, { source_id: 'line:0' }, { response_id_source: 'native-token-usage-record' },
      { adapter: 'codex' }, { adapter: null }, { turn_id: 'invented-turn' }, { owner_id: 'other' }]) {
      expect(await readIdentityTurnBilledCost(recordingSql(() => [{ ...messageRow, ...bad }]).sql, messageBinding))
        .toMatchObject({ ok: false, code: 'identity-usage-binding-mismatch' });
    }
  });

  it('refuses ambiguous or incomplete message bindings before querying', async () => {
    const { sql, calls } = recordingSql(() => [messageRow]);
    for (const bad of [{ nativeMessageId: '' }, { nativeMessageId: ' ' }, { nativeMessageId: null },
      { nativeTurnId: 'turn' }, { usageEventKeys: [key, 'b'.repeat(64)] }]) {
      expect(await readIdentityTurnBilledCost(sql, { ...messageBinding, ...bad } as never))
        .toMatchObject({ ok: false, code: 'identity-usage-invalid-binding' });
    }
    expect(calls).toHaveLength(0);
  });

  it('pins the exact message identity and event population before async IO', async () => {
    const input = { ...messageBinding, usageEventKeys: [key] };
    const { sql } = recordingSql(() => { input.nativeMessageId = 'msg-other'; input.usageEventKeys[0] = 'b'.repeat(64); return [messageRow]; });
    expect(await readIdentityTurnBilledCost(sql, input)).toMatchObject({ ok: true, billedInferenceMicros: 999n });
  });

  it('refuses each changed identity, principal and native-turn binding', async () => {
    for (const field of ['activation_event_id', 'session_id', 'turn_id', 'owner_id', 'principal_id',
      'specification_revision', 'state_revision']) {
      expect(await read([{ ...row, [field]: null }])).toMatchObject({ ok: false, code: 'identity-usage-binding-mismatch' });
      if (field !== 'activation_event_id') {
        expect(await read([{ ...row, [field]: 'other' }])).toMatchObject({ ok: false, code: 'identity-usage-binding-mismatch' });
      }
    }
  });

  it('refuses estimates, missing money, negative, fractional and nonfinite costs', async () => {
    for (const bad of [{ cost_source: 'estimated' }, { cost_source: null }, { cost_bound: 'lower' },
      ...[null, '-1', '0.1', 'NaN', 'Infinity'].map((cost_micros) => ({ cost_micros }))]) {
      expect(await read([{ ...row, ...bad }])).toMatchObject({ ok: false, code: 'identity-usage-not-bill-grade' });
    }
    expect(await read([{ ...row, cost_micros: '0' }])).toMatchObject({ ok: true, billedInferenceMicros: 0n });
    expect(await read([{ ...row, cost_micros: '9007199254740993' }]))
      .toMatchObject({ ok: true, billedInferenceMicros: 9007199254740993n });
  });

  it('refuses missing, repeated and unexpected usage events instead of treating them as zero', async () => {
    expect(await read([])).toMatchObject({ ok: false, code: 'identity-usage-incomplete' });
    const secondKey = 'b'.repeat(64);
    expect(await read([row, row], { ...binding, usageEventKeys: [key, secondKey] }))
      .toMatchObject({ ok: false, code: 'identity-usage-incomplete' });
    expect(await read([{ ...row, usage_event_key: secondKey }]))
      .toMatchObject({ ok: false, code: 'identity-usage-incomplete' });
  });

  it('refuses an empty, duplicate or malformed expected population before reading', async () => {
    const { sql, calls } = recordingSql(() => [row]);
    for (const usageEventKeys of [[], [key, key], ['invalid'], Array(1001).fill(key)]) {
      expect(await readIdentityTurnBilledCost(sql, { ...binding, usageEventKeys }))
        .toMatchObject({ ok: false, code: 'identity-usage-invalid-binding' });
    }
    expect(await readIdentityTurnBilledCost(sql, { ...binding, principalId: '' }))
      .toMatchObject({ ok: false, code: 'identity-usage-invalid-binding' });
    expect(calls).toHaveLength(0);
  });

  it('pins the expected binding across async IO and refuses an unavailable authority', async () => {
    const input = { ...binding, usageEventKeys: [key] };
    const { sql } = recordingSql(() => { input.principalId = 'other'; input.usageEventKeys[0] = 'b'.repeat(64); return [row]; });
    expect(await readIdentityTurnBilledCost(sql, input)).toMatchObject({ ok: true, billedInferenceMicros: 999n });
    const failing = (() => Promise.reject(new Error('unavailable'))) as unknown as Sql;
    expect(await readIdentityTurnBilledCost(failing, binding))
      .toMatchObject({ ok: false, code: 'identity-usage-unavailable' });
  });
});

describe('current graded outcome cost from exact local funded usage', () => {
  const offered = identityPerUseOfferTerms({ identity: { id: 'engineer', version: '1.2.0' }, markupBps: 2500 });
  if (!offered.ok) throw new Error(offered.detail);
  const offer = offered.terms;
  const scope = { workspaceId: 'workspace', releaseRef: offer.skuRef };
  const sql = recordingSql(() => []).sql;
  const outcome = (): OutcomeWorkItem => ({ id: 'WI-1', harness: 'papercusp', kind: 'feature', payload: {}, state: 'done',
    terminalOwner: 'owner', terminalCompletionRef: 'completion-1', completionAuthority: 'committed' as const,
    terminalCompletionEvidence: { verifiedHow: 'integration', testsRun: 'vitest', testResult: 'passed' } });
  function turn(n = 1, workItem = 'WI-1', billed = 999n): FundedIdentityTurn {
    const quote = quoteIdentityInferenceTurn({ offer, billedInferenceMicros: billed, inferenceCeilingMicros: billed });
    if (!quote.ok) throw new Error(quote.detail);
    const id = String(n), key = id.padStart(64, '0');
    const receipt = { channelId: 'channel', usageNonce: id, meterQuantity: String(quote.reservationQuantity),
      amountMicros: String(quote.amountMicros), voucherDigest: 'digest', occurredAtMs: 3, signature: 'seller-signature' };
    return { turnId: id, accountId: 'account', revision: 6, state: 'settled',
      binding: { workspaceId: 'workspace', ownerId: 'owner', principalId: 'payer', nativeSessionId: 'session', nativeTurnId: id,
        specificationRevision: 'spec', stateRevision: 'state', workItem: { id: workItem, harness: 'papercusp' },
        payer: 'payer', seller: 'seller', offerId: 'offer', channelId: 'channel', offer,
        inferenceCeilingMicros: billed, expiresAtMs: 100 },
      usageEventKeys: [key], closedAtMs: 3,
      fundingReceipt: { ...receipt, payer: 'payer', seller: 'seller', releaseRef: offer.skuRef,
        priceVersion: offer.priceVersion, splitManifestHash: offer.splitManifestHash, offerId: 'offer', meterUnit: offer.meterUnit,
        unitPriceMicros: String(offer.unitPriceMicros), reservedMicros: String(quote.reservedMarkupMicros), amountMicros: null,
        cumulativeClaimMicros: String(quote.reservedMarkupMicros), expiresAtMs: 100, voucherDigest: 'digest',
        voucherSignature: 'payer-signature', receiptSignature: null, state: 'reserved', reservedAtMs: 1, settledAtMs: null },
      settlementOutbox: { billedInferenceMicros: String(billed), priorRemainderNumerator: '0',
        remainderNumerator: String(quote.remainderNumerator), receipt,
        samples: [{ usageEventKey: key, sampleId: id, activationEventId: id, billedInferenceMicros: String(billed) }] } };
  }
  const dependencies = (turns = [turn()]) => ({
    readTurns: async () => turns,
    readWorkItem: async (ref: { id: string }) => ({ ...outcome(), id: ref.id }),
    readBilled: async (_sql: Sql, input: IdentityTurnUsageBinding) => ({ ok: true as const,
      billedInferenceMicros: BigInt(turns.find(t => t.binding.nativeTurnId === input.nativeTurnId)!.settlementOutbox!.billedInferenceMicros),
      samples: turns.find(t => t.binding.nativeTurnId === input.nativeTurnId)!.settlementOutbox!.samples }),
    grade: async () => ({ ok: true as const, applicable: true as const, checked: ['accepted-clause@1'] }),
  });
  const read = (turns = [turn()], deps = {}) => readIdentityOutcomeCost(sql, scope, { ...dependencies(turns), ...deps });

  it('counts work items once, includes settled markup, and retains exact cost and grading references', async () => {
    const result = await read([turn(1), turn(2)]);
    expect(result).toMatchObject({ status: 'verified', costPerAcceptedOutcomeMicros: '2496', totalCostMicros: '2496',
      acceptedOutcomes: 1, totalOutcomes: 1, turns: 2, basis: 'local-funded-release-usage' });
    if (result.status !== 'verified') throw new Error(result.reason);
    expect(result.evidenceRefs).toContain('graded-clause:accepted-clause@1');
    expect(result.evidenceRefs).toContain('funded-identity-turn:2');
  });
  it('includes unsuccessful spend in the numerator and rounds up the exact average', async () => {
    expect(await read([turn(1, 'WI-1', 1n), turn(2, 'WI-2', 1n), turn(3, 'WI-3', 1n)], {
      readWorkItem: async (ref: { id: string }) => ({ ...outcome(), id: ref.id, state: ref.id === 'WI-3' ? 'dropped' : 'done' }),
    })).toMatchObject({ status: 'verified', totalCostMicros: '3', acceptedOutcomes: 2, totalOutcomes: 3,
      costPerAcceptedOutcomeMicros: '2' });
  });
  it('refuses empty and overflowing populations, legacy attribution and every non-settled phase', async () => {
    expect(await read([])).toMatchObject({ status: 'unavailable', reason: 'no-funded-usage' });
    expect(await read(Array(501).fill(turn()))).toMatchObject({ reason: 'population-limit' });
    const unlinked = turn(); delete (unlinked.binding as { workItem?: unknown }).workItem;
    expect(await read([unlinked])).toMatchObject({ reason: 'unlinked-outcome' });
    for (const state of ['prepared', 'funded', 'running', 'closed', 'settlement-pending'] as const)
      expect(await read([{ ...turn(), state }])).toMatchObject({ reason: 'unsettled-turn' });
  });
  it('refuses wrong scope, duplicate turns and usage events shared across outcomes', async () => {
    expect(await read([turn(), turn()])).toMatchObject({ reason: 'population-binding-mismatch' });
    expect(await read([{ ...turn(), binding: { ...turn().binding, workspaceId: 'other' } }]))
      .toMatchObject({ reason: 'population-binding-mismatch' });
    const original = turn(2, 'WI-2');
    const second = { ...original, usageEventKeys: turn().usageEventKeys,
      settlementOutbox: { ...original.settlementOutbox!, samples: turn().settlementOutbox!.samples } };
    expect(await read([turn(), second])).toMatchObject({ reason: 'usage-population-mismatch' });
  });
  it('refuses estimates, changed billed cost and changed immutable settlement evidence', async () => {
    expect(await read([turn()], { readBilled: async () => ({ ok: false, code: 'identity-usage-not-bill-grade' }) }))
      .toMatchObject({ reason: 'identity-usage-not-bill-grade' });
    expect(await read([turn()], { readBilled: async () => ({ ok: true, billedInferenceMicros: 998n, samples: turn().settlementOutbox!.samples }) }))
      .toMatchObject({ reason: 'billed-cost-mismatch' });
    const original = turn(); const bad = { ...original, settlementOutbox: { ...original.settlementOutbox!,
      receipt: { ...original.settlementOutbox!.receipt, amountMicros: '1' } } };
    expect(await read([bad])).toMatchObject({ reason: 'settlement-evidence-mismatch' });
  });
  it('requires an exact current accepted completion by the funded owner with sufficient evidence', async () => {
    for (const patch of [{ id: 'WI-other' }, { harness: 'other' }, { state: 'wip' }, { terminalOwner: 'other' },
      { terminalCompletionRef: null }, { completionAuthority: 'proposed' }, { terminalCompletionEvidence: null }]) {
      expect(await read([turn()], { readWorkItem: async () => ({ ...outcome(), ...patch }) }))
        .toMatchObject({ status: 'unavailable', costPerAcceptedOutcomeMicros: null });
    }
    expect(await read([turn()], { readWorkItem: async () => ({ ...outcome(), state: 'dropped' }) }))
      .toMatchObject({ reason: 'no-accepted-outcomes' });
  });
  it('requires nonempty applicable current grading and refuses manual exemptions or a failed audit', async () => {
    for (const grade of [{ ok: true, applicable: false, checked: [] }, { ok: true, applicable: true, checked: [] },
      { ok: true, applicable: true, checked: ['clause'], exempted: ['manual'] },
      { ok: false, applicable: true, checked: ['clause'], retryable: true, reason: 'audit failed' }])
      expect(await read([turn()], { grade: async () => grade })).toMatchObject({ reason: 'grading-unverified' });
    expect(await read([turn()], { grade: async () => { throw new Error('database unavailable'); } }))
      .toMatchObject({ reason: 'evidence-unavailable' });
  });
  it('pins caller scope across asynchronous population reads', async () => {
    const input = { ...scope };
    const deps = dependencies();
    expect(await readIdentityOutcomeCost(sql, input, { ...deps, readTurns: async () => {
      input.workspaceId = 'other'; input.releaseRef = 'identity-release:other@1.0.0'; return [turn()];
    } })).toMatchObject({ status: 'verified', releaseRef: scope.releaseRef });
  });
});

/** A `sql` stand-in that records every tagged-template call and refuses any other method. */
function recordingSql(answer: (text: string) => unknown[]): { sql: Sql; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('$?');
    calls.push({ text, values });
    return Promise.resolve(answer(text));
  };
  const sql = new Proxy(tag, {
    get(_target, prop) {
      throw new Error(`shadow metering reader used sql.${String(prop)}; only read queries are allowed`);
    },
  });
  return { sql: sql as unknown as Sql, calls };
}

const USAGE_ROWS = [
  {
    attributed: true,
    agent: 'claude',
    profile: 'papercusp-engineer',
    spec_layers: ['domain:papercusp-engineer'],
    axis_layers: [],
    cost_source: 'provider',
    cost_usd: '1.000000',
    samples: '10',
  },
  {
    attributed: false,
    agent: null,
    profile: null,
    spec_layers: null,
    axis_layers: null,
    cost_source: 'estimated',
    cost_usd: '0.500000',
    samples: '4',
  },
];
const TOOL_ROWS = [
  { attributed: true, calls: '7' },
  { attributed: false, calls: '3' },
];

function answer(text: string): unknown[] {
  // D-018 point 4: the cost-basis read (the only one that names the price stamp).
  if (text.includes('price_table_version')) return [{ samples: '12', stale: '0', unpriced: '0', lower_bound: '0' }];
  return text.includes('tool_invocations_identity_attribution') ? TOOL_ROWS : USAGE_ROWS;
}

describe('shadowMonthBounds preserves literal UTC calendar years', () => {
  it.each([
    ['0000-01', '0000-01-01T00:00:00.000Z', '0000-02-01T00:00:00.000Z', 31],
    ['0000-02', '0000-02-01T00:00:00.000Z', '0000-03-01T00:00:00.000Z', 29],
    ['0099-12', '0099-12-01T00:00:00.000Z', '0100-01-01T00:00:00.000Z', 31],
    ['0100-02', '0100-02-01T00:00:00.000Z', '0100-03-01T00:00:00.000Z', 28],
    ['1900-02', '1900-02-01T00:00:00.000Z', '1900-03-01T00:00:00.000Z', 28],
    ['2000-02', '2000-02-01T00:00:00.000Z', '2000-03-01T00:00:00.000Z', 29],
    ['2026-12', '2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 31],
    ['9999-12', '9999-12-01T00:00:00.000Z', '+010000-01-01T00:00:00.000Z', 31],
  ])('%s selects the literal year and exclusive next month', (month, start, end, days) => {
    const bounds = shadowMonthBounds(month);
    expect(new Date(bounds.startMs).toISOString()).toBe(start);
    expect(new Date(bounds.endMs).toISOString()).toBe(end);
    expect(bounds.endMs - bounds.startMs).toBe(days * 86_400_000);
  });

  it.each(['99-12', '0099-00', '0099-13', '2026-2', ' 2026-02', '2026-02-01'])('rejects invalid month %j', month => {
    expect(() => shadowMonthBounds(month)).toThrow(/YYYY-MM/);
  });

  it('uses literal year boundaries in every shadow statement query', async () => {
    const { sql, calls } = recordingSql(answer);
    await readShadowStatement(sql, { workspaceId: 'ws-1', month: '0099-12' });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const bounds = call.values.filter((value): value is number => typeof value === 'number');
      expect(bounds.map(value => new Date(value).toISOString())).toEqual(['0099-12-01T00:00:00.000Z', '0100-01-01T00:00:00.000Z']);
    }
  });
});

describe('readShadowStatement issues no writes (AUTO-BAR-R-12)', () => {
  it('detects writes and payment relations (positive controls for the detector)', () => {
    expect(isReadOnlyStatement('SELECT 1 FROM harness_shared.agent_usage_samples')).toBe(true);
    expect(isReadOnlyStatement('WITH s AS (SELECT 1) SELECT * FROM s')).toBe(true);
    expect(isReadOnlyStatement('INSERT INTO harness_shared.cupboard_vouchers VALUES (1)')).toBe(false);
    expect(isReadOnlyStatement('WITH v AS (INSERT INTO t VALUES (1) RETURNING 1) SELECT * FROM v')).toBe(false);
    expect(isReadOnlyStatement('SELECT nextval(\'harness_shared.seq\')')).toBe(false);
    expect(isReadOnlyStatement('SELECT * FROM harness_shared.payment_channels')).toBe(false);
    expect(isReadOnlyStatement('SELECT pg_notify(\'x\', \'y\')')).toBe(false);
  });

  it('prices a workspace-month using only read queries and names no payment relation', async () => {
    const { sql, calls } = recordingSql(answer);
    const statement = await readShadowStatement(sql, { workspaceId: 'ws-1', month: '2026-09' });

    // usage + tool calls + the D-018 cost basis.
    expect(calls).toHaveLength(3);
    expect(statement.costBasis).toMatchObject({ samples: 12, staleSamples: 0, unpricedSamples: 0 });
    for (const call of calls) {
      expect(isReadOnlyStatement(call.text), call.text).toBe(true);
      expect(call.values).toContain('ws-1');
    }
    // Pricing really ran: the attributed spec-layer line produced a markup to (not) charge.
    expect(statement.totals.wouldHaveChargedMicros).toBe(200_000);
    expect(statement.totals.wouldHaveChargedMicros).toBe(statement.totals.markupMicros);
    expect(statement.zeroPriced.toolCalls).toEqual({ attributed: 7, unattributed: 3 });
  });

  it('uses no client method other than a plain query, so no transaction or raw write is possible', async () => {
    const { sql } = recordingSql(answer);
    expect(() => (sql as unknown as { begin: unknown }).begin).toThrow(/sql\.begin/);
    expect(() => (sql as unknown as { unsafe: unknown }).unsafe).toThrow(/sql\.unsafe/);
    // The full read path completes under that refusal.
    await expect(readShadowStatement(sql, { workspaceId: 'ws-1', month: '2026-09' })).resolves.toBeDefined();
  });
});
