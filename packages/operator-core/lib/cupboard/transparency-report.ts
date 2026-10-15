/**
 * Public transparency report (agent-economy-flywheel-2026-08-30 P-044, D-028).
 *
 * Every money figure is derived from money-journal entries (P-042) by ONE pure
 * function, so the report cannot disagree with the journal it summarizes:
 *
 *   - revenue by stream: net credits to `revenue`, grouped by the entry's movement;
 *   - accounts: the trial balance of the period's entries (debits, credits, net);
 *   - the DAO's share: credits to `dao-payable` in the period;
 *   - DAO transfers: every `dao-transfer` entry with its chain-tx hash.
 *
 * The treasury (Safe) balance is NOT a journal figure. It is reported only when a
 * measured Safe snapshot is supplied, otherwise `not-measured` with the reason
 * (D-028 §2; WI-10004708 owns the on-chain source).
 *
 * Two shapes leave this module: the hourly LIVE report (the open month, every fiat
 * figure `provisional: true`) and the MONTHLY STATEMENT, built only from a FINAL
 * reconciliation run that broke nothing. The statement is digested as canonical
 * JSON and signed with EIP-191 by the anchor key, so anyone can recover the signer
 * from the published signature (D-028 §4).
 */
import { canonicalJson, entryDigest, sha256Hex } from '@papercusp/hash-chain';
import { MONEY_JOURNAL_ACCOUNTS, trialBalance, type JournalEntry, type MoneyJournalAccount, type MovementKind } from './money-journal';
import { MANDATED_INVARIANTS, type InvariantStatus, type ReconciliationInvariant, type SafeSnapshot } from './reconciliation';
import { statementDigest } from './transparency-statement';

export const TRANSPARENCY_REPORT_VERSION = 1 as const;
export const LIVE_MINIMUM_PAYMENTS = 2 as const;
const HOUR_MS = 3_600_000;

export interface LiveDisclosure {
  readonly version: 1;
  readonly minimumPayments: typeof LIVE_MINIMUM_PAYMENTS;
  readonly status: 'complete' | 'folded';
  readonly streams: Readonly<Partial<Record<MovementKind, { readonly payments: number; readonly root: string }>>>;
}

/** The anchored root a report points at (D-024): enough to look it up on chain. */
export interface ReportAnchor {
  readonly logId: string;
  readonly logRoot: string;
  readonly treeSize: number;
  readonly windowEnd: number;
  readonly backend: string;
  readonly chainId: number | null;
  readonly ref: string;
  readonly txHash: string | null;
}

export type TreasuryFigure =
  | {
      readonly status: 'measured';
      readonly balanceMicros: number;
      readonly receiptsMicros: number;
      readonly approvedSpendsMicros: number;
    }
  | { readonly status: 'not-measured'; readonly reason: string };

export interface ReportAccount {
  readonly account: MoneyJournalAccount;
  readonly debitCents: number;
  readonly creditCents: number;
  /** Signed by the account's normal side, as in the trial balance. */
  readonly netCents: number;
}

export interface ReportDaoTransfer {
  readonly entryId: string;
  readonly occurredAtMs: number;
  readonly cents: number;
  readonly chainId: number;
  readonly txHash: string;
}

export interface TransparencyReport {
  readonly version: typeof TRANSPARENCY_REPORT_VERSION;
  readonly kind: 'live' | 'monthly-statement';
  readonly workspaceId: string;
  /** `YYYY-MM`, the month the figures cover. */
  readonly month: string;
  readonly fromMs: number;
  /** Exclusive. */
  readonly untilMs: number;
  /** True while the month is open: every fiat figure may still move. */
  readonly provisional: boolean;
  readonly currency: string;
  readonly revenueCents: number;
  readonly revenueByStream: Readonly<Partial<Record<MovementKind, number>>>;
  readonly accounts: readonly ReportAccount[];
  readonly daoShareCents: number;
  readonly daoTransferredCents: number;
  readonly daoTransfers: readonly ReportDaoTransfer[];
  readonly treasury: TreasuryFigure;
  readonly latestAnchor: ReportAnchor | null;
  /** Entries in the period, in (occurredAtMs, entryId) order. */
  readonly entryCount: number;
  /** sha256 over the canonical JSON array of each period entry's entryDigest, in that order. */
  readonly entriesRoot: string;
  /** Entries in the period kept out because they are in another currency. */
  readonly excludedOtherCurrency: number;
  /** Live snapshots only. Monthly statement bytes retain their original shape. */
  readonly disclosure?: LiveDisclosure;
}

export interface ReportPeriod {
  readonly month: string;
  readonly fromMs: number;
  readonly untilMs: number;
}

