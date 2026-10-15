/**
 * Signing and verifying a P-044 monthly statement (D-028 §4). Kept apart from the
 * report builder so the Cupboard Worker can verify a pushed statement with only
 * `@papercusp/hash-chain` and `viem`, without the money-journal module graph.
 *
 * Scheme `eip191-sha256-canonical-json`: digest = sha256(canonicalJson(statement)),
 * signature = EIP-191 personal_sign over the 32 digest bytes. Anyone recovers the
 * signer with `verifyMessage`; the signer is the anchor key's address (D-021).
 */
import { canonicalJson, sha256Hex } from '@papercusp/hash-chain';
import { verifyMessage } from 'viem/utils';
import type { Address, Hex } from 'viem';
import { LIVE_MINIMUM_PAYMENTS, monthPeriod, type MonthlyStatement, type TransparencyReport } from './transparency-report';
import { MOVEMENT_KINDS } from './money-journal';

export const STATEMENT_SIGNATURE_SCHEME = 'eip191-sha256-canonical-json' as const;

/**
 * Where the latest closed month's statement stands (D-028 §5), carried on every
 * live push so the public page says why a month has no statement yet.
 *   published  the statement for `month` is on the Worker (`digest`)
 *   pending    `month` closed but cannot be published yet (no final reconciliation
 *              run, no anchored root covering month end, or no signing key)
 *   withheld   the month's final run did not reconcile; `withheldBy` names the invariants
 *   none       no month has closed with journal activity yet
 */
export interface StatementStatus {
  readonly status: 'published' | 'pending' | 'withheld' | 'none';
  readonly month: string | null;
  readonly digest: string | null;
  readonly withheldBy: readonly string[];
  readonly detail: string;
}

/** The hourly live push body (PUT TRANSPARENCY_LIVE_PATH). */
export interface LiveTransparencyPush {
  readonly workspaceId: string;
  readonly month: string;
  readonly generatedAtMs: number;
  readonly report: TransparencyReport;
  readonly statementStatus: StatementStatus;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const STATEMENT_STATES: ReadonlySet<string> = new Set(['published', 'pending', 'withheld', 'none']);

/** The public boundary refuses older snapshots that carry no population guard. */
export function hasLiveDisclosure(report: TransparencyReport): boolean {
  const d = report.disclosure;
  if (!d || d.version !== 1 || d.minimumPayments !== LIVE_MINIMUM_PAYMENTS || !['complete', 'folded'].includes(d.status) || !d.streams || typeof d.streams !== 'object' || Array.isArray(d.streams)) return false;
  return Object.entries(d.streams).every(([movement, stream]) =>
    MOVEMENT_KINDS.includes(movement as typeof MOVEMENT_KINDS[number]) && movement !== 'dao-transfer' &&
    !!stream && Number.isSafeInteger(stream.payments) && stream.payments >= LIVE_MINIMUM_PAYMENTS && /^[0-9a-f]{64}$/.test(stream.root));
}

/** Counts alone are insufficient: an old entry edited at the same count must also stay private. */
export function liveDisclosureUpdateProblem(previous: TransparencyReport | null, next: TransparencyReport): string | null {
  if (!hasLiveDisclosure(next)) return 'the live report has no valid payment-window disclosure policy';
  if (!previous || !hasLiveDisclosure(previous) || previous.month !== next.month) return null;
  if (previous.currency !== next.currency || previous.fromMs !== next.fromMs || next.untilMs < previous.untilMs) return 'the live disclosure period or currency moved backwards';
  const before = previous.disclosure!.streams;
  const after = next.disclosure!.streams;
  for (const movement of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[movement as keyof typeof before];
    const b = after[movement as keyof typeof after];
    if (a?.root !== b?.root && (b?.payments ?? 0) - (a?.payments ?? 0) < LIVE_MINIMUM_PAYMENTS) return `the ${movement} update must fold into a later payment window`;
  }
  return null;
}

/** Shape check for a pushed live report: the report and the status must describe the push's own workspace and month. */
export function parseLiveTransparencyPush(raw: unknown): LiveTransparencyPush | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const report = r.report as Record<string, unknown> | undefined;
  const status = r.statementStatus as Record<string, unknown> | undefined;
  const ok =
    typeof r.workspaceId === 'string' &&
    r.workspaceId.length > 0 &&
    typeof r.month === 'string' &&
    MONTH.test(r.month) &&
    typeof r.generatedAtMs === 'number' &&
    Number.isFinite(r.generatedAtMs) &&
    !!report &&
    report.kind === 'live' &&
    report.provisional === true &&
    report.workspaceId === r.workspaceId &&
    report.month === r.month &&
    hasLiveDisclosure(report as unknown as TransparencyReport) &&
    typeof report.fromMs === 'number' && typeof report.untilMs === 'number' &&
    report.fromMs === monthPeriod(r.month as string).fromMs &&
    report.untilMs >= report.fromMs && report.untilMs <= monthPeriod(r.month as string).untilMs &&
    report.untilMs <= Math.floor((r.generatedAtMs as number) / 3_600_000) * 3_600_000 &&
    !!status &&
    typeof status.status === 'string' &&
    STATEMENT_STATES.has(status.status) &&
    (status.month === null || (typeof status.month === 'string' && MONTH.test(status.month))) &&
    (status.digest === null || typeof status.digest === 'string') &&
    Array.isArray(status.withheldBy) &&
    status.withheldBy.every((w) => typeof w === 'string') &&
    typeof status.detail === 'string';
  return ok ? (raw as LiveTransparencyPush) : null;
}

