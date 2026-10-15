/**
 * Carry-delivered recovery legs — de-duplicating `coord:orient { afterCompaction }`.
 *
 * Plan oversized-tool-results-reduction-2026-10-12 D-006 (EI-23452465962348473).
 *
 * A carry document renders the post-compaction recovery (plan authority, held-item
 * checkpoints) from the same `buildCompactionRecovery` call orient uses. Measured
 * 2026-10-13: 1,736 agent recovery orients per day at p50 16.5KB, and 843 of them
 * arrived within 15 minutes of a carry-respawn, so most re-sent text the successor
 * had just been given. The two largest legs were plan authority (3,568 chars) and
 * checkpoints (2,922 chars) on a 15,994-char trimmed body.
 *
 * buildCarryDoc records a digest of what it delivered; orient compares and stubs
 * the unchanged legs. The record is honoured only when EXACTLY ONE memory-epoch bump
 * happened after the build: every carry producer (session:request-compaction, the
 * cold loop wake) builds first and bumps after, so that bump is the context wipe the
 * document was delivered across. No bump (the respawn never happened) or a second
 * bump (a later wipe with no new carry) means the content may be gone, so the leg is
 * delivered in full. Every read or compare failure also delivers in full.
 */
import { createHash } from 'node:crypto';
import { workItemFetchHint } from '../../work-item-fetch-hint';
import type { CompactionRecovery } from './compaction-recovery';

export const RECOVERY_DELIVERY_VERSION = 1 as const;

export interface RecoveryDeliveryDigest {
  /** `<harness>/<plan>@<version>:<contentHash>` for a current plan authority, else null. */
  planAuthority: string | null;
  /** Held item id → hash of the checkpoint excerpt delivered for it. */
  checkpoints: Record<string, string>;
}

export interface RecoveryDeliveryRecord extends RecoveryDeliveryDigest {
  v: typeof RECOVERY_DELIVERY_VERSION;
  builtAt: string;
  buildEpoch: number;
}

