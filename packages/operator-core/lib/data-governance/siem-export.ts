/**
 * P-008a (plan papercusp-enterprise-readiness-roadmap-2026-10-09, WI-6554700010011903, D-017):
 * a redacted, tamper-evident SIEM export of the tool-invocation ledger.
 *
 * ONE source, ONE correlation key: `harness_shared.tool_invocations` is the action record every
 * door (MCP, HTTP, IPC) writes, accepted AND denied, so its row `id` follows one action through
 * identity (principal_kind / auth method / trust), authorization (status + error_code), policy (the
 * inherited governance chain in effect at `invoked_at`), resource metadata (tool, plugin, harness)
 * and result. The id is also the export cursor.
 *
 * Output: OCSF 1.3 API Activity (class 6003) events, one JSON object per line, behind a manifest
 * line, each event hash-chained (`@papercusp/hash-chain`) so a consumer detects any edit, drop,
 * reorder or truncation. Batches continue a per-workspace stream from the last delivered head and
 * verify on their own (`verifyChain` `startAfter`). Replaying the same cursor range over the same
 * head yields the same bytes and the same idempotency key, so a SIEM de-duplicates a redelivery.
 *
 * Redaction is DECLARED per column (`SIEM_SOURCE_COLUMNS`, classified with the hosted customer-data
 * classes) and withheld unless classified: the read selects only non-withheld columns, the actor is
 * a keyed pseudonym, arguments become key names plus a keyed digest, free text never leaves, and a
 * final values-only credential scrub (`assertGovernancePayloadSafe`) replaces anything secret-shaped.
 *
 * Access: only a HUMAN principal holding the governance `approve` capability over the workspace's
 * leaf policy layer may export it; everything else, including any error while deciding, is refused.
 *
 * P-008b (WI-6554700010012184, D-018): organization audit events (receipts included) are a SECOND
 * stream per organization (siem-export-org-audit.ts) over this same batch format and verifier;
 * delivery state, the export key and its rotation live in siem-export-delivery.ts. A batch may carry
 * the export key's id (`keyId`), and every export is bounded by `settleHorizon`: the settle window
 * AND the start of the oldest open transaction, because a row's commit can lag its timestamp by the
 * whole length of its transaction.
 */
import { createHmac } from 'node:crypto';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  appendLinks,
  canonicalJson,
  entryDigest,
  sha256Hex,
  verifyChain,
  type ChainHead,
  type ChainLink,
  type ChainRecord,
  type ChainVerdict,
} from '@papercusp/hash-chain';
import type { CustomerDataClass } from '../auth/hosted/customer-data-map';
import { assertGovernancePayloadSafe } from '../auth/hosted/governance';
import { authorize, principalKindOf } from '../governance-policy/authority';
import { listVersions, loadChainForWorkspace, type PolicyLayerVersion, type StoredPolicyLayer } from '../governance-policy/store';

export const SIEM_EXPORT_SCHEMA = 'papercusp.siem-export/v1' as const;
export const SIEM_LOG_NAME = 'papercusp.tool_invocations' as const;
/** Rows younger than this are not exported yet: a smaller id may still be committing. */
export const SIEM_DEFAULT_SETTLE_MS = 10 * 60_000;
export const SIEM_MAX_PAGE = 5000;
export const SIEM_MIN_KEY_BYTES = 32;
export const SIEM_WITHHELD_CREDENTIAL = '[withheld:credential-like]';
export const SIEM_WITHHELD_FREE_TEXT = '[withheld:free-text]';

/**
 * - emit: operational value, exported as is.
 * - emit-code: exported only when it is a code-shaped identifier; free text is withheld (measured:
 *   live `error_code` values include raw database error messages).
 * - pseudonymize: keyed HMAC pseudonym, stable per export key.
 * - digest-keys: top-level identifier-shaped key names plus a keyed digest of the whole value.
 * - declared-projection: a fixed, code-declared allowlist of fields, each with its own treatment;
 *   a value the declaration does not recognize falls back to digest-keys (org-audit metadata).
 * - withhold: never read.
 */
