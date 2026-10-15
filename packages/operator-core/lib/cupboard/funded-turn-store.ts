/**
 * P-017/D-043 local persistence edge. Bindings, closed usage populations and
 * hosted receipts come only from an authenticated host, never tool arguments.
 * This store elects local execution; hosted admission must finish before
 * confirmFunding. An uncertain reservation stays prepared until reconciled.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { paymentVoucherDigest, type CumulativePaymentVoucher,
  type SignedUsageReceipt } from '../p2p/microcharge';
import { usageReceiptSigningBytes } from '../p2p/metered-invocation';
import { quoteIdentityInferenceTurn, type IdentityPerUseOfferTerms } from './identity-per-use-offer';
import type { UsageReceiptWire, IdentityMarkupOriginWire } from './metered-invocation-door-io';
import { readIdentityTurnBilledCost, type IdentityTurnUsageBinding,
  type IdentityTurnBilledCost } from './shadow-metering-reader';

/** Attribution supplied by the authenticated host, never a command argument. */
export interface IdentityWorkItemBinding {
  readonly id: string;
  readonly harness: string;
}
export function isIdentityWorkItemBinding(value: unknown): value is IdentityWorkItemBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return Object.keys(ref).length === 2 && typeof ref.id === 'string' && ref.id.length <= 200 &&
    /^(?:WI|EI|F)-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ref.id) &&
    typeof ref.harness === 'string' && /^[a-z0-9][a-z0-9._-]{0,119}$/.test(ref.harness);
}

export interface FundedIdentityTurnBinding extends Omit<IdentityTurnUsageBinding, 'usageEventKeys' | 'nativeTurnId'> {
  /** Missing on legacy/unlinked turns; absence cannot prove an accepted outcome. */
  readonly workItem?: IdentityWorkItemBinding;
  /** Host admission nonce, distinct from the backend's eventual usage identity. */
  readonly admissionId?: string;
  readonly nativeTurnId: string | null;
  readonly payer: string;
  readonly seller: string;
  readonly offerId: string;
  readonly channelId: string;
  readonly offer: IdentityPerUseOfferTerms;
  readonly inferenceCeilingMicros: bigint;
  readonly expiresAtMs: number;
}
type StoredBinding = Omit<FundedIdentityTurnBinding, 'inferenceCeilingMicros'> & { inferenceCeilingMicros: string };
export interface IdentityTurnSettlementOutbox {
  readonly billedInferenceMicros: string;
  readonly priorRemainderNumerator: string;
  readonly remainderNumerator: string;
  readonly samples: Extract<IdentityTurnBilledCost, { ok: true }>['samples'];
  readonly receipt: Omit<SignedUsageReceipt, 'meterQuantity' | 'amountMicros'> & {
    readonly meterQuantity: string;
    readonly amountMicros: string;
  };
}
export interface FundedIdentityTurn {
  readonly turnId: string;
  readonly accountId: string;
  readonly revision: number;
  readonly state: 'prepared' | 'funded' | 'running' | 'closed' | 'settlement-pending' | 'settled';
  readonly binding: FundedIdentityTurnBinding;
  readonly fundingReceipt: UsageReceiptWire | null;
  readonly usageEventKeys: readonly string[] | null;
  readonly closedAtMs: number | null;
  readonly settlementOutbox: IdentityTurnSettlementOutbox | null;
}
type Refused = { readonly ok: false; readonly code: string; readonly detail: string };
type Result = { readonly ok: true; readonly turn: FundedIdentityTurn } | Refused;
interface TurnRow {
  turn_id: string; account_id: string; revision: number | string;
  binding_hash: string; binding: StoredBinding; state: FundedIdentityTurn['state'];
  funding_receipt: UsageReceiptWire | null; usage_event_keys: string[] | null;
  closed_at_ms: number | string | null; settlement_outbox: IdentityTurnSettlementOutbox | null;
}
const fail = (code: string, detail: string): Refused => ({ ok: false, code, detail });
const hash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
// Interfaces lack postgres' JSON index signature. Serialize and parse the
// canonical JSON value at the boundary rather than asserting an unsafe cast.
const jsonValue = (value: unknown): Parameters<Sql['json']>[0] => JSON.parse(canonicalJson(value));
const decimal = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
const storedBinding = (b: FundedIdentityTurnBinding): StoredBinding => ({ ...b, inferenceCeilingMicros: String(b.inferenceCeilingMicros) });
const accountId = (b: FundedIdentityTurnBinding): string => hash([b.payer, b.offerId]);
const accountHash = (b: FundedIdentityTurnBinding): string => hash([b.payer, b.seller, b.offerId, b.offer]);
// A changed owner/payer/revision must collide with the original native turn.
export const fundedIdentityTurnId = (b: FundedIdentityTurnBinding): string =>
  b.admissionId === undefined ? hash([b.workspaceId, b.nativeSessionId, b.nativeTurnId, b.offerId])
    : hash(['native-admission-v1', b.workspaceId, b.nativeSessionId, b.admissionId, b.offerId]);

