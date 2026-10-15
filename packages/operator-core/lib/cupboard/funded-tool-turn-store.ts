/** Ordinary tool case of the existing monetary ledger (D-056). Inputs belong
 * to the authenticated host. This store never grants hosted funding authority. */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { createMicrochargeChannel, paymentVoucherDigest, type SignedUsageReceipt } from '../p2p/microcharge';
import { declareMeter, LocalMeteredTurn, usageReceiptSigningBytes,
  type LocalMeteredTurnState } from '../p2p/metered-invocation';
import type { HostedPerUseOffer, UsageReceiptWire } from './metered-invocation-door-io';

export interface FundedToolTurnBinding {
  readonly kind: 'tool';
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly principalId: string;
  /** Authenticated native session or app execution, never a dispatch call ID. */
  readonly executionId: string;
  readonly admissionId: string;
  readonly provenanceHash: string;
  readonly payer: string;
  readonly seller: string;
  readonly channelId: string;
  readonly offer: HostedPerUseOffer;
  readonly quantityCeiling: bigint;
  readonly expiresAtMs: number;
}
type StoredBinding = Omit<FundedToolTurnBinding, 'quantityCeiling'> & { quantityCeiling: string };
type StoredMeter = ReturnType<typeof encodeMeter>;
type Outbox = Omit<SignedUsageReceipt, 'meterQuantity' | 'amountMicros'> & {
  meterQuantity: string; amountMicros: string;
};
export interface FundedToolTurn {
  readonly turnId: string;
  readonly accountId: string;
  readonly revision: number;
  readonly state: 'prepared' | 'funded' | 'running' | 'closed' | 'settlement-pending' | 'settled';
  readonly binding: FundedToolTurnBinding;
  readonly fundingReceipt: UsageReceiptWire | null;
  readonly meterState: LocalMeteredTurnState | null;
  readonly usageEventKeys: readonly string[] | null;
  readonly closedAtMs: number | null;
  readonly settlementOutbox: Outbox | null;
}
export type FundedToolTurnResult = { ok: true; turn: FundedToolTurn } |
  { ok: false; code: string; detail: string };
interface Row {
  turn_id: string; account_id: string; revision: string | number;
  state: FundedToolTurn['state']; binding_hash: string; binding: StoredBinding;
  funding_receipt: UsageReceiptWire | null; local_meter_state: StoredMeter | null;
  usage_event_keys: string[] | null; closed_at_ms: string | number | null; settlement_outbox: Outbox | null;
}
const fail = (code: string, detail: string): Extract<FundedToolTurnResult, { ok: false }> => ({ ok: false, code, detail });
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const json = (value: unknown): Parameters<Sql['json']>[0] => JSON.parse(canonicalJson(value));
const storedBinding = (binding: FundedToolTurnBinding): StoredBinding =>
  ({ ...binding, quantityCeiling: String(binding.quantityCeiling) });
const accountId = (binding: FundedToolTurnBinding) => hash([binding.payer, binding.offer.offerId]);
const accountHash = (binding: FundedToolTurnBinding) => hash(['tool', binding.payer, binding.seller, binding.offer]);
export const fundedToolTurnId = (binding: FundedToolTurnBinding) =>
  hash(['tool-admission-v1', binding.workspaceId, binding.executionId, binding.admissionId, binding.offer.offerId]);