/** `YYYY-MM` -> the UTC bounds of that month. */
export function monthPeriod(month: string): ReportPeriod {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  const monthIndex = m ? Number(m[2]) - 1 : -1;
  if (!m || monthIndex < 0 || monthIndex > 11) throw new Error(`monthPeriod: '${month}' is not YYYY-MM`);
  const year = Number(m[1]);
  return { month, fromMs: Date.UTC(year, monthIndex, 1), untilMs: Date.UTC(year, monthIndex + 1, 1) };
}

function inPeriod(e: JournalEntry, period: ReportPeriod): boolean {
  return e.occurredAtMs >= period.fromMs && e.occurredAtMs < period.untilMs;
}

function lineCents(e: JournalEntry, account: MoneyJournalAccount, side: 'debit' | 'credit'): number {
  return e.lines.filter((l) => l.account === account && l.side === side).reduce((s, l) => s + l.cents, 0);
}

export function treasuryFigure(safe: SafeSnapshot | null, notMeasuredReason: string): TreasuryFigure {
  return safe
    ? { status: 'measured', balanceMicros: safe.balanceMicros, receiptsMicros: safe.receiptsMicros, approvedSpendsMicros: safe.approvedSpendsMicros }
    : { status: 'not-measured', reason: notMeasuredReason };
}

/** A closed hour joins the next window until every private movement has two distinct economic references. */
function foldedLivePeriod(entries: readonly JournalEntry[], period: ReportPeriod, asOfMs: number): ReportPeriod {
  const closedUntil = Math.max(period.fromMs, Math.min(period.untilMs, Math.floor(asOfMs / HOUR_MS) * HOUR_MS));
  const closed = entries.filter((e) => e.occurredAtMs < closedUntil);
  let untilMs = period.fromMs;
  const pending = new Map<MovementKind, Set<string>>();
  for (let i = 0; i < closed.length; i++) {
    const e = closed[i]!;
    // A DAO transfer's amount is already public on chain; it is not a private payment.
    if (e.movement !== 'dao-transfer') {
      const refs = pending.get(e.movement) ?? new Set<string>();
      refs.add(canonicalJson(e.externalRef));
      pending.set(e.movement, refs);
    }
    const hour = Math.floor(e.occurredAtMs / HOUR_MS);
    const next = closed[i + 1];
    if ((!next || Math.floor(next.occurredAtMs / HOUR_MS) !== hour) && [...pending.values()].every((refs) => refs.size >= LIVE_MINIMUM_PAYMENTS)) {
      untilMs = Math.min(closedUntil, (hour + 1) * HOUR_MS);
      pending.clear();
    }
  }
  if (pending.size === 0) untilMs = closedUntil;
  return { ...period, untilMs };
}

function liveDisclosure(entries: readonly JournalEntry[], folded: boolean): LiveDisclosure {
  const streams: Partial<Record<MovementKind, { payments: number; root: string }>> = {};
  for (const movement of new Set(entries.map((e) => e.movement))) {
    if (movement === 'dao-transfer') continue;
    const mine = entries.filter((e) => e.movement === movement);
    streams[movement] = {
      payments: new Set(mine.map((e) => canonicalJson(e.externalRef))).size,
      root: sha256Hex(canonicalJson(mine.map((e) => entryDigest(e)))),
    };
  }
  return { version: 1, minimumPayments: LIVE_MINIMUM_PAYMENTS, status: folded ? 'folded' : 'complete', streams };
}