export type SiemTreatment = 'emit' | 'emit-code' | 'pseudonymize' | 'digest-keys' | 'declared-projection' | 'withhold';

export interface SiemColumnClass {
  readonly dataClass: CustomerDataClass;
  readonly treatment: SiemTreatment;
  readonly why: string;
}

const op = (why: string): SiemColumnClass => ({ dataClass: 'operational', treatment: 'emit', why });
const code = (why: string): SiemColumnClass => ({ dataClass: 'operational', treatment: 'emit-code', why });
const withheld = (dataClass: CustomerDataClass, why: string): SiemColumnClass => ({ dataClass, treatment: 'withhold', why });

/** Every column of harness_shared.tool_invocations, classified. Pinned to the schema by test. */
export const SIEM_SOURCE_COLUMNS = {
  id: op('row id: the correlation key and export cursor'),
  workspace_id: op('tenant'),
  harness_slug: op('project scope'),
  plugin_name: op('resource: owning plugin'),
  tool_name: op('resource: the action'),
  role: op('caller role'),
  feature_id: op('work-item reference'),
  chunk_id: op('work chunk reference'),
  run_id: op('run reference'),
  spawn_id: op('agent session reference'),
  parent_spawn_id: op('parent session reference'),
  window_key: withheld('operational', 'rewritten after insert: would break replay identity'),
  invoked_at: op('event time'),
  duration_ms: op('latency'),
  status: code('outcome code'),
  output_ref: withheld('operational', 'set after insert; points at stored output'),
  output_size: withheld('operational', 'set after insert'),
  error_message: withheld('secret', 'free text that can echo arguments and credentials'),
  args_json: { dataClass: 'secret', treatment: 'digest-keys', why: 'arguments can carry customer content and credentials' },
  event_count: withheld('operational', 'set after insert'),
  metadata_json: withheld('secret', 'free-form, can carry request content'),
  transport: op('door: mcp/http/ipc'),
  principal_kind: op('identity: principal kind'),
  principal_auth_method: op('identity: authentication method'),
  principal_trust: op('identity: trust level'),
  error_code: code('authorization / failure code'),
  coord_owner_id: { dataClass: 'pii', treatment: 'pseudonymize', why: 'identifies the acting person or agent' },
  intent_event_id: op('intent reference'),
  assumption_set_id: op('assumption reference'),
  goal_ref: op('goal reference'),
  call_origin: op('call origin'),
  call_origin_source: op('call origin evidence source'),
  serving_host: op('serving host'),
  serving_process_id: op('serving process'),
  serving_build_sha: op('serving build'),
  goal_id: op('goal id'),
  goal_actor_class: op('goal actor class'),
} as const satisfies Record<string, SiemColumnClass>;

export type SiemSourceColumn = keyof typeof SIEM_SOURCE_COLUMNS;

/** Columns the export reads (everything not withheld), in declaration order. */
export const SIEM_READ_COLUMNS: readonly SiemSourceColumn[] = (Object.keys(SIEM_SOURCE_COLUMNS) as SiemSourceColumn[]).filter(
  (c) => SIEM_SOURCE_COLUMNS[c].treatment !== 'withhold',
);