function validateBinding(b: FundedIdentityTurnBinding): Refused | null {
  if (b.workItem !== undefined && !isIdentityWorkItemBinding(b.workItem)) {
    return fail('invalid-turn-binding', 'outcome attribution requires one exact work-item id and harness');
  }
  if ([b.workspaceId, b.ownerId, b.principalId, b.nativeSessionId,
    b.specificationRevision, b.stateRevision, b.payer, b.seller, b.offerId, b.channelId]
    .some((v) => typeof v !== 'string' || !v.trim() || v.length > 2000) ||
    !Number.isSafeInteger(b.expiresAtMs) || b.expiresAtMs < 0) {
    return fail('invalid-turn-binding', 'an authenticated native turn and immutable commerce binding are required');
  }
  const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 2000;
  if ((b.admissionId !== undefined && !id(b.admissionId)) ||
      (b.nativeTurnId === null ? !id(b.admissionId) : !id(b.nativeTurnId))) {
    return fail('invalid-turn-binding', 'a native turn or explicit host admission identity is required');
  }
  const q = quoteIdentityInferenceTurn({ offer: b.offer, billedInferenceMicros: 0n,
    inferenceCeilingMicros: b.inferenceCeilingMicros });
  return q.ok ? null : q;
}
function fromRow(row: TurnRow): FundedIdentityTurn {
  return { turnId: row.turn_id, accountId: row.account_id, revision: Number(row.revision), state: row.state,
    binding: { ...row.binding, inferenceCeilingMicros: BigInt(row.binding.inferenceCeilingMicros) },
    fundingReceipt: row.funding_receipt, usageEventKeys: row.usage_event_keys,
    closedAtMs: row.closed_at_ms === null ? null : Number(row.closed_at_ms), settlementOutbox: row.settlement_outbox };
}
function voucher(r: UsageReceiptWire): CumulativePaymentVoucher {
  return { channelId: r.channelId, payer: r.payer, seller: r.seller, releaseRef: r.releaseRef,
    usageNonce: r.usageNonce, meterQuantity: BigInt(r.meterQuantity), pricePerUnitMicros: BigInt(r.unitPriceMicros),
    priceVersion: r.priceVersion, splitManifestHash: r.splitManifestHash, expiresAtMs: r.expiresAtMs,
    cumulativeClaimMicros: BigInt(r.cumulativeClaimMicros), signature: r.voucherSignature };
}
function fundingMatches(turn: FundedIdentityTurn, r: UsageReceiptWire): boolean {
  const b = turn.binding;
  const q = quoteIdentityInferenceTurn({ offer: b.offer, billedInferenceMicros: 0n,
    inferenceCeilingMicros: b.inferenceCeilingMicros });
  if (!q.ok || !r || r.state !== 'reserved' || r.amountMicros !== null || r.receiptSignature !== null ||
    r.settledAtMs !== null || r.channelId !== b.channelId || r.usageNonce !== turn.turnId ||
    r.offerId !== b.offerId || r.payer !== b.payer || r.seller !== b.seller || r.releaseRef !== b.offer.skuRef ||
    r.meterUnit !== b.offer.meterUnit || r.priceVersion !== b.offer.priceVersion ||
    r.splitManifestHash !== b.offer.splitManifestHash || r.expiresAtMs !== b.expiresAtMs ||
    r.meterQuantity !== String(q.reservationQuantity) || r.reservedMicros !== String(q.reservedMarkupMicros) ||
    r.unitPriceMicros !== String(b.offer.unitPriceMicros) || !decimal(r.cumulativeClaimMicros) ||
    BigInt(r.cumulativeClaimMicros) < q.reservedMarkupMicros ||
    typeof r.voucherSignature !== 'string' || !r.voucherSignature.trim() ||
    !Number.isSafeInteger(r.reservedAtMs) || r.reservedAtMs < 0 || r.reservedAtMs > r.expiresAtMs) return false;
  if (!r.identityInference || r.identityInference.ceilingMicros !== String(b.inferenceCeilingMicros) ||
      r.identityInference.billedInferenceMicros !== null || r.identityInference.priorRemainderNumerator !== null ||
      r.identityInference.remainderNumerator !== null) return false;
  const { signature: _signature, ...unsigned } = voucher(r);
  return paymentVoucherDigest(unsigned) === r.voucherDigest;
}