/** Build the report for one period from the workspace's journal entries. Pure. */
export function buildTransparencyReport(input: {
  readonly workspaceId: string;
  readonly kind: 'live' | 'monthly-statement';
  readonly entries: readonly JournalEntry[];
  readonly period: ReportPeriod;
  readonly provisional: boolean;
  readonly currency?: string;
  readonly treasury: TreasuryFigure;
  readonly latestAnchor: ReportAnchor | null;
  /** Live reports stop before the current, still-changing hour. */
  readonly asOfMs?: number;
}): TransparencyReport {
  const currency = input.currency ?? 'USD';
  const allPeriodEntries = input.entries.filter((e) => inPeriod(e, input.period));
  const candidates = allPeriodEntries
    .filter((e) => e.currency === currency)
    .sort((a, b) => a.occurredAtMs - b.occurredAtMs || (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
  const period = input.kind === 'live' ? foldedLivePeriod(candidates, input.period, input.asOfMs ?? input.period.untilMs) : input.period;
  const entries = candidates.filter((e) => inPeriod(e, period));
  const periodEntries = allPeriodEntries.filter((e) => inPeriod(e, period));

  const revenueByStream: Partial<Record<MovementKind, number>> = {};
  let revenueCents = 0;
  let daoShareCents = 0;
  const daoTransfers: ReportDaoTransfer[] = [];
  for (const e of entries) {
    const revenue = lineCents(e, 'revenue', 'credit') - lineCents(e, 'revenue', 'debit');
    if (revenue !== 0) {
      revenueByStream[e.movement] = (revenueByStream[e.movement] ?? 0) + revenue;
      revenueCents += revenue;
    }
    daoShareCents += lineCents(e, 'dao-payable', 'credit');
    if (e.movement === 'dao-transfer' && e.externalRef.kind === 'chain-tx') {
      daoTransfers.push({
        entryId: e.entryId,
        occurredAtMs: e.occurredAtMs,
        cents: lineCents(e, 'dao-payable', 'debit'),
        chainId: e.externalRef.chainId,
        txHash: e.externalRef.txHash,
      });
    }
  }

  const tb = trialBalance(entries, currency);
  const byAccount = new Map(tb.accounts.map((a) => [a.account, a]));
  const accounts: ReportAccount[] = MONEY_JOURNAL_ACCOUNTS.map((account) => {
    const a = byAccount.get(account);
    return { account, debitCents: a?.debitCents ?? 0, creditCents: a?.creditCents ?? 0, netCents: a?.balanceCents ?? 0 };
  });

  return {
    version: TRANSPARENCY_REPORT_VERSION,
    kind: input.kind,
    workspaceId: input.workspaceId,
    month: input.period.month,
    fromMs: input.period.fromMs,
    untilMs: period.untilMs,
    provisional: input.provisional,
    currency,
    revenueCents,
    revenueByStream,
    accounts,
    daoShareCents,
    daoTransferredCents: daoTransfers.reduce((s, t) => s + t.cents, 0),
    daoTransfers,
    treasury: input.treasury,
    latestAnchor: input.latestAnchor,
    entryCount: entries.length,
    entriesRoot: sha256Hex(canonicalJson(entries.map((e) => entryDigest(e)))),
    excludedOtherCurrency: periodEntries.length - entries.length,
    ...(input.kind === 'live' ? { disclosure: liveDisclosure(entries, entries.length < candidates.length) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Monthly statement (D-028 §4–5).
// ---------------------------------------------------------------------------

/** The final reconciliation run a statement rests on. */
export interface StatementReconciliation {
  readonly runId: string;
  readonly mode: 'provisional' | 'final';
  readonly month: string;
  readonly finishedAt: string;
  readonly verdicts: readonly { readonly invariant: ReconciliationInvariant; readonly status: InvariantStatus }[];
}

export interface MonthlyStatement {
  readonly report: TransparencyReport;
  readonly reconciliation: {
    readonly runId: string;
    readonly finishedAt: string;
    readonly verdicts: readonly { readonly invariant: ReconciliationInvariant; readonly status: InvariantStatus }[];
  };
}

export type StatementBuild =
  | { readonly ok: true; readonly statement: MonthlyStatement; readonly digest: string }
  | { readonly ok: false; readonly reason: 'not-final' | 'reconciliation-not-clean'; readonly detail: string; readonly withheldBy: readonly string[] };

/**
 * Why a final run cannot back a statement: a broken invariant (any), or a
 * mandated invariant that could not be evaluated (`unknown`). `not-configured`
 * is not a failure: that source is not part of this install.
 */
export function statementWithheldBy(verdicts: StatementReconciliation['verdicts']): string[] {
  const mandated = new Set<string>(MANDATED_INVARIANTS);
  return verdicts
    .filter((v) => v.status === 'broken' || (v.status === 'unknown' && mandated.has(v.invariant)))
    .map((v) => `${v.invariant}:${v.status}`);
}

/** The statement for the month a FINAL reconciliation run closed, or why there is none. */
export function buildMonthlyStatement(input: {
  readonly workspaceId: string;
  readonly entries: readonly JournalEntry[];
  readonly run: StatementReconciliation;
  readonly currency?: string;
  readonly treasury: TreasuryFigure;
  readonly latestAnchor: ReportAnchor | null;
}): StatementBuild {
  if (input.run.mode !== 'final') {
    return { ok: false, reason: 'not-final', detail: `run ${input.run.runId} is ${input.run.mode}; a statement needs the month-close (final) run`, withheldBy: [] };
  }
  const withheldBy = statementWithheldBy(input.run.verdicts);
  if (withheldBy.length > 0) {
    return { ok: false, reason: 'reconciliation-not-clean', detail: `month ${input.run.month} did not reconcile: ${withheldBy.join(', ')}`, withheldBy };
  }
  const report = buildTransparencyReport({
    workspaceId: input.workspaceId,
    kind: 'monthly-statement',
    entries: input.entries,
    period: monthPeriod(input.run.month),
    provisional: false,
    currency: input.currency,
    treasury: input.treasury,
    latestAnchor: input.latestAnchor,
  });
  const statement: MonthlyStatement = {
    report,
    reconciliation: {
      runId: input.run.runId,
      finishedAt: input.run.finishedAt,
      verdicts: input.run.verdicts.map((v) => ({ invariant: v.invariant, status: v.status })),
    },
  };
  return { ok: true, statement, digest: statementDigest(statement) };
}