/** Problems with a column classification (empty = sound). Raw emission is for operational data only. */
export function siemClassificationProblems(columns: Record<string, SiemColumnClass> = SIEM_SOURCE_COLUMNS): string[] {
  const problems: string[] = [];
  for (const [name, c] of Object.entries(columns)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) problems.push(`${name}: not a plain column identifier`);
    if ((c.treatment === 'emit' || c.treatment === 'emit-code') && c.dataClass !== 'operational') {
      problems.push(`${name}: ${c.dataClass} data must not be emitted raw`);
    }
    if (c.dataClass === 'secret' && c.treatment !== 'withhold' && c.treatment !== 'digest-keys') {
      problems.push(`${name}: secret data must be withheld or digested`);
    }
    if (c.dataClass === 'pii' && c.treatment !== 'pseudonymize' && c.treatment !== 'withhold' && c.treatment !== 'declared-projection') {
      problems.push(`${name}: pii must be pseudonymized, withheld or projected by a declaration`);
    }
    if (c.dataClass === 'billing' && c.treatment !== 'withhold') problems.push(`${name}: billing data is withheld`);
  }
  return problems;
}

export type SiemSourceRow = { readonly [K in SiemSourceColumn]?: unknown };

const DENIED_ERROR_CODES = new Set(['authorization_denied', 'missing_capability', 'role_not_allowed']);
const DENIED_STATUSES = new Set(['role-not-allowed', 'mcp_auth_failed']);
const SUCCESS_STATUSES = new Set(['ok', 'replayed']);

/** Was this invocation refused by identity or authorization (as opposed to failing in the tool)? */
export function isDeniedInvocation(row: Pick<SiemSourceRow, 'status' | 'error_code'>): boolean {
  return DENIED_ERROR_CODES.has(String(row.error_code ?? '')) || DENIED_STATUSES.has(String(row.status ?? ''));
}

function keyBytes(key: Uint8Array | string): Buffer {
  const bytes = typeof key === 'string' ? Buffer.from(key, 'utf8') : Buffer.from(key);
  if (bytes.byteLength < SIEM_MIN_KEY_BYTES) {
    throw new Error(`siem-export: the export key must be at least ${SIEM_MIN_KEY_BYTES} bytes`);
  }
  return bytes;
}

function hmacHex(key: Uint8Array | string, domain: string, value: string): string {
  return createHmac('sha256', keyBytes(key)).update(`${SIEM_EXPORT_SCHEMA}/${domain}\n${value}`, 'utf8').digest('hex');
}

/** A stable keyed pseudonym: the same value under the same key always maps to the same token. */
export function siemPseudonym(key: Uint8Array | string, value: string): string {
  return `psn:${hmacHex(key, 'pseudonym', value).slice(0, 32)}`;
}

export interface SiemArgsDigest {
  readonly keys: readonly string[];
  readonly omittedKeys: number;
  readonly hmac: string;
}

const IDENTIFIER_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Key names plus a KEYED digest: a plain hash of low-entropy arguments is brute-forceable. */
export function siemArgsDigest(key: Uint8Array | string, args: unknown): SiemArgsDigest | null {
  if (args === null || args === undefined) return null;
  let value: unknown = args;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      /* a bare string argument: digest it as is */
    }
  }
  let canonical: string;
  try {
    canonical = canonicalJson(value);
  } catch {
    canonical = `uncanonical:${String(value)}`;
  }
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  const all = isObject ? Object.keys(value as Record<string, unknown>) : [];
  const keys = all.filter((k) => IDENTIFIER_KEY.test(k)).sort();
  return { keys, omittedKeys: all.length - keys.length, hmac: hmacHex(key, 'args', canonical) };
}

/**
 * The ONE emit-code shape both SIEM streams use (WI-6554700010012363): an identifier of 1-128
 * characters from [A-Za-z0-9_.:-], starting with a letter or digit. It admits codes
 * (`authorization_denied`, SQLSTATE `23505`), uuids (an org-audit `target_id`, D-018 item 4),
 * store names, migration file names and build shas. Anything with a space or another free-text
 * character is withheld. Credentials are scrubbed before this check, so an identifier-shaped
 * secret never reaches it.
 */
export const SIEM_CODE_SHAPED = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function scalar(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  try {
    return canonicalJson(value);
  } catch {
    return String(value);
  }
}

function toDate(value: unknown): Date {
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) throw new Error(`siem-export: invalid invoked_at ${JSON.stringify(value)}`);
  return d;
}