/** No database locks are held across hosted IO or signing. */
export class FundedIdentityTurnStore {
  constructor(private readonly sql: Sql) {}

  /** Complete local release population, or one overflow row. Never average a page. */
  async readReleasePopulation(workspaceId: string, releaseRef: string): Promise<FundedIdentityTurn[]> {
    const rows = await this.sql<TurnRow[]>`SELECT * FROM harness_shared.cupboard_funded_turns
      WHERE workspace_id = ${workspaceId} AND binding->'offer'->>'skuRef' = ${releaseRef}
        AND binding->>'kind' IS DISTINCT FROM 'tool'
      ORDER BY turn_id LIMIT 501`;
    return rows.map(fromRow);
  }

  async read(workspaceId: string, turnId: string): Promise<FundedIdentityTurn | null> {
    const [row] = await this.sql<TurnRow[]>`SELECT * FROM harness_shared.cupboard_funded_turns
      WHERE workspace_id = ${workspaceId} AND turn_id = ${turnId}
        AND binding->>'kind' IS DISTINCT FROM 'tool'`;
    return row ? fromRow(row) : null;
  }

  /** Locate recovery through the same immutable payer/offer account as prepare.
   * A new session, channel or worn revision cannot replace the original turn. */
  async readActive(input: FundedIdentityTurnBinding): Promise<
    { readonly ok: true; readonly turn: FundedIdentityTurn | null } | Refused> {
    const invalid = validateBinding(input);
    if (invalid) return invalid;
    const [account] = await this.sql<{ binding_hash: string; active_turn_id: string | null }[]>`
      SELECT binding_hash, active_turn_id FROM harness_shared.cupboard_metered_accounts
      WHERE workspace_id = ${input.workspaceId} AND account_id = ${accountId(input)}`;
    if (!account) return { ok: true, turn: null };
    if (account.binding_hash !== accountHash(input)) {
      return fail('offer-binding-changed', 'the same payer/offer cannot change seller or immutable terms');
    }
    if (!account.active_turn_id) return { ok: true, turn: null };
    const turn = await this.read(input.workspaceId, account.active_turn_id);
    if (!turn || turn.accountId !== accountId(input)) {
      return fail('invalid-active-turn', 'the immutable account has no matching durable active turn');
    }
    return { ok: true, turn };
  }

  async prepare(input: FundedIdentityTurnBinding): Promise<Result> {
    const invalid = validateBinding(input);
    if (invalid) return invalid;
    const b = structuredClone(input);
    const aid = accountId(b), tid = fundedIdentityTurnId(b), ah = accountHash(b), bh = hash(storedBinding(b));
    return await this.sql.begin(async (tx) => {
      await tx`INSERT INTO harness_shared.cupboard_metered_accounts (workspace_id, account_id, binding_hash)
        VALUES (${b.workspaceId}, ${aid}, ${ah}) ON CONFLICT DO NOTHING`;
      const [a] = await tx<{ binding_hash: string; active_turn_id: string | null }[]>`
        SELECT binding_hash, active_turn_id FROM harness_shared.cupboard_metered_accounts
        WHERE workspace_id = ${b.workspaceId} AND account_id = ${aid} FOR UPDATE`;
      if (a!.binding_hash !== ah) return fail('offer-binding-changed', 'the same payer/offer cannot change seller or immutable terms');
      const [old] = await tx<TurnRow[]>`SELECT * FROM harness_shared.cupboard_funded_turns
        WHERE workspace_id = ${b.workspaceId} AND turn_id = ${tid} FOR UPDATE`;
      if (old) return old.binding_hash === bh ? { ok: true, turn: fromRow(old) }
        : fail('turn-binding-changed', 'native turn history binds its original payer, owner, identity and channel');
      if (a!.active_turn_id) return fail('account-turn-pending', 'resolve the previous funded turn before admitting another on this payer/offer');
      const [row] = await tx<TurnRow[]>`INSERT INTO harness_shared.cupboard_funded_turns
        (workspace_id, turn_id, account_id, binding_hash, binding)
        VALUES (${b.workspaceId}, ${tid}, ${aid}, ${bh}, ${tx.json(jsonValue(storedBinding(b)))})
        ON CONFLICT DO NOTHING RETURNING *`;
      if (!row) return fail('turn-binding-changed', 'another payer already bound this native turn');
      await tx`UPDATE harness_shared.cupboard_metered_accounts SET active_turn_id = ${tid}, updated_at = now()
        WHERE workspace_id = ${b.workspaceId} AND account_id = ${aid}`;
      return { ok: true, turn: fromRow(row!) };
    }) as Result;
  }