function encodeMeter(state: LocalMeteredTurnState) {
  return { ...state, ceilingMicros: String(state.ceilingMicros), reservedMicros: String(state.reservedMicros),
    meter: { ...state.meter, unitPriceMicros: String(state.meter.unitPriceMicros) },
    channel: { ...state.channel, escrowMicros: String(state.channel.escrowMicros), committedMicros: String(state.channel.committedMicros),
      lastCumulativeMicros: String(state.channel.lastCumulativeMicros),
      reservations: Object.fromEntries(Object.entries(state.channel.reservations).map(([key, value]) => [key, String(value)])) },
    units: Object.fromEntries(Object.entries(state.units).map(([key, entry]) => [key, { ...entry,
      voucher: { ...entry.voucher, meterQuantity: String(entry.voucher.meterQuantity),
        pricePerUnitMicros: String(entry.voucher.pricePerUnitMicros), cumulativeClaimMicros: String(entry.voucher.cumulativeClaimMicros) },
      receipt: entry.receipt ? { ...entry.receipt, meterQuantity: String(entry.receipt.meterQuantity),
        amountMicros: String(entry.receipt.amountMicros) } : null }])) };
}
function decodeMeter(state: StoredMeter): LocalMeteredTurnState {
  return { ...state, ceilingMicros: BigInt(state.ceilingMicros), reservedMicros: BigInt(state.reservedMicros),
    meter: { ...state.meter, unitPriceMicros: BigInt(state.meter.unitPriceMicros) },
    channel: { ...state.channel, escrowMicros: BigInt(state.channel.escrowMicros), committedMicros: BigInt(state.channel.committedMicros),
      lastCumulativeMicros: BigInt(state.channel.lastCumulativeMicros),
      reservations: Object.fromEntries(Object.entries(state.channel.reservations).map(([key, value]) => [key, BigInt(value)])) },
    units: Object.fromEntries(Object.entries(state.units).map(([key, entry]) => [key, { ...entry,
      voucher: { ...entry.voucher, meterQuantity: BigInt(entry.voucher.meterQuantity),
        pricePerUnitMicros: BigInt(entry.voucher.pricePerUnitMicros), cumulativeClaimMicros: BigInt(entry.voucher.cumulativeClaimMicros) },
      receipt: entry.receipt ? { ...entry.receipt, meterQuantity: BigInt(entry.receipt.meterQuantity),
        amountMicros: BigInt(entry.receipt.amountMicros) } : null }])) };
}
function fromRow(row: Row): FundedToolTurn {
  return { turnId: row.turn_id, accountId: row.account_id, revision: Number(row.revision), state: row.state,
    binding: { ...row.binding, quantityCeiling: BigInt(row.binding.quantityCeiling) }, fundingReceipt: row.funding_receipt,
    meterState: row.local_meter_state ? decodeMeter(row.local_meter_state) : null, usageEventKeys: row.usage_event_keys,
    closedAtMs: row.closed_at_ms === null ? null : Number(row.closed_at_ms), settlementOutbox: row.settlement_outbox };
}
function validate(binding: FundedToolTurnBinding) {
  const meter = declareMeter(binding.offer.terms);
  if (binding.kind !== 'tool' || [binding.workspaceId, binding.ownerId, binding.principalId, binding.executionId,
    binding.admissionId, binding.payer, binding.seller, binding.channelId, binding.offer.offerId,
    binding.offer.productId, binding.offer.skuRef].some(value => typeof value !== 'string' || !value.trim() || value.length > 2000) ||
    !/^[a-f0-9]{64}$/.test(binding.provenanceHash) || !Number.isSafeInteger(binding.expiresAtMs) || binding.expiresAtMs < 0 ||
    binding.quantityCeiling <= 0n || binding.quantityCeiling > 1000n || !binding.offer.active || !binding.offer.productActive ||
    binding.seller !== binding.offer.creatorId || !meter.ok || meter.meter.meterUnit !== 'tool-call') {
    return fail('invalid-tool-binding', 'an authenticated exact tool-call offer and bounded host turn are required');
  }
  return null;
}
function fundingMatches(turn: FundedToolTurn, receipt: UsageReceiptWire): boolean {
  const binding = turn.binding, offer = binding.offer, price = BigInt(offer.terms.unitPriceMicros);
  if (!receipt || receipt.state !== 'reserved' || receipt.channelId !== binding.channelId || receipt.usageNonce !== turn.turnId ||
    receipt.offerId !== offer.offerId || receipt.payer !== binding.payer || receipt.seller !== binding.seller ||
    receipt.releaseRef !== offer.skuRef || receipt.meterUnit !== 'tool-call' || receipt.priceVersion !== offer.terms.priceVersion ||
    receipt.splitManifestHash !== offer.terms.splitManifestHash || receipt.unitPriceMicros !== String(price) ||
    receipt.meterQuantity !== String(binding.quantityCeiling) || receipt.reservedMicros !== String(price * binding.quantityCeiling) ||
    receipt.expiresAtMs !== binding.expiresAtMs || receipt.amountMicros !== null || receipt.receiptSignature !== null ||
    receipt.settledAtMs !== null || receipt.identityInference !== undefined ||
    typeof receipt.voucherSignature !== 'string' || !receipt.voucherSignature.trim() ||
    !/^(0|[1-9]\d*)$/.test(receipt.cumulativeClaimMicros) || BigInt(receipt.cumulativeClaimMicros) < price * binding.quantityCeiling ||
    !Number.isSafeInteger(receipt.reservedAtMs) || receipt.reservedAtMs < 0 || receipt.reservedAtMs > binding.expiresAtMs) return false;
  return receipt.voucherDigest === paymentVoucherDigest({ channelId: binding.channelId, payer: binding.payer, seller: binding.seller,
    releaseRef: offer.skuRef, usageNonce: turn.turnId, meterQuantity: binding.quantityCeiling, pricePerUnitMicros: price,
    priceVersion: offer.terms.priceVersion, splitManifestHash: offer.terms.splitManifestHash,
    expiresAtMs: binding.expiresAtMs, cumulativeClaimMicros: BigInt(receipt.cumulativeClaimMicros) });
}