/** Shared with siem-export-org-audit.ts so both streams treat a value identically. */
export const siemScalar = scalar;
export const siemAssertKey = (key: Uint8Array | string): void => void keyBytes(key);
/** emit-code: the value when it is a code-shaped identifier, otherwise the free-text marker. */
export function siemCodeValue(value: unknown): string | null {
  const v = scalar(value);
  return v === null ? null : SIEM_CODE_SHAPED.test(String(v)) ? String(v) : SIEM_WITHHELD_FREE_TEXT;
}

export interface SiemPolicyLayerRef {
  readonly layer_id: string;
  readonly level: string;
  readonly version: number;
  readonly content_hash: string;
}

/**
 * The policy chain in effect at `at`: per layer (root first), the latest version recorded at or
 * before `at`. A layer that did not exist yet contributes nothing.
 */
export function policyAt(versionsRootFirst: readonly (readonly PolicyLayerVersion[])[], at: Date): SiemPolicyLayerRef[] {
  const out: SiemPolicyLayerRef[] = [];
  for (const versions of versionsRootFirst) {
    let best: PolicyLayerVersion | null = null;
    for (const v of versions) {
      const recorded = Date.parse(v.recordedAt);
      if (!Number.isFinite(recorded) || recorded > at.getTime()) continue;
      if (!best || v.version > best.version) best = v;
    }
    if (best) out.push({ layer_id: best.layerId, level: best.level, version: best.version, content_hash: best.contentHash });
  }
  return out;
}

export type SiemEvent = { readonly [key: string]: unknown };

export interface ProjectSiemEventContext {
  readonly key: Uint8Array | string;
  readonly policyChain: readonly SiemPolicyLayerRef[];
}