  private async transition(workspaceId: string, turnId: string, revision: number,
    apply: (tx: Sql, turn: FundedIdentityTurn, remainder: number) => Promise<Result>): Promise<Result> {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
      return fail('invalid-revision', 'a bounded exact local revision is required');
    }
    const prior = await this.read(workspaceId, turnId);
    if (!prior) return fail('unknown-turn', 'no prepared native turn exists');
    return await this.sql.begin(async (transaction) => {
      // Every transition takes account then turn, including prepare.
      const [a] = await transaction<{ remainder_numerator: number; active_turn_id: string | null }[]>`
        SELECT remainder_numerator, active_turn_id FROM harness_shared.cupboard_metered_accounts
        WHERE workspace_id = ${workspaceId} AND account_id = ${prior.accountId} FOR UPDATE`;
      const [row] = await transaction<TurnRow[]>`SELECT * FROM harness_shared.cupboard_funded_turns
        WHERE workspace_id = ${workspaceId} AND turn_id = ${turnId} FOR UPDATE`;
      if (!row) return fail('unknown-turn', 'the native turn history is unavailable');
      const turn = fromRow(row);
      if (turn.revision !== revision) return fail('stale-turn', 'read authoritative turn state before retrying a transition');
      if (a!.active_turn_id !== turnId) return fail('inactive-turn', 'the account no longer holds this turn');
      return apply(transaction as unknown as Sql, turn, a!.remainder_numerator);
    }) as Result;
  }

  private async write(tx: Sql, turn: FundedIdentityTurn): Promise<Result> {
    const [row] = await tx<TurnRow[]>`UPDATE harness_shared.cupboard_funded_turns
      SET revision = revision + 1, state = ${turn.state},
        binding = ${tx.json(jsonValue(storedBinding(turn.binding)))},
        binding_hash = ${hash(storedBinding(turn.binding))},
        funding_receipt = ${turn.fundingReceipt ? tx.json(jsonValue(turn.fundingReceipt)) : null},
        usage_event_keys = ${turn.usageEventKeys ? tx.json([...turn.usageEventKeys]) : null},
        closed_at_ms = ${turn.closedAtMs}, settlement_outbox = ${turn.settlementOutbox ? tx.json(jsonValue(turn.settlementOutbox)) : null},
        updated_at = now()
      WHERE workspace_id = ${turn.binding.workspaceId} AND turn_id = ${turn.turnId}
        AND revision = ${turn.revision} RETURNING *`;
    return row ? { ok: true, turn: fromRow(row) } : fail('stale-turn', 'the turn revision moved');
  }

  /** Supply only a response/reconciliation from the authenticated hosted door. */
  confirmFunding(workspaceId: string, turnId: string, revision: number, receipt: UsageReceiptWire,
    origin: IdentityMarkupOriginWire): Promise<Result> {
    const copy = structuredClone(receipt);
    const hosted = structuredClone(origin);
    return this.transition(workspaceId, turnId, revision, async (tx, turn) => {
      if (turn.state !== 'prepared' && turn.state !== 'funded') return fail('invalid-turn-state', 'only an unentered turn can confirm its reservation');
      if (!fundingMatches(turn, copy)) return fail('funding-binding-mismatch', 'hosted reservation does not prove this exact turn ceiling and binding');
      const b = turn.binding;
      if (!hosted || hosted.offerId !== b.offerId || hosted.payer !== b.payer || hosted.seller !== b.seller ||
          canonicalJson(hosted.offer) !== canonicalJson(b.offer) || !decimal(hosted.remainderNumerator) ||
          BigInt(hosted.remainderNumerator) >= 10000n) {
        return fail('funding-origin-mismatch', 'the hosted payer/offer remainder must bind the exact immutable identity offer');
      }
      if (turn.fundingReceipt && canonicalJson(turn.fundingReceipt) !== canonicalJson(copy)) {
        return fail('funding-binding-mismatch', 'the hosted reservation changed after funding');
      }
      await tx`UPDATE harness_shared.cupboard_metered_accounts SET remainder_numerator = ${Number(hosted.remainderNumerator)}, updated_at = now()
        WHERE workspace_id = ${workspaceId} AND account_id = ${turn.accountId}`;
      return this.write(tx, { ...turn, state: 'funded', fundingReceipt: copy });
    });
  }

  /** Exactly one process may enter inference; a restart cannot re-enter it. */
  enter(workspaceId: string, turnId: string, revision: number, binding: FundedIdentityTurnBinding, nowMs: number): Promise<Result> {
    const copy = structuredClone(binding);
    return this.transition(workspaceId, turnId, revision, async (tx, turn) => {
      if (turn.state !== 'funded') return fail('invalid-turn-state', 'inference requires an unentered funded turn');
      if (hash(storedBinding(copy)) !== hash(storedBinding(turn.binding))) return fail('turn-binding-changed', 'current worn identity and payer must match admission');
      if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > turn.binding.expiresAtMs) return fail('turn-expired', 'the funded turn deadline passed');
      return this.write(tx, { ...turn, state: 'running' });
    });
  }

  /** Bind only the native ID returned by the authenticated delivery. The
   * admission nonce stays stable; no process may rebind historical usage. */
  async bindNativeTurn(workspaceId: string, turnId: string, revision: number, nativeTurnId: string): Promise<Result> {
    if (typeof nativeTurnId !== 'string' || !nativeTurnId.trim() || nativeTurnId.length > 2000) {
      return fail('invalid-native-turn', 'the correlated backend response must identify its native turn');
    }
    try {
      return await this.transition(workspaceId, turnId, revision, async (tx, turn) => {
        if (turn.state !== 'running' || !turn.binding.admissionId) {
          return fail('invalid-turn-state', 'only an entered host admission may bind its native turn');
        }
        if (turn.binding.nativeTurnId !== null) {
          return turn.binding.nativeTurnId === nativeTurnId ? { ok: true, turn }
            : fail('native-turn-binding-changed', 'the admission already retains a different native usage identity');
        }
        return this.write(tx, { ...turn, binding: { ...turn.binding, nativeTurnId } });
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505' &&
          'constraint_name' in error && error.constraint_name === 'cupboard_funded_turns_native_identity') {
        return fail('native-turn-already-bound', 'another admission already retains this native session/turn/offer');
      }
      throw error;
    }
  }

  /** The host supplies the COMPLETE native-turn event population. */
  close(workspaceId: string, turnId: string, revision: number, usageEventKeys: readonly string[], closedAtMs: number): Promise<Result> {
    const keys = [...usageEventKeys].sort();
    if (keys.length === 0 || keys.length > 1000 || new Set(keys).size !== keys.length ||
      keys.some((key) => !/^[a-f0-9]{64}$/.test(key)) || !Number.isSafeInteger(closedAtMs) || closedAtMs < 0) {
      return Promise.resolve(fail('invalid-closed-turn', 'a completed turn needs a unique nonempty exact usage population and closure time'));
    }
    return this.transition(workspaceId, turnId, revision, async (tx, turn) => {
      if (turn.state !== 'running') return fail('invalid-turn-state', 'only an entered turn can close');
      if (!turn.binding.nativeTurnId) return fail('native-turn-unbound', 'native usage identity must be durably bound before closure');
      return this.write(tx, { ...turn, state: 'closed', usageEventKeys: keys, closedAtMs });
    });
  }

  async stageSettlement(workspaceId: string, turnId: string, revision: number, deps: {
    signReceipt: (bytes: Buffer, context: { turnId: string;
      identityInference: { billedInferenceMicros: bigint; priorRemainderNumerator: bigint } }) => Promise<string> | string;
    readUsage?: (sql: Sql, binding: IdentityTurnUsageBinding) => Promise<IdentityTurnBilledCost>;
  }): Promise<Result> {
    const turn = await this.read(workspaceId, turnId);
    if (!turn) return fail('unknown-turn', 'no prepared native turn exists');
    if (turn.revision !== revision) return fail('stale-turn', 'read authoritative turn state before settlement');
    if (turn.state !== 'closed') return fail('invalid-turn-state', 'only a closed complete turn may quote actual inference');
    if (!turn.binding.nativeTurnId) return fail('native-turn-unbound', 'native usage identity is required for bill-grade settlement');
    const usage = await (deps.readUsage ?? readIdentityTurnBilledCost)(this.sql,
      structuredClone({ ...turn.binding, nativeTurnId: turn.binding.nativeTurnId, usageEventKeys: turn.usageEventKeys! }));
    if (!usage.ok) return usage;
    const samples = structuredClone(usage.samples);
    const billedInferenceMicros = usage.billedInferenceMicros;
    if (samples.length !== turn.usageEventKeys!.length || new Set(samples.map((s) => s.usageEventKey)).size !== samples.length ||
      samples.some((s) => !turn.usageEventKeys!.includes(s.usageEventKey) || !s.sampleId || !s.activationEventId)) {
      return fail('usage-population-mismatch', 'bill-grade evidence must cover the exact closed population');
    }
    const [account] = await this.sql<{ remainder_numerator: number }[]>`
      SELECT remainder_numerator FROM harness_shared.cupboard_metered_accounts
      WHERE workspace_id = ${workspaceId} AND account_id = ${turn.accountId}`;
    const prior = BigInt(account!.remainder_numerator);
    const q = quoteIdentityInferenceTurn({ offer: turn.binding.offer, billedInferenceMicros,
      inferenceCeilingMicros: turn.binding.inferenceCeilingMicros, priorRemainderNumerator: prior });
    if (!q.ok) return q;
    const unsigned: Omit<SignedUsageReceipt, 'signature'> = { channelId: turn.binding.channelId, usageNonce: turnId,
      meterQuantity: q.reservationQuantity, amountMicros: q.amountMicros,
      voucherDigest: turn.fundingReceipt!.voucherDigest, occurredAtMs: turn.closedAtMs! };
    const signature = await deps.signReceipt(usageReceiptSigningBytes(unsigned), {
      turnId, identityInference: { billedInferenceMicros, priorRemainderNumerator: prior } });
    if (typeof signature !== 'string' || !signature.trim()) return fail('unsigned-receipt', 'a seller signature is required');
    const outbox: IdentityTurnSettlementOutbox = { billedInferenceMicros: String(billedInferenceMicros),
      priorRemainderNumerator: String(prior), remainderNumerator: String(q.remainderNumerator), samples,
      receipt: { ...unsigned, meterQuantity: String(unsigned.meterQuantity), amountMicros: String(unsigned.amountMicros), signature } };
    return this.transition(workspaceId, turnId, revision, async (tx, latest, remainder) => {
      if (latest.state !== 'closed' || BigInt(remainder) !== prior) return fail('stale-turn', 'the quote or closed turn moved while signing');
      return this.write(tx, { ...latest, state: 'settlement-pending', settlementOutbox: outbox });
    });
  }

  /** Remainder advances only after exact signed hosted settlement read-back. */
  acknowledgeSettlement(workspaceId: string, turnId: string, revision: number, hostedReceipt: UsageReceiptWire): Promise<Result> {
    const receipt = structuredClone(hostedReceipt);
    return this.transition(workspaceId, turnId, revision, async (tx, turn, remainder) => {
      if (turn.state !== 'settlement-pending') return fail('invalid-turn-state', 'only a durable settlement outbox can be acknowledged');
      const pending = turn.settlementOutbox!, funded = turn.fundingReceipt!;
      const expected = { ...funded, state: 'settled', amountMicros: pending.receipt.amountMicros,
        receiptSignature: pending.receipt.signature, settledAtMs: pending.receipt.occurredAtMs,
        identityInference: { ceilingMicros: String(turn.binding.inferenceCeilingMicros),
          billedInferenceMicros: pending.billedInferenceMicros, priorRemainderNumerator: pending.priorRemainderNumerator,
          remainderNumerator: pending.remainderNumerator } };
      if (canonicalJson(receipt) !== canonicalJson(expected) || String(remainder) !== pending.priorRemainderNumerator) {
        return fail('settlement-binding-mismatch', 'hosted acknowledgement must match the durable voucher, signed actual amount and time');
      }
      const written = await this.write(tx, { ...turn, state: 'settled' });
      if (!written.ok) return written;
      await tx`UPDATE harness_shared.cupboard_metered_accounts
        SET remainder_numerator = ${Number(pending.remainderNumerator)}, active_turn_id = NULL, updated_at = now()
        WHERE workspace_id = ${workspaceId} AND account_id = ${turn.accountId}`;
      return written;
    });
  }
}