/** Same account-first locking and revision CAS as the identity ledger case.
 * No transaction remains open across signing, hosted IO or a tool handler. */
export class FundedToolTurnStore {
  constructor(private readonly sql: Sql) {}
  async read(workspaceId: string, turnId: string): Promise<FundedToolTurn | null> {
    const [row] = await this.sql<Row[]>`SELECT * FROM harness_shared.cupboard_funded_turns
      WHERE workspace_id = ${workspaceId} AND turn_id = ${turnId} AND binding->>'kind' = 'tool'`;
    return row ? fromRow(row) : null;
  }
  async readActive(binding: FundedToolTurnBinding): Promise<{ ok: true; turn: FundedToolTurn | null } | Extract<FundedToolTurnResult, { ok: false }>> {
    const invalid = validate(binding); if (invalid) return invalid;
    const [account] = await this.sql<{ binding_hash: string; active_turn_id: string | null }[]>`SELECT binding_hash, active_turn_id
      FROM harness_shared.cupboard_metered_accounts WHERE workspace_id = ${binding.workspaceId} AND account_id = ${accountId(binding)}`;
    if (!account) return { ok: true, turn: null };
    if (account.binding_hash !== accountHash(binding)) return fail('offer-binding-changed', 'payer/offer terms must remain immutable');
    if (!account.active_turn_id) return { ok: true, turn: null };
    const turn = await this.read(binding.workspaceId, account.active_turn_id);
    return turn ? { ok: true, turn } : fail('invalid-active-turn', 'the account has no exact durable tool turn');
  }
  async prepare(input: FundedToolTurnBinding): Promise<FundedToolTurnResult> {
    const binding = structuredClone(input), invalid = validate(binding); if (invalid) return invalid;
    const aid = accountId(binding), tid = fundedToolTurnId(binding), ah = accountHash(binding), bh = hash(storedBinding(binding));
    return await this.sql.begin(async tx => {
      await tx`INSERT INTO harness_shared.cupboard_metered_accounts (workspace_id, account_id, binding_hash)
        VALUES (${binding.workspaceId}, ${aid}, ${ah}) ON CONFLICT DO NOTHING`;
      const [account] = await tx<{ binding_hash: string; active_turn_id: string | null }[]>`SELECT binding_hash, active_turn_id
        FROM harness_shared.cupboard_metered_accounts WHERE workspace_id = ${binding.workspaceId} AND account_id = ${aid} FOR UPDATE`;
      if (account!.binding_hash !== ah) return fail('offer-binding-changed', 'the same payer/offer must retain immutable terms');
      const [old] = await tx<Row[]>`SELECT * FROM harness_shared.cupboard_funded_turns
        WHERE workspace_id = ${binding.workspaceId} AND turn_id = ${tid} FOR UPDATE`;
      if (old) return old.binding.kind === 'tool' && old.binding_hash === bh ? { ok: true as const, turn: fromRow(old) }
        : fail('turn-binding-changed', 'the host turn retains its original principal, payer, provenance and ceiling');
      if (account!.active_turn_id) return fail('account-turn-pending', 'reconcile the prior funded tool turn first');
      const [row] = await tx<Row[]>`INSERT INTO harness_shared.cupboard_funded_turns (workspace_id, turn_id, account_id, binding_hash, binding)
        VALUES (${binding.workspaceId}, ${tid}, ${aid}, ${bh}, ${tx.json(json(storedBinding(binding)))}) ON CONFLICT DO NOTHING RETURNING *`;
      if (!row) return fail('turn-binding-changed', 'another payer has already bound this host admission');
      await tx`UPDATE harness_shared.cupboard_metered_accounts SET active_turn_id = ${tid}, updated_at = now()
        WHERE workspace_id = ${binding.workspaceId} AND account_id = ${aid}`;
      return { ok: true as const, turn: fromRow(row) };
    }) as FundedToolTurnResult;
  }
  private async transition(workspaceId: string, turnId: string, revision: number,
    apply: (turn: FundedToolTurn) => FundedToolTurnResult): Promise<FundedToolTurnResult> {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) return fail('invalid-revision', 'bounded exact revision required');
    const prior = await this.read(workspaceId, turnId); if (!prior) return fail('unknown-turn', 'no durable tool turn exists');
    return await this.sql.begin(async tx => {
      const [account] = await tx<{ active_turn_id: string | null }[]>`SELECT active_turn_id FROM harness_shared.cupboard_metered_accounts
        WHERE workspace_id = ${workspaceId} AND account_id = ${prior.accountId} FOR UPDATE`;
      const [row] = await tx<Row[]>`SELECT * FROM harness_shared.cupboard_funded_turns
        WHERE workspace_id = ${workspaceId} AND turn_id = ${turnId} FOR UPDATE`;
      if (!row || row.binding.kind !== 'tool') return fail('unknown-turn', 'tool turn unavailable');
      if (Number(row.revision) !== revision) return fail('stale-turn', 'read authoritative local state before retrying');
      if (account!.active_turn_id !== turnId) return fail('inactive-turn', 'the account no longer holds this turn');
      const changed = apply(fromRow(row)); if (!changed.ok) return changed;
      const turn = changed.turn;
      const [saved] = await tx<Row[]>`UPDATE harness_shared.cupboard_funded_turns SET revision = revision + 1, state = ${turn.state},
        funding_receipt = ${turn.fundingReceipt ? tx.json(json(turn.fundingReceipt)) : null},
        local_meter_state = ${turn.meterState ? tx.json(json(encodeMeter(turn.meterState))) : null},
        usage_event_keys = ${turn.usageEventKeys ? tx.json([...turn.usageEventKeys]) : null}, closed_at_ms = ${turn.closedAtMs},
        settlement_outbox = ${turn.settlementOutbox ? tx.json(json(turn.settlementOutbox)) : null}, updated_at = now()
        WHERE workspace_id = ${workspaceId} AND turn_id = ${turnId} AND revision = ${revision} RETURNING *`;
      if (!saved) return fail('stale-turn', 'the local revision moved');
      if (turn.state === 'settled') await tx`UPDATE harness_shared.cupboard_metered_accounts SET active_turn_id = NULL, updated_at = now()
        WHERE workspace_id = ${workspaceId} AND account_id = ${turn.accountId}`;
      return { ok: true as const, turn: fromRow(saved) };
    }) as FundedToolTurnResult;
  }
  confirmFunding(workspaceId: string, turnId: string, revision: number, receipt: UsageReceiptWire): Promise<FundedToolTurnResult> {
    const copy = structuredClone(receipt);
    return this.transition(workspaceId, turnId, revision, turn => {
      if (!['prepared', 'funded'].includes(turn.state)) return fail('invalid-turn-state', 'only an unentered turn may confirm funding');
      if (!fundingMatches(turn, copy) || (turn.fundingReceipt && canonicalJson(turn.fundingReceipt) !== canonicalJson(copy)))
        return fail('funding-binding-mismatch', 'hosted reservation must prove the exact immutable tool turn');
      return { ok: true, turn: { ...turn, state: 'funded', fundingReceipt: copy } };
    });
  }
  enter(workspaceId: string, turnId: string, revision: number, input: FundedToolTurnBinding, nowMs: number): Promise<FundedToolTurnResult> {
    const binding = storedBinding(structuredClone(input));
    return this.transition(workspaceId, turnId, revision, turn => {
      if (turn.state !== 'funded') return fail('invalid-turn-state', 'only one process may enter an unentered funded tool turn');
      if (hash(binding) !== hash(storedBinding(turn.binding))) return fail('turn-binding-changed', 'immutable host admission required');
      if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > turn.binding.expiresAtMs) return fail('turn-expired', 'funded deadline passed');
      const meter = declareMeter(turn.binding.offer.terms); if (!meter.ok) return meter;
      const ceiling = turn.binding.quantityCeiling * meter.meter.unitPriceMicros;
      const meterState: LocalMeteredTurnState = { turnId, payer: turn.binding.payer, seller: turn.binding.seller,
        releaseRef: turn.binding.offer.skuRef, meter: meter.meter, ceilingMicros: ceiling, expiresAtMs: turn.binding.expiresAtMs,
        reservedMicros: 0n, channel: createMicrochargeChannel('local-tool-turn:' + turnId, ceiling), units: {} };
      return { ok: true, turn: { ...turn, state: 'running', meterState } };
    });
  }
  persistMeter(workspaceId: string, turnId: string, revision: number, snapshot: LocalMeteredTurnState): Promise<FundedToolTurnResult> {
    const state = structuredClone(snapshot);
    return this.transition(workspaceId, turnId, revision, turn => {
      if (turn.state !== 'running' || !turn.meterState) return fail('invalid-turn-state', 'local usage requires an entered turn');
      const immutable = (value: LocalMeteredTurnState) => encodeMeter({ ...value, units: {}, reservedMicros: 0n,
        admissionClosed: false, channel: createMicrochargeChannel(value.channel.channelId, value.channel.escrowMicros) });
      if (canonicalJson(immutable(state)) !== canonicalJson(immutable(turn.meterState)) ||
        (turn.meterState.admissionClosed && !state.admissionClosed) || Object.values(state.units).some(entry => entry.voucher.meterQuantity !== 1n) ||
        Object.entries(turn.meterState.units).some(([key, old]) => {
          const next = state.units[key];
          return !next || canonicalJson(encodeMeter({ ...state, units: { [key]: next } }).units[key]!.voucher) !==
            canonicalJson(encodeMeter({ ...state, units: { [key]: old } }).units[key]!.voucher) ||
            (old.completedAtMs !== null && next.completedAtMs !== old.completedAtMs) ||
            (old.receipt !== null && canonicalJson(encodeMeter({ ...state, units: { [key]: next } }).units[key]!.receipt) !==
              canonicalJson(encodeMeter({ ...state, units: { [key]: old } }).units[key]!.receipt));
        }) || (turn.meterState.admissionClosed && Object.keys(state.units).length !== Object.keys(turn.meterState.units).length)) {
        return fail('local-meter-binding-mismatch', 'local usage cannot change funding, reopen admission or replace an entered unit');
      }
      try { new LocalMeteredTurn({ state, nowMs: () => 0, signVoucher: () => '', signReceipt: () => '', persist: async () => {} }); }
      catch { return fail('invalid-local-meter', 'local voucher/receipt/channel snapshot is inconsistent'); }
      return { ok: true, turn: { ...turn, meterState: state } };
    });
  }
  close(workspaceId: string, turnId: string, revision: number, closedAtMs: number): Promise<FundedToolTurnResult> {
    return this.transition(workspaceId, turnId, revision, turn => {
      const state = turn.meterState;
      if (turn.state !== 'running' || !state?.admissionClosed || !Number.isSafeInteger(closedAtMs) || closedAtMs < 0)
        return fail('invalid-closed-turn', 'stop admission durably before closing the exact turn');
      if (Object.values(state.units).some(entry => entry.completedAtMs === null || !entry.receipt || entry.completedAtMs > closedAtMs))
        return fail('tool-completion-unconfirmed', 'every admitted unit needs a durable completed receipt; retain uncertain holds');
      return { ok: true, turn: { ...turn, state: 'closed', usageEventKeys: Object.keys(state.units).sort(), closedAtMs } };
    });
  }
  async stageSettlement(workspaceId: string, turnId: string, revision: number,
    sign: (bytes: Buffer) => Promise<string> | string): Promise<FundedToolTurnResult> {
    const turn = await this.read(workspaceId, turnId); if (!turn) return fail('unknown-turn', 'no durable tool turn exists');
    if (turn.state !== 'closed' || turn.revision !== revision) return fail('invalid-turn-state', 'an exact closed population is required');
    const quantity = BigInt(turn.usageEventKeys!.length), amount = quantity * BigInt(turn.binding.offer.terms.unitPriceMicros);
    if (amount !== turn.meterState!.reservedMicros) return fail('local-population-mismatch', 'actual usage must cover every durable served unit');
    const unsigned = { channelId: turn.binding.channelId, usageNonce: turnId, meterQuantity: quantity, amountMicros: amount,
      voucherDigest: turn.fundingReceipt!.voucherDigest, occurredAtMs: turn.closedAtMs! };
    const signature = await sign(usageReceiptSigningBytes(unsigned));
    if (typeof signature !== 'string' || !signature.trim()) return fail('unsigned-receipt', 'seller signature required');
    const outbox: Outbox = { ...unsigned, meterQuantity: String(quantity), amountMicros: String(amount), signature };
    return this.transition(workspaceId, turnId, revision, current => current.state === 'closed'
      ? { ok: true, turn: { ...current, state: 'settlement-pending', settlementOutbox: outbox } }
      : fail('stale-turn', 'the closed population moved while signing'));
  }
  acknowledgeSettlement(workspaceId: string, turnId: string, revision: number, hosted: UsageReceiptWire): Promise<FundedToolTurnResult> {
    const receipt = structuredClone(hosted);
    return this.transition(workspaceId, turnId, revision, turn => {
      if (turn.state !== 'settlement-pending') return fail('invalid-turn-state', 'signed outbox required');
      const outbox = turn.settlementOutbox!;
      const expected = { ...turn.fundingReceipt!, state: 'settled', meterQuantity: outbox.meterQuantity,
        amountMicros: outbox.amountMicros, receiptSignature: outbox.signature, settledAtMs: outbox.occurredAtMs };
      if (canonicalJson(receipt) !== canonicalJson(expected)) return fail('settlement-binding-mismatch', 'hosted ack must match the original voucher and exact signed usage');
      return { ok: true, turn: { ...turn, state: 'settled' } };
    });
  }
}