/** Replace credential-shaped string VALUES. Keys are not checked: OCSF's own `authorizations` would trip the key rule. */
export function scrubCredentialValues<T>(value: T): T {
  if (typeof value === 'string') {
    try {
      assertGovernancePayloadSafe(value);
      return value;
    } catch {
      return SIEM_WITHHELD_CREDENTIAL as unknown as T;
    }
  }
  if (Array.isArray(value)) return value.map((v) => scrubCredentialValues(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubCredentialValues(v);
    return out as T;
  }
  return value;
}

/** One tool invocation as a redacted OCSF API Activity event. */
export function projectSiemEvent(row: SiemSourceRow, ctx: ProjectSiemEventContext): SiemEvent {
  const id = String(scalar(row.id) ?? '');
  if (!/^\d+$/.test(id)) throw new Error(`siem-export: row id ${JSON.stringify(row.id)} is not a bigint cursor`);
  const at = toDate(row.invoked_at);
  const denied = isDeniedInvocation(row);
  const status = String(scalar(row.status) ?? '');
  const succeeded = !denied && SUCCESS_STATUSES.has(status);

  const source: Record<string, unknown> = {};
  let args: SiemArgsDigest | null = null;
  for (const column of SIEM_READ_COLUMNS) {
    const cls: SiemColumnClass = SIEM_SOURCE_COLUMNS[column];
    const raw = row[column];
    switch (cls.treatment) {
      case 'emit':
        source[column] = scalar(raw);
        break;
      case 'emit-code':
        source[column] = siemCodeValue(raw);
        break;
      case 'pseudonymize': {
        const v = scalar(raw);
        source[column] = v === null || v === '' ? null : siemPseudonym(ctx.key, String(v));
        break;
      }
      case 'digest-keys':
        args = siemArgsDigest(ctx.key, raw);
        source[column] = args ? { hmac: args.hmac } : null;
        break;
      default:
        break;
    }
  }
  const leaf = ctx.policyChain.length > 0 ? ctx.policyChain[ctx.policyChain.length - 1]! : null;
  const uid = `ti:${id}`;

  const event = {
    class_uid: 6003,
    category_uid: 6,
    activity_id: 99,
    type_uid: 600399,
    time: at.getTime(),
    status_id: succeeded ? 1 : 2,
    status_code: source.status,
    status_detail: source.error_code,
    severity_id: denied ? 3 : 1,
    metadata: {
      version: '1.3.0',
      uid,
      correlation_uid: uid,
      log_name: SIEM_LOG_NAME,
      product: { name: 'Papercusp', vendor_name: 'Papercusp' },
      tenant_uid: source.workspace_id,
    },
    actor: {
      user: { uid: source.coord_owner_id, type: source.principal_kind },
      session: { uid: source.spawn_id },
      authorizations: [
        {
          decision: denied ? 'Denied' : 'Allowed',
          ...(leaf ? { policy: { uid: leaf.layer_id, version: String(leaf.version), name: leaf.level } } : {}),
        },
      ],
    },
    api: {
      operation: source.tool_name,
      service: { name: source.plugin_name },
      request: { uid },
      response: { code: source.status, error: source.error_code },
    },
    unmapped: {
      papercusp_source: source,
      papercusp_policy_chain: ctx.policyChain,
      papercusp_args: args,
    },
  };
  return scrubCredentialValues(event);
}

/** Rows (sorted by id) up to, not including, the first one newer than `bound`. */
export function settledPrefix<R extends Pick<SiemSourceRow, 'invoked_at'>>(rows: readonly R[], bound: Date): R[] {
  const out: R[] = [];
  for (const row of rows) {
    if (toDate(row.invoked_at).getTime() > bound.getTime()) break;
    out.push(row);
  }
  return out;
}

export interface SiemBatchManifest {
  readonly schema: typeof SIEM_EXPORT_SCHEMA;
  readonly streamId: string;
  readonly cursorFrom: string;
  readonly cursorTo: string;
  readonly idempotencyKey: string;
  readonly startAfter: ChainHead | null;
  readonly head: ChainHead | null;
  readonly length: number;
  /** Id of the pseudonym/digest key (`k:` + 16 hex of its sha256). Absent when the caller supplied none. */
  readonly keyId?: string;
}

/**
 * The export bound used for one batch: min(now - settle window, start of the oldest open
 * transaction in this database). Returned BESIDE the batch, never inside the hashed manifest, so
 * replay identity does not depend on when a batch was built.
 */
export interface SiemSettleHorizon {
  readonly bound: Date;
  readonly source: 'settle-window' | 'open-transaction';
  /** false = the export role cannot see every backend, so the bound is the settle window alone. */
  readonly complete: boolean;
  readonly settleMs: number;
  readonly oldestOpenTransactionStart: Date | null;
}

export interface SiemBatch {
  readonly manifest: SiemBatchManifest;
  /** The last link: hand it back as `prevHead` for the next batch. */
  readonly head: ChainLink | null;
  readonly jsonl: string;
  readonly horizon?: SiemSettleHorizon;
}

export interface SiemBatchEntry {
  /** The cursor value of this entry (the stream defines its shape). */
  readonly id: string;
  readonly event: SiemEvent;
}

export const SIEM_ORG_AUDIT_STREAM_PREFIX = 'papercusp.siem-export.org-audit:' as const;

export function siemStreamId(workspaceId: string): string {
  return `papercusp.siem-export:${workspaceId}`;
}

/** The event uid a stream's cursor value names: `ti:<id>`, or `oae:<uuid>` for an org-audit cursor `<time>|<uuid>`. */
export function siemCursorUid(streamId: string, cursor: string): string {
  if (streamId.startsWith(SIEM_ORG_AUDIT_STREAM_PREFIX)) return `oae:${cursor.slice(cursor.lastIndexOf('|') + 1)}`;
  return `ti:${cursor}`;
}

const headOf = (h: ChainHead | null): ChainHead | null => (h ? { seq: h.seq, entryHash: h.entryHash } : null);

export function buildSiemBatch(input: {
  /** Tool-invocation stream of this workspace (ignored when `streamId` is given). */
  readonly workspaceId?: string;
  readonly streamId?: string;
  readonly prevHead: ChainLink | null;
  readonly cursorFrom: string;
  readonly entries: readonly SiemBatchEntry[];
  readonly keyId?: string;
}): SiemBatch {
  const streamId = input.streamId ?? (input.workspaceId ? siemStreamId(input.workspaceId) : null);
  if (!streamId) throw new Error('siem-export: buildSiemBatch needs a streamId or a workspaceId');
  if (input.prevHead && input.prevHead.streamId !== streamId) {
    throw new Error(`siem-export: prevHead belongs to stream '${input.prevHead.streamId}', not '${streamId}'`);
  }
  const links = appendLinks(streamId, input.prevHead, input.entries.map((e) => entryDigest(e.event)));
  const cursorTo = input.entries.length > 0 ? input.entries[input.entries.length - 1]!.id : input.cursorFrom;
  const head = links.length > 0 ? links[links.length - 1]! : input.prevHead;
  const keyed = input.keyId ? { keyId: input.keyId } : {};
  const idempotencyKey = sha256Hex(
    canonicalJson({ schema: SIEM_EXPORT_SCHEMA, streamId, cursorFrom: input.cursorFrom, cursorTo, startAfter: headOf(input.prevHead), ...keyed }),
  );
  const manifest: SiemBatchManifest = {
    schema: SIEM_EXPORT_SCHEMA,
    streamId,
    cursorFrom: input.cursorFrom,
    cursorTo,
    idempotencyKey,
    startAfter: headOf(input.prevHead),
    head: headOf(head),
    length: links.length,
    ...keyed,
  };
  const lines = [canonicalJson({ manifest })];
  input.entries.forEach((e, i) => lines.push(canonicalJson({ entry: e.event, link: links[i]! })));
  return { manifest, head, jsonl: `${lines.join('\n')}\n` };
}

export type SiemBatchVerdict =
  | { readonly ok: true; readonly manifest: SiemBatchManifest; readonly verdict: ChainVerdict; readonly events: readonly SiemEvent[] }
  | { readonly ok: false; readonly reason: string; readonly manifest: SiemBatchManifest | null; readonly verdict: ChainVerdict | null };

/**
 * Verify one delivered batch. Pass `startAfter` = the head the consumer last verified; omit it to
 * check only the batch's own consistency against its manifest.
 */
export function verifySiemBatchJsonl(text: string, opts: { readonly startAfter?: ChainHead | null } = {}): SiemBatchVerdict {
  const lines = text.split('\n').filter((l) => l.length > 0);
  let manifest: SiemBatchManifest | null = null;
  const records: ChainRecord[] = [];
  try {
    const first = JSON.parse(lines[0] ?? 'null') as { manifest?: SiemBatchManifest } | null;
    manifest = first?.manifest ?? null;
    for (const line of lines.slice(1)) {
      const parsed = JSON.parse(line) as { entry?: unknown; link?: ChainLink };
      records.push({ link: parsed.link as ChainLink, entry: parsed.entry });
    }
  } catch (error) {
    return { ok: false, reason: `unparseable batch: ${(error as Error).message}`, manifest, verdict: null };
  }
  if (!manifest || manifest.schema !== SIEM_EXPORT_SCHEMA) {
    return { ok: false, reason: 'missing or foreign manifest', manifest, verdict: null };
  }
  if (manifest.length !== records.length) {
    return { ok: false, reason: `manifest declares ${manifest.length} entries, batch carries ${records.length}`, manifest, verdict: null };
  }
  const startAfter = opts.startAfter !== undefined ? opts.startAfter : manifest.startAfter;
  const verdict = verifyChain(manifest.streamId, records, { requireEntries: true, startAfter, expectedHead: manifest.head });
  if (!verdict.ok) return { ok: false, reason: `chain break: ${verdict.firstBreak.reason}`, manifest, verdict };
  const lastUid = records.length > 0 ? (records[records.length - 1]!.entry as { metadata?: { uid?: string } })?.metadata?.uid : null;
  if (records.length > 0 && lastUid !== siemCursorUid(manifest.streamId, manifest.cursorTo)) {
    return { ok: false, reason: `cursorTo ${manifest.cursorTo} does not match the last event ${String(lastUid)}`, manifest, verdict };
  }
  return { ok: true, manifest, verdict, events: records.map((r) => r.entry as SiemEvent) };
}

/**
 * The export bound: min(now - settle, start of the oldest OPEN transaction in this database).
 *
 * Why every open transaction and not only writing ones (measured, D-018): a row's timestamp is its
 * transaction's START (`DEFAULT now()`), and the organization export writes its receipt only after
 * reading every store, so until that final insert the transaction holds no xid. Any open
 * transaction may still commit a row stamped with its start. A long read-only transaction (a
 * backup) therefore holds the bound back: the export waits, it never skips a row.
 *
 * A backend the export role cannot see reports no `xact_start`, so without superuser or
 * pg_read_all_stats the bound is the settle window alone and `complete` is false.
 */
export async function settleHorizon(sql: Sql, now: Date, settleMs: number = SIEM_DEFAULT_SETTLE_MS): Promise<SiemSettleHorizon> {
  const settled = new Date(now.getTime() - Math.max(0, settleMs));
  const [row] = (await sql`
    SELECT
      COALESCE((SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = current_user), false)
        OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') AS complete,
      (SELECT min(a.xact_start) FROM pg_stat_activity a
        WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
          AND a.backend_type = 'client backend' AND a.xact_start IS NOT NULL) AS oldest`) as unknown as {
    complete: boolean;
    oldest: Date | string | null;
  }[];
  const oldest = row?.oldest ? toDate(row.oldest) : null;
  const byTransaction = oldest !== null && oldest.getTime() < settled.getTime();
  return {
    bound: byTransaction ? oldest : settled,
    source: byTransaction ? 'open-transaction' : 'settle-window',
    complete: row?.complete === true,
    settleMs: Math.max(0, settleMs),
    oldestOpenTransactionStart: oldest,
  };
}

export async function readSiemInvocationPage(
  sql: Sql,
  input: {
    readonly workspaceId: string;
    readonly afterId: string;
    readonly limit: number;
    readonly now: Date;
    readonly settleMs?: number;
    /** Export bound from `settleHorizon`; defaults to now - settle. */
    readonly bound?: Date;
    /** Rebuild a delivered batch: stop at this id (inclusive). */
    readonly upToId?: string;
  },
): Promise<SiemSourceRow[]> {
  if (!input.workspaceId) throw new Error('siem-export: workspaceId is required');
  if (!/^\d+$/.test(input.afterId)) throw new Error(`siem-export: cursor ${JSON.stringify(input.afterId)} is not a bigint`);
  if (input.upToId !== undefined && !/^\d+$/.test(input.upToId)) {
    throw new Error(`siem-export: cursor ${JSON.stringify(input.upToId)} is not a bigint`);
  }
  const limit = Math.max(1, Math.min(SIEM_MAX_PAGE, Math.trunc(input.limit)));
  const select = SIEM_READ_COLUMNS.map((c) => (c === 'id' ? 'id::text AS id' : `"${c}"`)).join(', ');
  const upTo = input.upToId !== undefined ? ' AND id <= $4::bigint' : '';
  const rows = (await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${input.workspaceId}, true)`;
    return tx.unsafe(
      `SELECT ${select} FROM harness_shared.tool_invocations WHERE workspace_id = $1 AND id > $2::bigint${upTo} ORDER BY id LIMIT $3`,
      input.upToId !== undefined ? [input.workspaceId, input.afterId, limit, input.upToId] : [input.workspaceId, input.afterId, limit],
    );
  })) as unknown as SiemSourceRow[];
  return settledPrefix(rows, input.bound ?? new Date(input.now.getTime() - (input.settleMs ?? SIEM_DEFAULT_SETTLE_MS)));
}

export class SiemExportAccessError extends Error {
  readonly code = 'forbidden' as const;
  constructor(detail: string) {
    super(`siem-export: forbidden: ${detail}`);
    this.name = 'SiemExportAccessError';
  }
}

/** Human principals with governance `approve` over the workspace's leaf layer. Fails closed. */
export async function assertSiemExportAuthorized(
  principal: string,
  workspaceId: string,
  opts: { readonly sql?: Sql; readonly now?: Date } = {},
): Promise<{ readonly chain: StoredPolicyLayer[] }> {
  try {
    if (typeof principal !== 'string' || principalKindOf(principal) !== 'human') {
      throw new SiemExportAccessError('only a human principal may export audit evidence');
    }
    const load = await loadChainForWorkspace(workspaceId, opts.sql);
    if (load.status !== 'ok') throw new SiemExportAccessError(`workspace has no valid governance chain (${load.status})`);
    const leaf = load.chain[load.chain.length - 1]!;
    const allowed = await authorize(principal, leaf.layerId, 'approve', { sql: opts.sql, now: opts.now });
    if (!allowed) throw new SiemExportAccessError(`${principal} lacks approve over ${leaf.layerId}`);
    return { chain: load.chain };
  } catch (error) {
    if (error instanceof SiemExportAccessError) throw error;
    throw new SiemExportAccessError(`authorization check failed: ${(error as Error).message}`);
  }
}

export interface ExportSiemPageInput {
  readonly principal: string;
  readonly workspaceId: string;
  /** The last exported row id ('0' for the first batch). */
  readonly afterId: string;
  /** The head returned with the previous batch (null for the first). */
  readonly prevHead: ChainLink | null;
  readonly limit: number;
  /** Pseudonym / digest key, at least 32 bytes. Rotating it starts new pseudonyms. */
  readonly key: Uint8Array | string;
  readonly now?: Date;
  readonly settleMs?: number;
  readonly sql?: Sql;
  /** Stamped in the manifest and idempotency key (siem-export-delivery.ts derives it from the key). */
  readonly keyId?: string;
  /** Rebuild a delivered batch up to this id (inclusive) instead of reading a fresh page. */
  readonly upToId?: string;
}

/** authorize → bound by the settle horizon → read rows → resolve policy at each event's time → project → chain. */
export async function exportSiemPage(input: ExportSiemPageInput): Promise<SiemBatch & { readonly horizon: SiemSettleHorizon }> {
  keyBytes(input.key);
  const db = input.sql ?? getOrgPg().sql;
  const now = input.now ?? new Date();
  const { chain } = await assertSiemExportAuthorized(input.principal, input.workspaceId, { sql: db, now });
  const horizon = await settleHorizon(db, now, input.settleMs);
  const rows = await readSiemInvocationPage(db, {
    workspaceId: input.workspaceId,
    afterId: input.afterId,
    limit: input.limit,
    now,
    bound: horizon.bound,
    upToId: input.upToId,
  });
  const versions = await Promise.all(chain.map((layer) => listVersions(layer.layerId, 500, db)));
  const entries = rows.map((row) => ({
    id: String(scalar(row.id)),
    event: projectSiemEvent(row, { key: input.key, policyChain: policyAt(versions, toDate(row.invoked_at)) }),
  }));
  const batch = buildSiemBatch({ workspaceId: input.workspaceId, prevHead: input.prevHead, cursorFrom: input.afterId, entries, keyId: input.keyId });
  return { ...batch, horizon };
}