export interface SignedStatement {
  readonly scheme: typeof STATEMENT_SIGNATURE_SCHEME;
  readonly statement: MonthlyStatement;
  /** sha256(canonicalJson(statement)), hex without 0x. */
  readonly digest: string;
  readonly signature: Hex;
  readonly signer: Address;
}

export function statementDigest(statement: MonthlyStatement): string {
  return sha256Hex(canonicalJson(statement));
}

export async function signStatement(statement: MonthlyStatement, privateKey: Hex): Promise<SignedStatement> {
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(privateKey);
  const digest = statementDigest(statement);
  const signature = await account.signMessage({ message: { raw: `0x${digest}` } });
  return { scheme: STATEMENT_SIGNATURE_SCHEME, statement, digest, signature, signer: account.address };
}

/** Anyone's check: the digest matches the statement AND the signature recovers to `signer`. */
export async function verifySignedStatement(signed: SignedStatement): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (signed.scheme !== STATEMENT_SIGNATURE_SCHEME) return { ok: false, reason: `unknown scheme '${String(signed.scheme)}'` };
  let digest: string;
  try {
    digest = statementDigest(signed.statement);
  } catch {
    return { ok: false, reason: 'statement is not canonical JSON' };
  }
  if (digest !== signed.digest) return { ok: false, reason: 'digest does not match the statement' };
  const valid = await verifyMessage({ address: signed.signer, message: { raw: `0x${signed.digest}` }, signature: signed.signature }).catch(() => false);
  return valid ? { ok: true } : { ok: false, reason: 'signature does not recover to the signer' };
}

/** Shape check for a pushed statement (the Worker then calls verifySignedStatement). */
export function parseSignedStatement(raw: unknown): SignedStatement | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const st = r.statement as Record<string, unknown> | undefined;
  const report = st?.report as Record<string, unknown> | undefined;
  const ok =
    r.scheme === STATEMENT_SIGNATURE_SCHEME &&
    typeof r.digest === 'string' &&
    /^[0-9a-f]{64}$/.test(r.digest) &&
    typeof r.signature === 'string' &&
    /^0x[0-9a-fA-F]+$/.test(r.signature) &&
    typeof r.signer === 'string' &&
    /^0x[0-9a-fA-F]{40}$/.test(r.signer) &&
    !!report &&
    report.kind === 'monthly-statement' &&
    report.provisional === false &&
    typeof report.workspaceId === 'string' &&
    typeof report.month === 'string' &&
    /^\d{4}-\d{2}$/.test(report.month);
  return ok ? (raw as SignedStatement) : null;
}