/** The owner's memory-epoch row (memory_session_epochs, keyed by owner id). */
export interface SessionEpochRow {
  epoch: number;
  bumpedAt: string | Date;
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Digest the legs a stub could replace. Ownership-warning entries (checkpoint null)
 *  are never stubbed, so they are not digested. */
export function digestRecoveryLegs(recovery: CompactionRecovery): RecoveryDeliveryDigest {
  const pa = recovery.planAuthority;
  const planAuthority =
    pa && pa.resolution === 'current' ? `${pa.harness}/${pa.planSlug}@${pa.version}:${pa.contentHash}` : null;
  const checkpoints: Record<string, string> = {};
  for (const item of recovery.checkpoints ?? []) {
    if (typeof item.checkpoint === 'string' && item.checkpoint.length > 0) {
      checkpoints[item.id] = sha(item.checkpoint);
    }
  }
  return { planAuthority, checkpoints };
}

/** True when the carry document described by `record` is still in this session's
 *  context: exactly one epoch bump since the build, and it happened after the build. */
export function carryDeliveryStillInContext(
  record: RecoveryDeliveryRecord | null | undefined,
  epoch: SessionEpochRow | null | undefined,
): boolean {
  if (!record || record.v !== RECOVERY_DELIVERY_VERSION || !epoch) return false;
  if (!Number.isFinite(record.buildEpoch) || epoch.epoch !== record.buildEpoch + 1) return false;
  const builtAtMs = Date.parse(record.builtAt);
  const bumpedAtMs = epoch.bumpedAt instanceof Date ? epoch.bumpedAt.getTime() : Date.parse(epoch.bumpedAt);
  return Number.isFinite(builtAtMs) && Number.isFinite(bumpedAtMs) && bumpedAtMs >= builtAtMs;
}

export interface StubResult {
  recovery: CompactionRecovery;
  /** Which legs were replaced, e.g. ['planAuthority.decisions', 'checkpoints:WI-1']. */
  stubbed: string[];
}

/**
 * Replace the legs whose digest still matches the carry document's with a pointer.
 * Pure. Returns the input untouched when the delivery is not provably in context.
 */
export function stubCarryDeliveredLegs(
  recovery: CompactionRecovery,
  record: RecoveryDeliveryRecord | null | undefined,
  epoch: SessionEpochRow | null | undefined,
): StubResult {
  if (!record || !carryDeliveryStillInContext(record, epoch)) return { recovery, stubbed: [] };
  const live = digestRecoveryLegs(recovery);
  const stubbed: string[] = [];
  const out: CompactionRecovery = { ...recovery };

  const pa = recovery.planAuthority;
  if (
    pa &&
    pa.resolution === 'current' &&
    live.planAuthority !== null &&
    live.planAuthority === record.planAuthority
  ) {
    const deliveredInCarry = {
      builtAt: record.builtAt,
      omitted: 'decision bodies' as const,
      refetch: `plans:get { slug: '${pa.planSlug}', harness: '${pa.harness}', decisionId: '<D-NNN>' }`,
    };
    const candidate = {
      ...pa,
      decisions: pa.decisions.map((d) => ({ id: d.id, title: d.title, body: '', truncated: true })),
      deliveredInCarry,
    };
    // Count the complete wire representation, including metadata keys and UTF-8 width.
    if (serializedBytes(candidate) < serializedBytes(pa)) {
      out.planAuthority = candidate;
      stubbed.push('planAuthority.decisions');
    }
  }

  if (recovery.checkpoints?.length) {
    out.checkpoints = recovery.checkpoints.map((item) => {
      const liveHash = live.checkpoints[item.id];
      if (!liveHash || record.checkpoints[item.id] !== liveHash) return item;
      const pointer =
        `⟦unchanged since your carry document (built ${record.builtAt}); ` +
        `full text: ${workItemFetchHint(item.id, item.harness)}⟧`;
      const { checkpointTruncated, ...rest } = item;
      const candidate = { ...rest, checkpoint: pointer };
      // JSON escaping and the pointer's Unicode delimiters also count toward the result door.
      if (serializedBytes(candidate) >= serializedBytes(item)) return item;
      stubbed.push(`checkpoints:${item.id}`);
      return candidate;
    });
  }

  return stubbed.length ? { recovery: out, stubbed } : { recovery, stubbed: [] };
}

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

async function defaultSql(): Promise<Sql> {
  const { getOrgPg } = await import('@papercusp/db-org');
  return getOrgPg().sql as unknown as Sql;
}

/** Record what a carry document delivered. Fail-soft: a missed write only means the
 *  next recovery orient delivers in full. */
export async function recordRecoveryDelivery(
  ownerId: string,
  recovery: CompactionRecovery,
  buildEpoch: number,
  opts: { sql?: Sql; now?: number } = {},
): Promise<void> {
  try {
    const sql = opts.sql ?? (await defaultSql());
    const record: RecoveryDeliveryRecord = {
      v: RECOVERY_DELIVERY_VERSION,
      builtAt: new Date(opts.now ?? Date.now()).toISOString(),
      buildEpoch,
      ...digestRecoveryLegs(recovery),
    };
    await sql`
      UPDATE harness_shared.session_briefs
         SET recovery_delivery = ${JSON.stringify(record)}::jsonb
       WHERE owner_id = ${ownerId}
    `;
  } catch {
    /* the next recovery orient delivers in full */
  }
}

/** Read the record and the owner's epoch row together. Fail-soft to nulls. */
export async function readRecoveryDelivery(
  ownerId: string,
  opts: { sql?: Sql } = {},
): Promise<{ record: RecoveryDeliveryRecord | null; epoch: SessionEpochRow | null }> {
  try {
    const sql = opts.sql ?? (await defaultSql());
    const rows = (await sql`
      SELECT b.recovery_delivery AS record, e.epoch AS epoch, e.bumped_at AS bumped_at
        FROM harness_shared.session_briefs b
        LEFT JOIN harness_shared.memory_session_epochs e ON e.session_id = b.owner_id
       WHERE b.owner_id = ${ownerId}
       LIMIT 1
    `) as Array<{ record: RecoveryDeliveryRecord | null; epoch: number | null; bumped_at: string | Date | null }>;
    const row = rows[0];
    if (!row) return { record: null, epoch: null };
    return {
      record: row.record ?? null,
      epoch: row.epoch != null && row.bumped_at != null ? { epoch: Number(row.epoch), bumpedAt: row.bumped_at } : null,
    };
  } catch {
    return { record: null, epoch: null };
  }
}

/** Orient seam: read, compare, stub. Never throws; returns the input on any failure. */
export async function applyCarryDeliveredStubs(
  ownerId: string,
  recovery: CompactionRecovery,
  opts: { sql?: Sql } = {},
): Promise<StubResult> {
  try {
    const { record, epoch } = await readRecoveryDelivery(ownerId, opts);
    return stubCarryDeliveredLegs(recovery, record, epoch);
  } catch {
    return { recovery, stubbed: [] };
  }
}
