/** Source-defined native capture reconciliation. The activity ledger is an index,
 * never the population. Only host-issued runtime roots define the expected calls;
 * no request can supply a source path, a completeness flag, or a historical floor. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { codexHomeForSessionKey, sessionClaudeConfigDir } from '@papercusp/orchestrator/session-launch-dirs';
import { getOrgPg } from '@papercusp/db-org';
import { resolveMcpName } from '@papercusp/tooldef/tool-projection';
import { canonicalJson } from '../external-bench/reproducibility/canonical-json';
import { ompAgentHomeForSessionKey } from '../session-transcript-resolvers';
import { createNativeTranscriptReader, nativeTimestampMicros as micros, NATIVE_PROVIDERS, type NativeProvider } from './native-operation';
import type { SearchSource } from './search-reformulation';
import { decodeOperatorSecretKey } from '../operator-secret-key';
import { z } from 'zod';

type Client = ReturnType<typeof getOrgPg>['sql'];
type Binding = { id: string; owner: string; provider: NativeProvider; harness: string | null };
type CallEvidence = Record<string, { fingerprint: string; at: string }>;
type SourceContinuation = { snapshot: string; files: Record<string, {
  offset: number; lines: number; identity: boolean; retainedBytes: number; calls: number; fingerprint: string; done: boolean;
}> };
type PreparedNativeCalls = Record<string, { fingerprint: string; scope: 'included' | 'excluded'; activityId: string; at: string }>;
type NativeParsingCoverage = { before: string | null; after: string | null };
type PreparedNativeRoot = { snapshot: string; calls: PreparedNativeCalls; coverage?: NativeParsingCoverage; signature?: string };
type PendingNativeRoot = { continuation: SourceContinuation; calls: PreparedNativeCalls; coverage?: NativeParsingCoverage; signature?: string };
type CaptureReceipt = { manifest?: Record<string, string[]>; enrolling?: boolean;
  sourceEnrollment?: { version: 1; prepared: boolean; snapshots: Record<string, string>; cursor: string | null };
  sourceReconciliation?: { version: 1; window: string; cursor: string | null;
    roots: Record<string, PreparedNativeRoot>;
    pending?: Record<string, PendingNativeRoot>;
    closed?: { from: string; signature: string } };
  population?: string; cursor?: string; scanWindow?: string;
  pendingSources?: Record<string, { continuation: SourceContinuation; calls: CallEvidence; indexFingerprint?: string }>;
  scans?: Record<string, { snapshot: string; fingerprint: string;
    calls: CallEvidence; indexFingerprint?: string }> };
const ENROLLMENT_BATCH = 32;
const SOURCE_CHUNK_BYTES = 4 * 1024 * 1024;
export interface NativeCaptureOptions {
  workspaceId: string; harnessSlug: string; sourceBoundary: string; since: string; until: string;
  client?: Client; authorize: () => Promise<boolean>;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const nativeDispatchReceipt = z.object({
  version: z.literal(1), provider: z.literal('codex'),
  activityId: z.string().regex(/^[1-9]\d*$/),
  workspaceId: z.string().min(1).max(256), harnessSlug: z.string().min(1).max(256),
  ownerId: z.string().min(1).max(256), advSessionId: z.number().int().positive(),
  nativeSessionId: z.string().min(1).max(256), callId: z.string().min(1).max(256),
  toolName: z.string().min(1).max(256), argsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  principal: z.object({ slug: z.string().min(1).max(256), kind: z.string().min(1).max(64),
    authMethod: z.string().min(1).max(64), trust: z.enum(['trusted', 'verified']) }).strict(),
  issuedAt: z.string().datetime(), signature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type NativeDispatchReceipt = z.infer<typeof nativeDispatchReceipt>;
export type NativeDispatchAppend = Omit<NativeDispatchReceipt, 'activityId' | 'version' | 'provider' | 'issuedAt' | 'signature'>;

async function nativeSigningKey(sql: Client) {
  const [key] = await sql<{ value_b64: string }[]>`
    SELECT value_b64 FROM harness_shared.operator_secrets WHERE name='spawn-signing-key'`;
  if (!key) throw new Error('native_dispatch_signing_key_unavailable');
  return decodeOperatorSecretKey(key.value_b64, 'spawn-signing-key');
}
async function nativeDispatchSignature(sql: Client, receipt: Omit<NativeDispatchReceipt, 'signature'>) {
  return createHmac('sha256', await nativeSigningKey(sql))
    .update(canonicalJson(['native-dispatch-receipt-v1', receipt])).digest('hex');
}

/** Protected provenance for saved PARSING, never a read authorization. Bind the
 * exact canonical source population, window, runtime and complete parsed calls;
 * old unsigned preparation cannot be upgraded without rereading its sources. */
function nativePreparationSignature(key: Buffer, opts: NativeCaptureOptions, window: string, binding: Binding,
  evidence: PreparedNativeRoot | PendingNativeRoot) {
  const { signature: _, ...unsigned } = evidence;
  return createHmac('sha256', key).update(canonicalJson(['native-source-preparation-v1',
    opts.workspaceId, opts.harnessSlug, opts.sourceBoundary, window, binding, unsigned])).digest('hex');
}
function verifiedNativePreparation(key: Buffer, opts: NativeCaptureOptions, window: string, binding: Binding,
  evidence: PreparedNativeRoot | PendingNativeRoot) {
  return typeof evidence.signature === 'string' && /^[a-f0-9]{64}$/.test(evidence.signature)
    && timingSafeEqual(Buffer.from(evidence.signature, 'hex'),
      Buffer.from(nativePreparationSignature(key, opts, window, binding, evidence), 'hex'));
}
/** Closest omitted calls bound where this parsed prefix can be reused. These
 * timestamps contain no call content or authority and are signed with the
 * entire preparation. Entering an omitted call requires parsing again. */
function omitNativeCall(coverage: NativeParsingCoverage, at: string, since: string) {
  if (micros(at) < micros(since)) {
    if (coverage.before === null || micros(at) > micros(coverage.before)) coverage.before = at;
  } else if (coverage.after === null || micros(at) < micros(coverage.after)) coverage.after = at;
}
function nativePreparationForWindow<T extends PreparedNativeRoot | PendingNativeRoot>(key: Buffer,
  opts: NativeCaptureOptions, previousWindow: string, window: string, binding: Binding, evidence: T): T | null {
  if (!verifiedNativePreparation(key, opts, previousWindow, binding, evidence)) return null;
  if (previousWindow === window) return evidence;
  const coverage = evidence.coverage && { ...evidence.coverage };
  // Legacy preparation has no proof about calls omitted during parsing. Never
  // upgrade it into broader parsing coverage without reopening its sources.
  if (!coverage || coverage.before !== null && micros(opts.since) <= micros(coverage.before)
    || coverage.after !== null && micros(opts.until) > micros(coverage.after)) return null;
  const calls = { ...evidence.calls };
  for (const [id, call] of Object.entries(calls)) {
    if (micros(call.at) >= micros(opts.since) && micros(call.at) < micros(opts.until)) continue;
    omitNativeCall(coverage, call.at, opts.since); delete calls[id];
  }
  const current = { ...evidence, calls, coverage };
  current.signature = nativePreparationSignature(key, opts, window, binding, current);
  return current;
}
function nativeCaptureFloorSignature(key: Buffer, opts: NativeCaptureOptions, revision: string, from: string) {
  return createHmac('sha256', key).update(canonicalJson(['native-source-floor-v1',
    opts.workspaceId, opts.harnessSlug, opts.sourceBoundary, revision, from])).digest('hex');
}

/** Host-only append after the existing dispatcher's resource ACL. Reuse the
 * activity index and operator signing key, with a separate signing domain.
 * Neither activity:report detail nor a serialized principal can mint a receipt.
 * The host renews possession/principal/turn binding inside this transaction;
 * failed renewal rolls back the append. A receipt attests an authorized attempt,
 * not handler success, transcript completeness, or permission to execute again. */
export async function appendAuthorizedNativeDispatch(input: NativeDispatchAppend,
  authorize: () => Promise<boolean>, client: Client = getOrgPg().sql): Promise<boolean> {
  try {
    if (input.workspaceId === '*' || input.harnessSlug === '*'
      || ['tools:invoke', 'code:run'].includes(input.toolName) || !await authorize()) return false;
    const issuedAt = new Date().toISOString();
    return await client.begin(async transaction => {
      const sql = transaction as unknown as Client;
      if (!await authorize()) throw new Error('native_dispatch_authority_withdrawn');
      // Allocate from the existing sequence, sign that exact ID, then INSERT
      // once. Updating a placeholder would trip the destructive receipt-loss
      // detector and reset every earned floor on every new authorized attempt.
      const [row] = await sql<{ id: string }[]>`SELECT
        nextval(pg_get_serial_sequence('harness_shared.agent_activity','id'))::text AS id`;
      if (!row) throw new Error('native_dispatch_append_unavailable');
      const unsigned = { ...input, activityId: row.id, version: 1 as const, provider: 'codex' as const, issuedAt };
      const receipt = nativeDispatchReceipt.parse({ ...unsigned, signature: await nativeDispatchSignature(sql, unsigned) });
      await sql`INSERT INTO harness_shared.agent_activity
        (id,workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,summary,detail,created_at)
        VALUES (${row.id}::bigint,${input.workspaceId},${input.harnessSlug},${input.ownerId},'codex',${input.nativeSessionId},
          'tool',${input.toolName},'pre',${input.callId},'Authorized native dispatch',
          ${sql.json({ nativeDispatch: receipt })}::jsonb,${issuedAt}::timestamptz)`;
      if (!await authorize()) throw new Error('native_dispatch_authority_withdrawn');
      return true;
    }) as boolean;
  } catch { return false; }
}

/** Verification of a historical attempt only. Exact row/source correlation and
 * current read ACL are separate checks. Arbitrary JSON, changed scope/arguments,
 * and receipts signed under a rotated key cannot pass this check. */
export async function verifyNativeDispatchReceipt(value: unknown, client: Client = getOrgPg().sql): Promise<boolean> {
  try {
    const parsed = nativeDispatchReceipt.safeParse(value);
    if (!parsed.success) return false;
    const { signature, ...unsigned } = parsed.data;
    const expected = await nativeDispatchSignature(client, unsigned);
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

/** @internal Historical per-call authority, never a root or continuity grant.
 * Read the entire exact-call population before filtering by owner/scope/tool.
 * An unsigned event-time index can select the original receipt, but cannot
 * replace it. The caller must independently read the issued runtime's canonical
 * source and call again with that source before exposing a body. Nothing is cached. */
export async function readAuthorizedNativeDispatch(input: {
  id: string; actor: string; provider: NativeProvider; sessionId: string; callId: string;
  source?: SearchSource;
}, opts: Pick<NativeCaptureOptions, 'workspaceId' | 'harnessSlug' | 'sourceBoundary' | 'client' | 'authorize'>) {
  try {
    if (!/^[1-9]\d*$/.test(input.id) || input.provider !== 'codex' || !input.sessionId || !input.callId
      || !opts.sourceBoundary || !opts.harnessSlug || opts.harnessSlug === '*' || !await opts.authorize()) return null;
    const sql = opts.client ?? getOrgPg().sql;
    const session = createHash('sha256').update(input.sessionId).digest('hex');
    const call = createHash('sha256').update(input.callId).digest('hex');
    const read = async () => ({
      activity: [...await sql<{ row: Record<string, unknown>; population: string }[]>`
        SELECT to_jsonb(a) AS row,count(*) OVER ()::text AS population FROM harness_shared.agent_activity a
        WHERE a.id=${input.id}::bigint
          OR (a.session_id=${input.sessionId} AND a.tool_use_id=${input.callId} AND a.kind='tool')
          OR (a.detail->'nativeDispatch'->>'nativeSessionId'=${input.sessionId}
            AND a.detail->'nativeDispatch'->>'callId'=${input.callId}) ORDER BY a.id LIMIT 2`],
      dispatch: [...await sql<{ row: Record<string, unknown>; population: string }[]>`
        SELECT to_jsonb(i) AS row,count(*) OVER ()::text AS population FROM harness_shared.tool_invocations i
        WHERE i.metadata_json->'requestOrigin'->'nativeSession'->>'valueFingerprint'=${session}
          AND i.metadata_json->'requestOrigin'->'nativeSession'->>'callIdFingerprint'=${call}
        ORDER BY i.id LIMIT 2`],
    });
    const before = await read(), d = before.dispatch[0];
    const candidate = before.activity.find(a => String(a.row.id) === input.id)?.row;
    const signed = before.activity.filter(a => Object.hasOwn(a.row.detail ?? {}, 'nativeDispatch'));
    // At most the selected unsigned index and ONE original protected receipt.
    // Count before filtering: a conflicting receipt in another scope is fatal.
    // Row identity and embedded receipt identity are independent selectors:
    // tampering either cannot hide a conflicting copy from this census.
    if (!candidate || signed.length !== 1 || before.activity.some(a => a.population !== String(before.activity.length))
      || before.dispatch.length !== 1 || d?.population !== '1') return null;
    const a = signed[0]!;
    const parsed = nativeDispatchReceipt.safeParse((a.row.detail as { nativeDispatch?: unknown } | null)?.nativeDispatch);
    if (!parsed.success || !await verifyNativeDispatchReceipt(parsed.data, sql)) return null;
    const receipt = parsed.data, row = a.row, invocation = d.row;
    if (receipt.activityId !== String(row.id) || receipt.workspaceId !== opts.workspaceId
      || receipt.harnessSlug !== opts.harnessSlug || receipt.ownerId !== input.actor
      || receipt.nativeSessionId !== input.sessionId || receipt.callId !== input.callId
      || row.workspace_id !== receipt.workspaceId || row.harness_slug !== receipt.harnessSlug
      || row.owner_id !== receipt.ownerId || row.agent !== receipt.provider || row.session_id !== receipt.nativeSessionId
      || row.tool_use_id !== receipt.callId || row.tool_name !== receipt.toolName || row.kind !== 'tool' || row.phase !== 'pre'
      || micros(String(row.created_at)) !== micros(receipt.issuedAt)
      || ['tools:invoke', 'code:run'].includes(receipt.toolName)) return null;
    const eventCopy = String(candidate.id) !== receipt.activityId;
    // The sole optional index copy is part of the exact-call population even
    // when the original receipt was selected. It cannot hide a scope/tool/time
    // conflict merely by being a different row from the caller's selected ID.
    if (before.activity.some(a => String(a.row.id) !== receipt.activityId &&
      (canonicalJson(a.row.detail) !== '{}' || a.row.workspace_id !== receipt.workspaceId
        || a.row.harness_slug !== receipt.harnessSlug || a.row.owner_id !== receipt.ownerId
        || a.row.agent !== receipt.provider || a.row.session_id !== receipt.nativeSessionId
        || a.row.tool_use_id !== receipt.callId || a.row.tool_name !== receipt.toolName
        || a.row.kind !== 'tool' || a.row.phase !== 'pre'
        || input.source && micros(String(a.row.created_at)) !== micros(input.source.at)))) return null;
    if (eventCopy && (canonicalJson(candidate.detail) !== '{}'
      || candidate.workspace_id !== receipt.workspaceId || candidate.harness_slug !== receipt.harnessSlug
      || candidate.owner_id !== receipt.ownerId || candidate.agent !== receipt.provider
      || candidate.session_id !== receipt.nativeSessionId || candidate.tool_use_id !== receipt.callId
      || candidate.tool_name !== receipt.toolName || candidate.kind !== 'tool' || candidate.phase !== 'pre')) return null;
    const origin = (invocation.metadata_json as { requestOrigin?: { transport?: string; nativeSession?: {
      carrier?: string; binding?: string; candidateAdvSessionId?: number;
    } } } | null)?.requestOrigin;
    const args = invocation.args_json;
    if (invocation.workspace_id !== receipt.workspaceId || invocation.harness_slug !== receipt.harnessSlug
      || invocation.coord_owner_id !== receipt.ownerId || invocation.tool_name !== receipt.toolName
      || invocation.transport !== 'mcp' || invocation.principal_kind !== receipt.principal.kind
      || invocation.principal_trust !== receipt.principal.trust || invocation.principal_auth_method !== receipt.principal.authMethod
      || origin?.transport !== 'mcp' || origin.nativeSession?.binding !== 'bound'
      || origin.nativeSession.carrier !== 'meta:threadId' || origin.nativeSession.candidateAdvSessionId !== receipt.advSessionId
      || !args || typeof args !== 'object' || Array.isArray(args) || Object.hasOwn(args, '_truncated')
      || createHash('sha256').update(canonicalJson(args)).digest('hex') !== receipt.argsFingerprint
      || ['harness', 'harness_slug'].some(key => Object.hasOwn(args, key) && (args as Record<string, unknown>)[key] !== receipt.harnessSlug)
      || ['workspace', 'workspace_id'].some(key => Object.hasOwn(args, key) && (args as Record<string, unknown>)[key] !== receipt.workspaceId)) return null;
    const runtime = async () => [...await sql`SELECT id::text,workspace_id,coord_owner_id,agent
      FROM harness_shared.adv_sessions WHERE id=${receipt.advSessionId}::bigint`];
    const runtimes = await runtime(), binding = runtimes[0];
    if (runtimes.length !== 1 || binding?.workspace_id !== receipt.workspaceId
      || binding.coord_owner_id !== receipt.ownerId || binding.agent !== receipt.provider) return null;
    const source = input.source;
    if (source && (source.workspaceId !== receipt.workspaceId || source.harnessSlug !== receipt.harnessSlug
      || source.authorizationScope !== opts.sourceBoundary || source.actor !== receipt.ownerId || source.provider !== receipt.provider
      || source.identityAuthority !== 'provider' || !source.sourceComplete || source.namespace !== receipt.nativeSessionId
      || source.callId !== receipt.callId || resolveMcpName(source.tool)?.expose.mcp?.name !== receipt.toolName
      || canonicalJson(source.args) !== canonicalJson(args)
      || eventCopy && micros(String(candidate.created_at)) !== micros(source.at))) return null;
    // Finish every caller-supplied ACL await BEFORE the final database/key
    // renewal. Even a callback returning true may yield while a receipt,
    // invocation, runtime binding or signing key changes.
    if (!await opts.authorize() || !await opts.authorize()
      || canonicalJson(before) !== canonicalJson(await read())
      || canonicalJson(runtimes) !== canonicalJson(await runtime()) || !await verifyNativeDispatchReceipt(receipt, sql)) return null;
    return { binding: { id: String(receipt.advSessionId), owner: receipt.ownerId,
      provider: receipt.provider, harness: receipt.harnessSlug } satisfies Binding,
      fingerprint: digest(canonicalJson([before, runtimes])) };
  } catch { return null; }
}

/** @internal Reconcile ONE independently read canonical call. The original
 * protected receipt supplies that call's scope, including an explicit exclusion
 * from the requested harness. Neither a current brief nor an unsigned index can
 * exclude a call. No body, root authority or continuity certificate is returned.
 * The caller must renew the canonical source after these database/ACL awaits. */
export async function reconcileAuthorizedNativeCall(source: SearchSource, binding: Binding,
  opts: Pick<NativeCaptureOptions, 'workspaceId' | 'harnessSlug' | 'sourceBoundary' | 'client' | 'authorize'>) {
  try {
    if (source.provider !== 'codex' || source.provider !== binding.provider || source.actor !== binding.owner
      || !source.namespace || !source.callId || !await opts.authorize()) return null;
    const sql = opts.client ?? getOrgPg().sql;
    // Discover the ORIGINAL by exact native identity, before any scope/owner
    // filter. readAuthorizedNativeDispatch independently renews the full receipt
    // and invocation populations, signature, runtime, arguments and current ACL.
    const rows = await sql<{ id: string; receipt: unknown }[]>`
      SELECT id::text,detail->'nativeDispatch' AS receipt FROM harness_shared.agent_activity
      WHERE detail->'nativeDispatch'->>'nativeSessionId'=${source.namespace}
        AND detail->'nativeDispatch'->>'callId'=${source.callId} ORDER BY id LIMIT 2`;
    if (rows.length !== 1) return null;
    const parsed = nativeDispatchReceipt.safeParse(rows[0]!.receipt);
    if (!parsed.success || parsed.data.harnessSlug === '*') return null;
    const receipt = parsed.data;
    const read = await readAuthorizedNativeDispatch({ id: rows[0]!.id, actor: binding.owner,
      provider: binding.provider, sessionId: source.namespace, callId: source.callId,
      source: { ...source, harnessSlug: receipt.harnessSlug } }, { ...opts, harnessSlug: receipt.harnessSlug });
    if (!read || read.binding.id !== binding.id || read.binding.owner !== binding.owner
      || read.binding.provider !== binding.provider) return null;
    return { scope: receipt.harnessSlug === opts.harnessSlug ? 'included' as const : 'excluded' as const,
      fingerprint: read.fingerprint, activityId: rows[0]!.id, at: source.at };
  } catch { return null; }
}
/** D030: exact dispatch correlation is a necessary check, NEVER an authority
 * grant. The existing host stores system-bearer authentication and caller/row
 * consistency, not independently authenticated owner/per-call scope. Keep that
 * distinction in the return type so a candidate cannot certify capture. Call
 * only with a source read from its independently enumerated issued runtime;
 * neither an activity row nor this helper scopes its siblings or its root. */
export async function inspectNativeDispatchCandidate(source: SearchSource, binding: Binding,
  opts: Pick<NativeCaptureOptions, 'workspaceId' | 'client' | 'authorize'>): Promise<{
    authority: 'unknown'; correlation: 'unknown' | 'exact'; candidateHarness?: string; fingerprint?: string;
  }> {
  const unknown = { authority: 'unknown', correlation: 'unknown' } as const;
  const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  try {
    // Native shell/browser tools and code-mode/wrapper fanout have no faithful
    // one-to-one dispatch projection. Do not inspect their program text.
    const tool = resolveMcpName(source.tool)?.expose.mcp?.name;
    const args = object(source.args);
    if (!tool || ['tools:invoke', 'code:run'].includes(tool) || !args || Object.hasOwn(args, '_truncated')
      || !source.callId || !source.namespace || source.workspaceId !== opts.workspaceId
      || source.actor !== binding.owner || source.provider !== binding.provider
      || source.identityAuthority !== 'provider' || !source.sourceComplete
      || !/^\d+$/.test(binding.id) || !await opts.authorize()) return unknown;
    const sql = opts.client ?? getOrgPg().sql;
    const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
    const session = sha(source.namespace), call = sha(source.callId);
    // Match the WHOLE exact-call population, not just this owner/tool/scope or
    // a selected invocation ID. A conflicting sibling dispatch must be visible.
    const read = async () => {
      const runtimes = await sql`SELECT id::text,workspace_id,coord_owner_id,agent
        FROM harness_shared.adv_sessions WHERE id=${binding.id}::bigint`;
      const rows = await sql<{ invocation: Record<string, unknown>; population: string }[]>`
        SELECT to_jsonb(i) AS invocation,count(*) OVER ()::text AS population
        FROM harness_shared.tool_invocations i
        WHERE i.metadata_json->'requestOrigin'->'nativeSession'->>'valueFingerprint'=${session}
          AND i.metadata_json->'requestOrigin'->'nativeSession'->>'callIdFingerprint'=${call}
        ORDER BY i.id LIMIT 2`;
      return { runtimes: [...runtimes], rows: [...rows] };
    };
    const first = await read();
    const runtime = first.runtimes[0], match = first.rows[0];
    if (first.runtimes.length !== 1 || runtime?.workspace_id !== opts.workspaceId
      || runtime.coord_owner_id !== binding.owner || runtime.agent !== binding.provider
      || first.rows.length !== 1 || match?.population !== '1') return unknown;
    const row = match.invocation, origin = object(object(row.metadata_json)?.requestOrigin), native = object(origin?.nativeSession);
    const harness = row.harness_slug;
    if (row.workspace_id !== opts.workspaceId || row.coord_owner_id !== binding.owner || row.tool_name !== tool
      || typeof harness !== 'string' || !harness || harness === '*' || row.transport !== 'mcp'
      || row.principal_trust !== 'trusted' || row.principal_kind !== 'system' || row.principal_auth_method !== 'bearer-token'
      || origin?.transport !== 'mcp' || native?.carrier !== 'meta:threadId' || native.binding !== 'bound'
      || native.candidateAdvSessionId !== Number(binding.id)
      || canonicalJson(args) !== canonicalJson(row.args_json)
      || ['harness', 'harness_slug'].some(key => Object.hasOwn(args, key) && args[key] !== harness)
      || ['workspace', 'workspace_id'].some(key => Object.hasOwn(args, key) && args[key] !== opts.workspaceId)) return unknown;
    // No cache or historical backfill. Recheck live ACL and both canonical
    // populations after the read; changes/deletions cannot retain even an exact
    // candidate. Persisting this correlation as scope would still be incorrect.
    if (!await opts.authorize() || canonicalJson(first) !== canonicalJson(await read())) return unknown;
    return { authority: 'unknown', correlation: 'exact', candidateHarness: harness,
      fingerprint: sha(canonicalJson(first)) };
  } catch { return unknown; }
}
/** Enrollment records source identities, not a claim that their content was
 * captured. Never load historical transcript bodies just to start a prospective
 * interval; the reconciler must validate them before certifying any coverage. */
async function canonicalNativeRuntimeManifest(binding: Binding, deadline: number) {
  if (!/^\d+$/.test(binding.id) || !/^[\w-]+$/.test(binding.owner)
    || !NATIVE_PROVIDERS.includes(binding.provider)) throw new Error('native_capture_binding');
  const root = binding.provider === 'codex' ? join(codexHomeForSessionKey(binding.id), 'sessions')
    : binding.provider === 'claude' ? join(sessionClaudeConfigDir(binding.owner), 'projects')
      : join(ompAgentHomeForSessionKey(binding.id), 'sessions');
  if (await realpath(root) !== resolve(root)) throw new Error('native_capture_source_kind');
  const pattern = new RegExp(binding.provider === 'codex' ? `^rollout-.*-(${uuid})\\.jsonl$`
    : binding.provider === 'claude' ? `^(${uuid})\\.jsonl$` : '^.*_([A-Za-z0-9_-]{6,})\\.jsonl$', 'i');
  let entries = 0;
  const files: { path: string; sessionId: string; stamp: string }[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (Date.now() >= deadline || depth > 4 || (await lstat(dir)).isSymbolicLink()) throw new Error('native_capture_bound');
    const children = await readdir(dir, { withFileTypes: true });
    entries += children.length;
    if (entries > 5000) throw new Error('native_capture_bound');
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, child.name);
      if (child.isDirectory()) { await walk(path, depth + 1); continue; }
      if (!child.isFile()) throw new Error('native_capture_source_kind');
      // Native sidecars are not transcripts. An unidentified JSONL is a gap.
      if (!child.name.endsWith('.jsonl')) continue;
      const match = pattern.exec(child.name);
      if (!match) throw new Error('native_capture_unidentified_source');
      const stat = await lstat(path, { bigint: true });
      files.push({ path, sessionId: match[1]!, stamp: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') });
    }
  };
  await walk(root, 0);
  if (!files.length || files.length > 1000 || new Set(files.map(f => f.sessionId)).size !== files.length)
    throw new Error('native_capture_population');
  return { files, snapshot: digest(files.map(file => [file.sessionId, file.stamp])),
    identities: files.map(file => digest([binding.id, binding.owner, binding.provider, file.sessionId])) };
}

/** Internal source reader shared with hydration. Paths come only from the
 * authenticated runtime. Bounded IO buffers replace a whole-file allocation;
 * provider parser state and line identities survive buffer boundaries. */
export async function canonicalNativeRuntimeSources(binding: Binding, context: {
  workspaceId: string; harnessSlug: string; sourceBoundary: string;
}, deadline = Date.now() + 1000, sessionId?: string, continuation?: SourceContinuation | null) {
  const { files, identities, snapshot } = await canonicalNativeRuntimeManifest(binding, deadline);
  const selected = sessionId ? files.filter(file => file.sessionId === sessionId) : files;
  if (!selected.length) throw new Error('native_capture_identity');
  const sources: SearchSource[] = [], stamps: string[] = [];
  // Only the reconciliation path opts into durable chunks. Hydration still
  // reads/pairs the entire selected source with the maintained stateful parser.
  const chunked = continuation !== undefined;
  const cursor: SourceContinuation = { snapshot, files: continuation?.snapshot === snapshot ? { ...continuation.files } : {} };
  let retainedBytes = 0, stepBytes = 0;
  for (const file of selected) {
    const key = digest([binding.id, binding.owner, binding.provider, file.sessionId]);
    const saved = cursor.files[key];
    if (chunked && saved?.done) continue;
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      const stamp = [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(':');
      if (stamp !== file.stamp || !before.isFile() || Date.now() >= deadline) throw new Error('native_capture_bound');
      const parser = createNativeTranscriptReader({ ...context, authorizationScope: context.sourceBoundary,
        actor: binding.owner, verifiedAgent: true, origin: 'agent', provider: binding.provider,
        sessionId: file.sessionId, complete: true });
      const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
      let length = chunked ? saved?.offset ?? 0 : 0, pending = Buffer.alloc(0),
        lineIndex = chunked ? saved?.lines ?? 0 : 0, identity = chunked ? saved?.identity ?? false : false, expected = 0;
      let eof = false;
      for (;;) {
        // Resume only at a complete record boundary, so no transcript bytes or
        // provider payload have to be stored in the checkpoint. An unfinished
        // record is reread next time (bounded by the existing record limit).
        if (chunked && length - pending.length > (saved?.offset ?? 0)
          && (Date.now() >= deadline - 50 || stepBytes >= SOURCE_CHUNK_BYTES)) break;
        if (Date.now() >= deadline) throw new Error('native_capture_bound');
        const read = await handle.read(buffer, 0, buffer.length, length);
        if (!read.bytesRead) { eof = true; break; }
        length += read.bytesRead;
        stepBytes += read.bytesRead;
        const bytes = buffer.subarray(0, read.bytesRead);
        hash.update(bytes);
        // A multibyte UTF-8 code point may straddle an IO buffer. Decode only
        // complete records, and keep at most one bounded unfinished record.
        const chunk = pending.length ? Buffer.concat([pending, bytes]) : bytes;
        let start = 0;
        for (;;) {
          const end = chunk.indexOf(10, start);
          if (end < 0) break;
          const recordBytes = chunk.subarray(start, end), line = recordBytes.toString('utf8');
          if (line.length > 256_000) throw new Error('native_capture_bound');
          if (!Buffer.from(line).equals(recordBytes)) throw new Error('native_capture_encoding');
          const record = JSON.parse(line) as Record<string, unknown>;
          if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('native_capture_encoding');
          if (lineIndex++ === 0 && binding.provider !== 'claude') {
            if (binding.provider === 'codex' ? record.type !== 'session_meta'
              || (record.payload as { id?: string })?.id !== file.sessionId
              : record.type !== 'session' || record.id !== file.sessionId) throw new Error('native_capture_identity');
            identity = true;
          }
          if (binding.provider === 'claude') {
            if (record.sessionId != null && record.sessionId !== file.sessionId) throw new Error('native_capture_identity');
            if (record.sessionId === file.sessionId) identity = true;
          }
          const payload = record.payload as { type?: string } | undefined;
          const message = record.message as { content?: { type?: string }[] } | undefined;
          expected += binding.provider === 'codex'
            ? Number(record.type === 'response_item' && ['function_call', 'custom_tool_call', 'tool_search_call'].includes(payload?.type ?? ''))
            : Array.isArray(message?.content) ? message.content.filter(b => b.type === (binding.provider === 'claude' ? 'tool_use' : 'toolCall')).length : 0;
          parser.push(line);
          start = end + 1;
        }
        pending = Buffer.from(chunk.subarray(start));
        // Four UTF-8 bytes per code point is a byte bound, not permission to
        // bypass the maintained 256000-character record contract.
        if (pending.length > 4 * 256_000) throw new Error('native_capture_bound');
      }
      const after = await handle.stat({ bigint: true });
      if (stamp !== [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(':')
        || eof && (BigInt(length) !== before.size || pending.length)) throw new Error('native_capture_changed');
      if (eof && !identity) throw new Error('native_capture_identity');
      const parsed = parser.sources();
      if (parsed.length && !identity) throw new Error('native_capture_identity');
      retainedBytes += parser.retainedBytes();
      if (retainedBytes > 32 * 1024 * 1024 || sources.length + parsed.length > 2000)
        throw new Error('native_capture_bound');
      if (expected !== parsed.length) throw new Error('native_capture_parser_gap');
      sources.push(...parsed);
      const fingerprint = digest([file.sessionId, stamp, chunked ? saved?.fingerprint ?? null : null, hash.digest('hex')]);
      stamps.push(fingerprint);
      if (chunked) {
        cursor.files[key] = { offset: length - pending.length, lines: lineIndex, identity,
          retainedBytes: (saved?.retainedBytes ?? 0) + parser.retainedBytes(),
          calls: (saved?.calls ?? 0) + parsed.length, fingerprint, done: eof };
        if (Object.values(cursor.files).reduce((n, f) => n + f.retainedBytes, 0) > 32 * 1024 * 1024
          || Object.values(cursor.files).reduce((n, f) => n + f.calls, 0) > 2000) throw new Error('native_capture_bound');
        if (!eof || stepBytes >= SOURCE_CHUNK_BYTES || Date.now() >= deadline - 50) break;
      }
    } finally { await handle.close(); }
  }
  // Re-census detects a deleted/added predecessor and any source rewrite during IO.
  const current = await canonicalNativeRuntimeManifest(binding, deadline);
  if (JSON.stringify(current.files) !== JSON.stringify(files)) throw new Error('native_capture_changed');
  const complete = !chunked || identities.every(key => cursor.files[key]?.done);
  return { sources, fingerprint: digest(chunked ? identities.map(key => cursor.files[key]?.fingerprint) : stamps),
    identities, snapshot, complete, continuation: chunked ? cursor : null,
    // Hydration renews DB authority after the body read. Close that await gap
    // without rereading bodies or letting a serialized source assert stability.
    unchanged: async () => (await canonicalNativeRuntimeManifest(binding, Date.now() + 1000)).snapshot === snapshot };
}

/** The existing issued-runtime registry defines roots, never their call scope.
 * Attribution is deliberately omitted on the production path: NULL, a current
 * brief, or another harness label cannot remove a possible predecessor. */
async function nativeRuntimePopulation(opts: NativeCaptureOptions, since: string, deadline: number, attribution: boolean) {
  const sql = opts.client ?? getOrgPg().sql, rows: Binding[] = [];
  let cursor = '0';
  for (;;) {
    if (Date.now() >= deadline) throw new Error('native_capture_bound');
    const page = await sql<Binding[]>`SELECT s.id::text,s.coord_owner_id AS owner,s.agent AS provider,
      CASE WHEN ${attribution}::boolean THEN
        harness_shared.harness_slug_for_usage_attribution(s.workspace_id,s.coord_owner_id,s.session_id,s.id)
        ELSE NULL END AS harness
      FROM harness_shared.adv_sessions s WHERE s.workspace_id=${opts.workspaceId} AND s.id > ${cursor}::bigint
        AND s.first_seen_at < ${opts.until}::timestamptz
        AND (s.ended_at IS NULL OR s.ended_at >= ${since}::timestamptz)
      ORDER BY s.id LIMIT 250`;
    rows.push(...page);
    if (page.length < 250) return rows;
    cursor = page.at(-1)!.id;
  }
}

type NativeClosureCall = { key: string; id: string; session: string; call: string; runtime: string };
/** Same unfiltered exact-call populations as readAuthorizedNativeDispatch.
 * This query is also embedded in the progress CAS: a later ACL, filesystem or
 * database await cannot hide a mutation to an earlier INCLUDED or EXCLUDED call.
 * Full current rows are transient only; the progress receipt retains no bodies. */
function nativeClosurePopulation(sql: Client, calls: NativeClosureCall[]) {
  return sql<{ key: string; activity: unknown[]; dispatch: unknown[]; runtimes: unknown[]; signing_key: string | null }[]>`
    SELECT k.key,
      (SELECT COALESCE(jsonb_agg(q.item),'[]'::jsonb) FROM (
        SELECT jsonb_build_object('row',to_jsonb(a),'population',count(*) OVER ()::text) AS item
        FROM harness_shared.agent_activity a WHERE a.id=k.id::bigint
          OR (a.session_id=k.session AND a.tool_use_id=k.call AND a.kind='tool')
          OR (a.detail->'nativeDispatch'->>'nativeSessionId'=k.session AND a.detail->'nativeDispatch'->>'callId'=k.call)
        ORDER BY a.id LIMIT 2) q) AS activity,
      (SELECT COALESCE(jsonb_agg(q.item),'[]'::jsonb) FROM (
        SELECT jsonb_build_object('row',to_jsonb(i),'population',count(*) OVER ()::text) AS item
        FROM harness_shared.tool_invocations i
        WHERE i.metadata_json->'requestOrigin'->'nativeSession'->>'valueFingerprint'=encode(sha256(convert_to(k.session,'UTF8')),'hex')
          AND i.metadata_json->'requestOrigin'->'nativeSession'->>'callIdFingerprint'=encode(sha256(convert_to(k.call,'UTF8')),'hex')
        ORDER BY i.id LIMIT 2) q) AS dispatch,
      (SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) FROM (
        SELECT id::text,workspace_id,coord_owner_id,agent FROM harness_shared.adv_sessions WHERE id=k.runtime::bigint) q) AS runtimes,
      (SELECT value_b64 FROM harness_shared.operator_secrets WHERE name='spawn-signing-key') AS signing_key
    FROM jsonb_to_recordset(${sql.json(calls)}::jsonb) AS k(key text,id text,session text,call text,runtime text)
    ORDER BY k.key`;
}

async function renewNativeCapturePopulation(opts: NativeCaptureOptions, roster: Binding[],
  roots: Record<string, PreparedNativeRoot>, manifest: Record<string, string[]>, deadline: number, preparationKey: Buffer) {
  const sql = opts.client ?? getOrgPg().sql;
  const key = (b: Binding) => digest([b.id, b.owner, b.provider]);
  const unchanged = async () => {
    for (let offset = 0; offset < roster.length; offset += ENROLLMENT_BATCH) {
      if (Date.now() >= deadline) return false;
      const wave = roster.slice(offset, offset + ENROLLMENT_BATCH);
      const reads = await Promise.allSettled(wave.map(b => canonicalNativeRuntimeManifest(b, deadline)));
      for (const [index, read] of reads.entries()) {
        const id = key(wave[index]!);
        if (read.status !== 'fulfilled' || read.value.snapshot !== roots[id]?.snapshot
          || canonicalJson(read.value.identities) !== canonicalJson(manifest[id])) {
          delete roots[id]; return false;
        }
      }
    }
    return true;
  };
  if (!roster.every(b => roots[key(b)]) || !await unchanged()) return null;
  const expected = roster.flatMap(binding => Object.entries(roots[key(binding)]!.calls)
    .map(([id, proof]) => ({ id, proof, binding })));
  if (expected.length > 2000 || new Set(expected.map(c => c.id)).size !== expected.length) return null;
  const calls: NativeClosureCall[] = [];
  // Bound outstanding DB work. A large/slow population still fails closed at
  // the original deadline; a cached scope label is never a substitute.
  for (let offset = 0; offset < expected.length; offset += 8) {
    if (Date.now() >= deadline) return null;
    const results = await Promise.allSettled(expected.slice(offset, offset + 8).map(async ({ id, proof, binding }) => {
      const [row] = await sql<{ receipt: unknown }[]>`SELECT detail->'nativeDispatch' AS receipt
        FROM harness_shared.agent_activity WHERE id=${proof.activityId}::bigint`;
      const parsed = nativeDispatchReceipt.safeParse(row?.receipt);
      if (!parsed.success) throw new Error('native_capture_original_unavailable');
      const receipt = parsed.data;
      if (digest([binding.owner, binding.provider, receipt.nativeSessionId, receipt.callId]) !== id
        || (receipt.harnessSlug === opts.harnessSlug ? 'included' : 'excluded') !== proof.scope)
        throw new Error('native_capture_original_changed');
      const current = await readAuthorizedNativeDispatch({ id: proof.activityId, actor: binding.owner,
        provider: binding.provider, sessionId: receipt.nativeSessionId, callId: receipt.callId },
      { ...opts, harnessSlug: receipt.harnessSlug });
      if (!current || current.fingerprint !== proof.fingerprint || current.binding.id !== binding.id)
        throw new Error('native_capture_authority_changed');
      return { key: id, id: proof.activityId, session: receipt.nativeSessionId, call: receipt.callId, runtime: binding.id };
    }));
    if (results.some(r => r.status !== 'fulfilled')) {
      for (const [index, result] of results.entries())
        if (result.status !== 'fulfilled') delete roots[key(expected[offset + index]!.binding)];
      return null;
    }
    for (const result of results) if (result.status === 'fulfilled') calls.push(result.value);
  }
  // Last caller-owned callbacks BEFORE the global database/key snapshot. Its
  // equality guard runs again inside the progress UPDATE, closing overlap with
  // every subsequent await, including source-manifest renewal.
  if (!await opts.authorize() || !await opts.authorize() || Date.now() >= deadline) return null;
  const current = await nativeClosurePopulation(sql, calls);
  if (current.length !== expected.length) return null;
  const fingerprints = new Map(expected.map(c => [c.id, c.proof.fingerprint]));
  for (const row of current) {
    if (digest(canonicalJson([{ activity: row.activity, dispatch: row.dispatch }, row.runtimes])) !== fingerprints.get(row.key)
      || !row.signing_key || !decodeOperatorSecretKey(row.signing_key, 'spawn-signing-key').equals(preparationKey)) {
      for (const id of Object.keys(roots)) delete roots[id];
      return null;
    }
  }
  // Empty source populations must renew the signing key too.
  if (!(await nativeSigningKey(sql)).equals(preparationKey) || !await unchanged()) return null;
  return { calls, current, unchanged };
}

/** Production continuity boundary (D030). Protected dispatch receipts establish
 * individual historical attempts, not the runtime/source population or its
 * prospective retention floor. The candidate indexer attributes entire roots
 * and writes opts.harnessSlug; it cannot turn per-call proof into continuity.
 * Only a fresh complete-population closure can establish a prospective floor;
 * missing historical authority remains UNKNOWN. */
export async function reconcileNativeCapture(opts: NativeCaptureOptions): Promise<'complete' | 'gap' | 'unknown'> {
  const sql = opts.client ?? getOrgPg().sql, deadline = Date.now() + 1000;
  try {
    if (!opts.workspaceId || opts.workspaceId === '*' || !opts.harnessSlug || opts.harnessSlug === '*'
      || !opts.sourceBoundary || !Number.isFinite(Date.parse(opts.since)) || !Number.isFinite(Date.parse(opts.until))
      || micros(opts.since) >= micros(opts.until) || micros(opts.until) > BigInt(Date.now()) * 1000n
      || !await opts.authorize()) return 'unknown';
    const population = () => nativeRuntimePopulation(opts, opts.since, deadline, false);
    const roster = await population();
    if (!roster.length || !await nativeCaptureInfrastructureReady(sql)) return 'unknown';
    const scope = `native:${digest([opts.workspaceId, opts.harnessSlug, opts.sourceBoundary])}`;
    await sql`INSERT INTO harness_shared.sql_intent_progress (workspace_id,scope_id,harness_slug)
      VALUES (${opts.workspaceId},${scope},${opts.harnessSlug}) ON CONFLICT DO NOTHING`;
    const [progress] = await sql<{ revision: string; receipt: CaptureReceipt | null; since: string }[]>`
      SELECT native_capture_revision::text AS revision,native_capture_receipt AS receipt,
        to_char(native_capture_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS since
      FROM harness_shared.sql_intent_progress WHERE workspace_id=${opts.workspaceId} AND scope_id=${scope}`;
    if (!progress) return 'unknown';
    // Candidate baselines are not production preparation. Preserve source IDs
    // only from this explicit source-enrollment format, with no call authority.
    const prior = progress.receipt?.sourceEnrollment?.version === 1 ? progress.receipt : null;
    const manifest = { ...prior?.manifest }, snapshots = { ...prior?.sourceEnrollment?.snapshots };
    const key = (b: Binding) => digest([b.id, b.owner, b.provider]);
    const keys = new Set(roster.map(key));
    if (Object.keys(manifest).some(id => !keys.has(id))) return 'unknown';
    const remaining = roster.filter(b => !manifest[key(b)] || !snapshots[key(b)]);
    // Rotate failures rather than letting one missing root starve every later
    // issued root. Failed roots stay in the full population and block readiness.
    const cursor = remaining.findIndex(b => key(b) === prior?.sourceEnrollment?.cursor);
    const ordered = cursor < 0 ? remaining : [...remaining.slice(cursor + 1), ...remaining.slice(0, cursor + 1)];
    const revisit = roster.findIndex(b => key(b) === prior?.sourceEnrollment?.cursor);
    const refresh = revisit < 0 ? roster : [...roster.slice(revisit + 1), ...roster.slice(0, revisit + 1)];
    const wave = (ordered.length ? ordered : refresh).slice(0, ENROLLMENT_BATCH);
    const observed = new Map<string, { binding: Binding; snapshot: string }>();
    let last = prior?.sourceEnrollment?.cursor ?? null;
    for (const binding of wave) {
      if (Date.now() >= deadline - 100) break;
      last = key(binding);
      try {
        const source = await canonicalNativeRuntimeManifest(binding, deadline - 100);
        // Losing a predecessor is a gap, never a smaller completed population.
        if (manifest[last]?.some(id => !source.identities.includes(id))) return 'unknown';
        manifest[last] = source.identities; snapshots[last] = source.snapshot;
        observed.set(last, { binding, snapshot: source.snapshot });
      } catch {
        // Retain expected predecessor identities, but revoke their preparation
        // snapshot when a previously observed root becomes unavailable.
        delete snapshots[last];
      }
    }
    if (!await opts.authorize() || !await opts.authorize()
      || canonicalJson(roster) !== canonicalJson(await population())) return 'unknown';
    // Close the ACL/DB await gap without opening any transcript body. A source
    // changed during renewal cannot be saved as this turn's enrollment evidence.
    for (const { binding, snapshot } of observed.values())
      if ((await canonicalNativeRuntimeManifest(binding, deadline)).snapshot !== snapshot) return 'unknown';
    if (Date.now() >= deadline) return 'unknown';
    const prepared = roster.every(b => manifest[key(b)] && snapshots[key(b)]);
    // Source enrollment is only the first phase. On later turns independently
    // enumerate canonical calls from a bounded wave, and reconcile EACH call's
    // own protected receipt. Keep opaque preparation evidence only: saved roots
    // do not certify coverage, and must all be renewed before a future verdict.
    const window = digest([opts.since, opts.until]);
    let preparationKey: Buffer | null = null;
    // Metadata enrollment is useful even before capture authority is installed.
    // Missing/corrupt key blocks protected parsing and closure, not the durable
    // progress of the independently enumerated source population.
    try { preparationKey = await nativeSigningKey(sql); } catch { /* no authority */ }
    const oldReconciliation = prior?.sourceReconciliation;
    const roots = { ...oldReconciliation?.roots };
    const pending = { ...oldReconciliation?.pending };
    const bindings = new Map(roster.map(b => [key(b), b]));
    const expectedCalls = new Map<string, string[]>();
    for (const id of Object.keys(roots)) {
      const binding = bindings.get(id), previous = roots[id]!;
      const root = binding && preparationKey && oldReconciliation
        ? nativePreparationForWindow(preparationKey, opts, oldReconciliation.window, window, binding, previous) : null;
      if (root) expectedCalls.set(id, Object.keys(root.calls));
      if (!root || root.snapshot !== snapshots[id]) delete roots[id];
      else roots[id] = root;
    }
    for (const id of Object.keys(pending)) {
      const binding = bindings.get(id);
      const root = binding && preparationKey && oldReconciliation
        ? nativePreparationForWindow(preparationKey, opts, oldReconciliation.window, window, binding, pending[id]!) : null;
      if (!root || root.continuation.snapshot !== snapshots[id]) delete pending[id];
      else pending[id] = root;
    }
    let sourceCursor = oldReconciliation?.cursor ?? null;
    const currentRoots = new Map<string, { binding: Binding; unchanged: () => Promise<boolean>;
      renewals: { source: SearchSource; fingerprint: string }[] }>();
    if (prepared && prior?.sourceEnrollment?.prepared && preparationKey) {
      const next = roster.findIndex(b => key(b) === sourceCursor);
      const ordered = next < 0 ? roster : [...roster.slice(next + 1), ...roster.slice(0, next + 1)];
      for (const binding of ordered.filter(b => !roots[key(b)]).slice(0, ENROLLMENT_BATCH)) {
        if (Date.now() >= deadline - 100) break;
        sourceCursor = key(binding);
        delete roots[sourceCursor];
        const previousSource = pending[sourceCursor];
        delete pending[sourceCursor];
        try {
          const source = await canonicalNativeRuntimeSources(binding, opts, deadline - 100, undefined,
            previousSource?.continuation ?? null);
          if (source.snapshot !== snapshots[sourceCursor]) continue;
          // Resume source parsing, not authority. Earlier chunks retain only
          // opaque preparation; a future verdict must renew their original
          // sources/receipts too, including every excluded call.
          const calls: PreparedNativeCalls = source.snapshot === previousSource?.continuation.snapshot
            ? { ...previousSource.calls } : {};
          const coverage = previousSource ? previousSource.coverage && { ...previousSource.coverage }
            : { before: null, after: null } satisfies NativeParsingCoverage;
          const renewals: { source: SearchSource; fingerprint: string }[] = [];
          for (const call of source.sources) {
            if (micros(call.at) < micros(opts.since) || micros(call.at) >= micros(opts.until)) {
              if (coverage) omitNativeCall(coverage, call.at, opts.since);
              continue;
            }
            let proof = await reconcileAuthorizedNativeCall(call, binding, opts);
            if (!proof || Date.now() >= deadline - 100) throw new Error('native_capture_call_authority');
            if (proof.scope === 'included') {
              // Reuse the existing event-time index, now from an independently
              // verified canonical call and its original protected receipt.
              // The copy is never an authority source. Excluded calls create
              // no row in the requested harness.
              await sql`INSERT INTO harness_shared.agent_activity
                (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,summary,detail,created_at)
                SELECT a.workspace_id,a.harness_slug,a.owner_id,a.agent,a.session_id,'tool',a.tool_name,'pre',
                  a.tool_use_id,'Canonical native operation','{}'::jsonb,${call.at}::timestamptz
                FROM harness_shared.agent_activity a WHERE a.id=${proof.activityId}::bigint
                  AND a.workspace_id=${opts.workspaceId} AND a.harness_slug=${opts.harnessSlug}
                  AND a.detail ? 'nativeDispatch'
                  AND NOT EXISTS (SELECT 1 FROM harness_shared.agent_activity e WHERE
                    e.session_id=a.session_id AND e.tool_use_id=a.tool_use_id AND e.kind='tool'
                    AND e.created_at=${call.at}::timestamptz)`;
              proof = await reconcileAuthorizedNativeCall(call, binding, opts);
              if (!proof || proof.scope !== 'included') throw new Error('native_capture_event_index_changed');
            }
            const id = digest([call.actor, call.provider, call.namespace, call.callId]);
            if (calls[id]) throw new Error('native_capture_duplicate_call');
            calls[id] = proof; renewals.push({ source: call, fingerprint: proof.fingerprint });
          }
          // Renew earlier calls too: a later call's ACL callback can remove or
          // rewrite the first receipt/invocation or rotate the signing key.
          for (const call of renewals) {
            const proof = await reconcileAuthorizedNativeCall(call.source, binding, opts);
            if (!proof || proof.fingerprint !== call.fingerprint) throw new Error('native_capture_call_changed');
          }
          if (!await opts.authorize() || canonicalJson(roster) !== canonicalJson(await population())
            || !await source.unchanged()) continue;
          if (source.complete) {
            // Rewriting the same predecessor cannot silently shrink a trusted
            // earlier canonical call population in this same window.
            if (expectedCalls.get(sourceCursor)?.some(id => !calls[id])) throw new Error('native_capture_source_call_loss');
            const root: PreparedNativeRoot = { snapshot: source.snapshot, calls, ...(coverage ? { coverage } : {}) };
            root.signature = nativePreparationSignature(preparationKey, opts, window, binding, root);
            roots[sourceCursor] = root;
          } else {
            const root: PendingNativeRoot = { continuation: source.continuation!, calls, ...(coverage ? { coverage } : {}) };
            root.signature = nativePreparationSignature(preparationKey, opts, window, binding, root);
            pending[sourceCursor] = root;
          }
          currentRoots.set(sourceCursor, { binding, unchanged: source.unchanged, renewals });
        } catch { /* An unknown sibling keeps this root unreconciled. */ }
      }
    }
    if (!await opts.authorize() || canonicalJson(roster) !== canonicalJson(await population())) return 'unknown';
    // A later root or the final ACL callback may change an earlier call. In
    // particular an EXCLUDED receipt belongs to another harness, so its loss
    // need not change this scope's revision. Re-open every call in this wave;
    // neither the saved fingerprint nor the requested-scope CAS is authority.
    for (const [id, root] of currentRoots) {
      try {
        for (const call of root.renewals) {
          const proof = await reconcileAuthorizedNativeCall(call.source, root.binding, opts);
          if (!proof || proof.fingerprint !== call.fingerprint) throw new Error('native_capture_call_changed');
        }
        if (!await root.unchanged()) throw new Error('native_capture_changed');
      } catch { delete roots[id]; delete pending[id]; }
    }
    const closure = preparationKey
      ? await renewNativeCapturePopulation(opts, roster, roots, manifest, deadline, preparationKey) : null;
    const savedFloor = prior?.sourceReconciliation?.closed;
    const established = savedFloor && preparationKey && savedFloor.from === progress.since
      && savedFloor.signature === nativeCaptureFloorSignature(preparationKey, opts, progress.revision, savedFloor.from);
    let closed = established ? savedFloor : undefined;
    if (closure && !closed && preparationKey) {
      // A complete present-day scan cannot manufacture historical retention.
      // Establish a floor from the database clock only AFTER actual authority
      // closure, and guard all subsequent database awaits in the final CAS.
      const [floor] = await sql<{ since: string }[]>`SELECT
        to_char(GREATEST(native_capture_from,clock_timestamp()) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS since
        FROM harness_shared.sql_intent_progress WHERE workspace_id=${opts.workspaceId} AND scope_id=${scope}`;
      if (!floor) return 'unknown';
      closed = { from: floor.since, signature: nativeCaptureFloorSignature(preparationKey, opts, progress.revision, floor.since) };
    }
    // Final authority awaits must precede the last filesystem renewal, just as
    // in enrollment. This metadata pass neither reopens bodies nor grants scope.
    for (const { binding, snapshot } of observed.values())
      if ((await canonicalNativeRuntimeManifest(binding, deadline)).snapshot !== snapshot) return 'unknown';
    if (Date.now() >= deadline) return 'unknown';
    const receipt = { version: 1, manifest, population: digest(roster), revision: progress.revision,
      sourceEnrollment: { version: 1, prepared, snapshots, cursor: last },
      sourceReconciliation: { version: 1, window, cursor: sourceCursor, roots, pending,
        ...(closure && closed ? { closed } : {}) } };
    const previous = progress.receipt == null ? null : sql.json(progress.receipt);
    const written = await sql`UPDATE harness_shared.sql_intent_progress SET
      native_capture_from=CASE WHEN ${Boolean(closure && closed)} THEN ${closed?.from ?? progress.since}::timestamptz
        WHEN ${prepared && !prior?.sourceEnrollment?.prepared}
        THEN GREATEST(native_capture_from,clock_timestamp()) ELSE native_capture_from END,
      native_capture_receipt=${sql.json(receipt)}
      WHERE workspace_id=${opts.workspaceId} AND scope_id=${scope}
        AND native_capture_revision=${progress.revision}::bigint
        AND native_capture_receipt IS NOT DISTINCT FROM ${previous}::jsonb
        AND (${!closure} OR (
          (SELECT value_b64 FROM harness_shared.operator_secrets WHERE name='spawn-signing-key')=${preparationKey?.toString('base64') ?? ''}
          AND NOT EXISTS (SELECT 1 FROM (${nativeClosurePopulation(sql, closure?.calls ?? [])}) c
            FULL JOIN jsonb_to_recordset(${sql.json((closure?.current ?? []) as Parameters<Client['json']>[0])}::jsonb)
              AS e(key text,activity jsonb,dispatch jsonb,runtimes jsonb,signing_key text) USING(key)
            WHERE c.key IS NULL OR e.key IS NULL OR
              (c.activity,c.dispatch,c.runtimes,c.signing_key) IS DISTINCT FROM (e.activity,e.dispatch,e.runtimes,e.signing_key))
          AND (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',s.id::text,'owner',s.coord_owner_id,
            'provider',s.agent,'harness',NULL) ORDER BY s.id),'[]'::jsonb) FROM harness_shared.adv_sessions s
            WHERE s.workspace_id=${opts.workspaceId} AND s.first_seen_at < ${opts.until}::timestamptz
              AND (s.ended_at IS NULL OR s.ended_at >= ${opts.since}::timestamptz))=${sql.json(roster)}::jsonb))
      RETURNING 1`;
    // A saved closed marker is never the verdict. Every read above and the
    // atomic global guard must pass again, followed by current source renewal.
    if (!written.length || !closure || !closed || !await closure.unchanged() || Date.now() >= deadline) return 'unknown';
    return !established ? 'unknown' : micros(opts.since) < micros(closed.from) ? 'gap' : 'complete';
  } catch { /* Missing sources/infrastructure/ACL remain UNKNOWN. */ }
  return 'unknown';
}

async function nativeCaptureInfrastructureReady(sql: Client) {
  const [ready] = await sql<{ ready: boolean }[]>`SELECT
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('harness_shared.sql_intent_progress')
      AND attname='native_capture_receipt' AND NOT attisdropped)
    AND (SELECT count(*)=3 FROM pg_trigger WHERE tgrelid=to_regclass('harness_shared.agent_activity')
      AND tgenabled='A' AND NOT tgisinternal AND (tgname,tgtype,tgfoid) IN (
      ('native_capture_index_delete',8,to_regprocedure('harness_shared.native_capture_index_changed()')),
      ('native_capture_index_update',16,to_regprocedure('harness_shared.native_capture_index_changed()')),
      ('native_capture_index_truncate',32,to_regprocedure('harness_shared.native_capture_index_truncated()'))))
    AND (SELECT count(*)=2 FROM pg_trigger WHERE tgrelid=to_regclass('harness_shared.adv_sessions')
      AND tgenabled='A' AND NOT tgisinternal AND (tgname,tgtype,tgfoid) IN (
      ('native_capture_population_delete',8,to_regprocedure('harness_shared.native_capture_population_changed()')),
      ('native_capture_population_update',16,to_regprocedure('harness_shared.native_capture_population_changed()'))))
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('harness_shared.adv_sessions')
      AND tgenabled='A' AND tgname='native_capture_population_truncate' AND tgtype=32
      AND tgfoid=to_regprocedure('harness_shared.native_capture_index_truncated()'))
    AND (SELECT count(*)=3 FROM pg_trigger WHERE tgrelid=to_regclass('harness_shared.session_briefs')
      AND tgenabled='A' AND NOT tgisinternal AND (tgname,tgtype,tgfoid) IN (
      ('native_capture_authority_delete',8,to_regprocedure('harness_shared.native_capture_authority_changed()')),
      ('native_capture_authority_update',16,to_regprocedure('harness_shared.native_capture_authority_changed()')),
      ('native_capture_authority_truncate',32,to_regprocedure('harness_shared.native_capture_index_truncated()')))) AS ready`;
  return ready?.ready === true;
}

/** @internal Technical candidate-index preparation, NOT scope authorization or
 * production continuity. Kept separate to preserve the real filesystem/PG
 * scanner, receipt-time and cache-invalidation regressions. Only the production
 * authority boundary above may certify continuity; this helper cannot do so. */
export async function indexNativeCaptureCandidates(opts: NativeCaptureOptions): Promise<'complete' | 'gap' | 'unknown'> {
  const sql = opts.client ?? getOrgPg().sql, deadline = Date.now() + 1000;
  try {
    if (!opts.harnessSlug || !opts.sourceBoundary || !Number.isFinite(Date.parse(opts.since))
      || !Number.isFinite(Date.parse(opts.until)) || micros(opts.since) >= micros(opts.until)
      || !await opts.authorize()) return 'unknown';
    if (!await nativeCaptureInfrastructureReady(sql)) return 'unknown';
    const scope = `native:${digest([opts.workspaceId, opts.harnessSlug, opts.sourceBoundary])}`;
    await sql`INSERT INTO harness_shared.sql_intent_progress (workspace_id,scope_id,harness_slug)
      VALUES (${opts.workspaceId},${scope},${opts.harnessSlug}) ON CONFLICT DO NOTHING`;
    const [progress] = await sql<{ revision: string; since: string; historical: boolean; future: boolean;
      receipt: CaptureReceipt | null }[]>`
      SELECT native_capture_revision::text AS revision,
        native_capture_receipt AS receipt,
        to_char(GREATEST(native_capture_from,${opts.since}::timestamptz) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS since,
        native_capture_from > ${opts.since}::timestamptz AS historical,
        ${opts.until}::timestamptz > clock_timestamp() AS future
      FROM harness_shared.sql_intent_progress WHERE workspace_id=${opts.workspaceId} AND scope_id=${scope}`;
    if (!progress || progress.future) return 'unknown';
    if (progress.receipt?.sourceEnrollment) return 'unknown';
    const population = () => nativeRuntimePopulation(opts, progress.since, deadline, true);
    const roster = await population();
    const bindings = roster.filter(r => r.harness === opts.harnessSlug);
    if (!bindings.length) return 'unknown';
    if (!progress.receipt || progress.receipt.enrolling) {
      // Enrollment is prospective: a partial manifest certifies no interval.
      // Save opaque source identities between calls instead of rescanning every
      // already-enrolled home before a large roster can make any progress.
      const populationHash = digest(roster);
      // Inserts can grow the roster between batches. Detector revisions already
      // revoke deletion/rebinding, so retain earlier identities and enroll only
      // newly discovered bindings instead of restarting on every insertion.
      const pending = progress.receipt?.enrolling ? progress.receipt : null;
      const manifest = { ...pending?.manifest };
      const remaining = bindings.filter(b => !manifest[digest([b.id, b.owner, b.provider])]);
      let index = 0;
      for (; index < Math.min(ENROLLMENT_BATCH, remaining.length); index++) {
        // Leave budget for the authority/population recheck and durable write.
        if (Date.now() >= deadline - 100) break;
        try {
          const binding = remaining[index]!;
          const read = await canonicalNativeRuntimeManifest(binding, deadline - 100);
          manifest[digest([binding.id, binding.owner, binding.provider])] = read.identities;
        } catch { break; } // Retain earlier progress, but never skip a failed root.
      }
      if (!await opts.authorize() || JSON.stringify(await population()) !== JSON.stringify(roster)) return 'unknown';
      // Unknown attribution remains in the population and blocks completion.
      // It does not prevent preparation of the positively attributed roots.
      const complete = index === remaining.length && !roster.some(r => !r.harness);
      const receipt = complete
        ? { version: 1, baseline: true, sources: Object.values(manifest).reduce((n, ids) => n + ids.length, 0),
            manifest, population: populationHash, revision: progress.revision }
        : { version: 1, enrolling: true, manifest, population: populationHash,
            cursor: index ? digest([remaining[index - 1]!.id, remaining[index - 1]!.owner,
              remaining[index - 1]!.provider]) : pending?.cursor ?? null, revision: progress.revision };
      const previous = progress.receipt == null ? null : sql.json(progress.receipt);
      const written = await sql`UPDATE harness_shared.sql_intent_progress SET
        native_capture_from=CASE WHEN ${complete} THEN GREATEST(native_capture_from,clock_timestamp()) ELSE native_capture_from END,
        native_capture_receipt=${sql.json(receipt)}
        WHERE workspace_id=${opts.workspaceId} AND scope_id=${scope}
          AND native_capture_revision=${progress.revision}::bigint
          AND native_capture_receipt IS NOT DISTINCT FROM ${previous}::jsonb RETURNING 1`;
      return complete && written.length ? 'gap' : 'unknown';
    }
    // Null attribution is not evidence that a session is outside this harness.
    if (roster.some(r => !r.harness)) return 'unknown';
    // Parsing evidence belongs to a source revision, not a census window. Index
    // every parsed call so advancing either endpoint can reuse it. Only opaque
    // identities/conflict digests and event times survive; no bodies or paths.
    // A changed roster still requires fresh authority and all-root validation.
    const populationHash = digest(roster);
    const scanWindow = digest(['native-source-scans-v2', progress.revision]);
    const runtimes = new Set(bindings.map(b => digest([b.id, b.owner, b.provider])));
    const scans: NonNullable<CaptureReceipt['scans']> = progress.receipt.scanWindow === scanWindow
      ? Object.fromEntries(Object.entries(progress.receipt.scans ?? {}).filter(([key]) => runtimes.has(key))) : {};
    const pendingSources: NonNullable<CaptureReceipt['pendingSources']> = progress.receipt.scanWindow === scanWindow
      ? Object.fromEntries(Object.entries(progress.receipt.pendingSources ?? {}).filter(([key]) => runtimes.has(key))) : {};
    const manifest = { ...progress.receipt.manifest };
    // ALWAYS UPDATE/DELETE/TRUNCATE detectors cover destructive changes. INSERT
    // must also invalidate source scans: sequence IDs are allocated before
    // commit, so MAX(id) alone misses a late commit below the visible maximum.
    // Keep only this population digest in the existing receipt, never row IDs.
    const indexSnapshot = async (wave: Binding[]) => {
      const keys = wave.map(b => ({ runtime: digest([b.id, b.owner, b.provider]), owner: b.owner, provider: b.provider }));
      const rows = await sql<{ runtime: string; count: string; maximum: string }[]>`
        SELECT b.runtime,i.count,i.maximum
        FROM jsonb_to_recordset(${sql.json(keys)}::jsonb) AS b(runtime text,owner text,provider text)
        CROSS JOIN LATERAL (SELECT count(*)::text AS count,COALESCE(max(a.id)::text,'0') AS maximum
          FROM harness_shared.agent_activity a WHERE a.workspace_id=${opts.workspaceId}
            AND a.harness_slug=${opts.harnessSlug} AND a.owner_id=b.owner AND a.agent=b.provider AND a.kind='tool') i`;
      return new Map(rows.map(row => [row.runtime, { ...row, fingerprint: digest([row.count, row.maximum]) }] as const));
    };
    const inWindow = (at: string) => micros(at) >= micros(progress.since) && micros(at) < micros(opts.until);
    const savePartial = async () => {
      if (Date.now() >= deadline || !await opts.authorize()
        || JSON.stringify(await population()) !== JSON.stringify(roster)) return;
      const receipt = {
        version: 1, reconciling: true, manifest, population: populationHash, scanWindow, scans, pendingSources,
        revision: progress.revision };
      const written = await sql`UPDATE harness_shared.sql_intent_progress SET native_capture_receipt=${sql.json(receipt)}
        WHERE workspace_id=${opts.workspaceId} AND scope_id=${scope}
          AND native_capture_revision=${progress.revision}::bigint
          AND native_capture_receipt IS NOT DISTINCT FROM ${sql.json(progress.receipt)}::jsonb RETURNING 1`;
      if (!written.length) throw new Error('native_capture_receipt_changed');
      progress.receipt = structuredClone(receipt);
    };
    let indexChanged = false;
    const cached = bindings.filter(b => {
      const runtime = digest([b.id, b.owner, b.provider]);
      return scans[runtime] || pendingSources[runtime];
    });
    for (let offset = 0; offset < cached.length; offset += ENROLLMENT_BATCH) {
      if (Date.now() >= deadline) return 'unknown';
      const wave = cached.slice(offset, offset + ENROLLMENT_BATCH), current = await indexSnapshot(wave);
      for (const binding of wave) {
        const runtime = digest([binding.id, binding.owner, binding.provider]);
        const saved = scans[runtime] ?? pendingSources[runtime];
        if (!saved?.indexFingerprint || saved.indexFingerprint !== current.get(runtime)?.fingerprint) {
          delete scans[runtime]; delete pendingSources[runtime]; indexChanged = true;
        }
      }
    }
    // Revoke cached completeness before a conflicting row can abort the parse.
    // Do not reset native_capture_from: a new index row is not a new install.
    if (indexChanged) await savePartial();
    const remaining = bindings.filter(b => !scans[digest([b.id, b.owner, b.provider])]);
    for (const binding of remaining.slice(0, ENROLLMENT_BATCH)) {
      if (Date.now() >= deadline - 100) { await savePartial(); return 'unknown'; }
      const runtime = digest([binding.id, binding.owner, binding.provider]);
      const pendingSource = pendingSources[runtime];
      let read: Awaited<ReturnType<typeof canonicalNativeRuntimeSources>>;
      try { read = await canonicalNativeRuntimeSources(binding, opts, deadline - 100, undefined,
        pendingSource?.continuation ?? null); }
      catch { await savePartial(); return 'unknown'; }
      if (progress.receipt?.manifest?.[runtime]?.some(identity => !read.identities.includes(identity))) return 'unknown';
      if (read.sources.some(s => !s.callId || !Number.isFinite(Date.parse(s.at)))) return 'unknown';
      // Call IDs identify requests; same-ID conflicting copies cannot be repaired.
      const unique = new Map<string, SearchSource>();
      for (const source of read.sources) {
        const key = JSON.stringify([source.actor, source.provider, source.namespace, source.callId]);
        const prior = unique.get(key);
        if (prior && digest([prior.tool, prior.args, prior.at]) !== digest([source.tool, source.args, source.at])) return 'unknown';
        unique.set(key, source);
      }
      const callDigests: CallEvidence = pendingSource?.continuation.snapshot === read.snapshot ? { ...pendingSource.calls } : {};
      for (const [key, s] of unique) {
        const id = digest(key), value = { fingerprint: digest([s.tool, s.args, s.at]), at: s.at };
        if (callDigests[id] && callDigests[id]!.fingerprint !== value.fingerprint) return 'unknown';
        callDigests[id] = value;
        if (Object.keys(callDigests).length > 2000) return 'unknown';
      }
      const aggregate = new Map<string, string>();
      for (const entries of [...Object.values(scans).map(scan => scan.calls), callDigests]) {
        for (const [key, value] of Object.entries(entries)) {
          if (!inWindow(value.at)) continue;
          if (aggregate.has(key) && aggregate.get(key) !== value.fingerprint) return 'unknown';
          aggregate.set(key, value.fingerprint);
          if (aggregate.size > 2000) return 'unknown';
        }
      }
      // Use the existing canonical index. Retain no command, arguments, result
      // body or path in the receipt. Hydration rereads canonical sources.
      if (Date.now() >= deadline || !await opts.authorize()) return 'unknown';
      const expected = [...unique.values()].map(s => ({ actor: s.actor, provider: s.provider,
        session: s.namespace, call: s.callId, tool: s.tool, at: s.at }));
      let indexFingerprint: string | undefined;
      if (expected.length) {
        // Two set operations, not two round trips per call. The bounded census
        // must remain practical for a real native window containing many calls.
        // Hook created_at is receipt time, while this index copy uses canonical
        // event time for window pagination. Preserve the receipt and add the
        // event copy when needed; a same-ID tool conflict must never be repaired
        // by adding a matching copy beside it.
        await sql`INSERT INTO harness_shared.agent_activity
          (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,summary,detail,created_at)
          SELECT ${opts.workspaceId},${opts.harnessSlug},s.actor,s.provider,s.session,'tool',s.tool,'pre',
            s.call,'Canonical native operation','{}'::jsonb,s.at::timestamptz
          FROM jsonb_to_recordset(${sql.json(expected)}::jsonb)
            AS s(actor text,provider text,session text,call text,tool text,at text)
          WHERE NOT EXISTS (SELECT 1 FROM harness_shared.agent_activity a WHERE a.workspace_id=${opts.workspaceId}
            AND a.harness_slug=${opts.harnessSlug} AND a.owner_id=s.actor AND a.agent=s.provider
            AND a.session_id=s.session AND a.tool_use_id=s.call AND a.kind='tool'
            AND (a.tool_name IS DISTINCT FROM s.tool OR a.created_at=s.at::timestamptz))`;
        // Compare again rather than inferring that successful INSERTs covered calls.
        const [row] = await sql<{ complete: boolean; count: string; maximum: string }[]>`SELECT NOT EXISTS(
          SELECT 1 FROM jsonb_to_recordset(${sql.json(expected)}::jsonb)
            AS s(actor text,provider text,session text,call text,tool text,at text)
          WHERE NOT EXISTS (SELECT 1 FROM harness_shared.agent_activity a WHERE a.workspace_id=${opts.workspaceId}
            AND a.harness_slug=${opts.harnessSlug} AND a.owner_id=s.actor AND a.agent=s.provider
            AND a.session_id=s.session AND a.tool_use_id=s.call AND a.tool_name=s.tool AND a.kind='tool'
            AND a.created_at=s.at::timestamptz)
          OR EXISTS (SELECT 1 FROM harness_shared.agent_activity a WHERE a.workspace_id=${opts.workspaceId}
            AND a.harness_slug=${opts.harnessSlug} AND a.owner_id=s.actor AND a.agent=s.provider
            AND a.session_id=s.session AND a.tool_use_id=s.call AND a.kind='tool'
            AND a.tool_name IS DISTINCT FROM s.tool)) AS complete,i.count,i.maximum
          FROM (SELECT count(*)::text AS count,COALESCE(max(a.id)::text,'0') AS maximum
            FROM harness_shared.agent_activity a WHERE a.workspace_id=${opts.workspaceId}
              AND a.harness_slug=${opts.harnessSlug} AND a.owner_id=${binding.owner}
              AND a.agent=${binding.provider} AND a.kind='tool') i`;
        if (!row?.complete) return 'unknown';
        // Same statement snapshot as the identity/tool checks, after our own
        // event INSERTs. A concurrent hook cannot be silently incorporated.
        indexFingerprint = digest([row.count, row.maximum]);
      }
      indexFingerprint ??= (await indexSnapshot([binding])).get(runtime)?.fingerprint;
      if (!indexFingerprint) return 'unknown';
      manifest[runtime] = read.identities;
      if (!read.complete) {
        pendingSources[runtime] = { continuation: read.continuation!, calls: callDigests, indexFingerprint };
        await savePartial(); return 'unknown';
      }
      delete pendingSources[runtime];
      scans[runtime] = { snapshot: read.snapshot, fingerprint: read.fingerprint, calls: callDigests, indexFingerprint };
    }
    if (remaining.length > ENROLLMENT_BATCH) { await savePartial(); return 'unknown'; }
    const calls = new Map<string, string>(), fingerprints: string[] = [];
    let sourceCount = 0;
    const indexChecks: { owner: string; provider: NativeProvider; count: string; maximum: string }[] = [];
    // Re-census every root before using earlier batches. A stat change forces a
    // fresh parse; a missing predecessor can never vanish from the manifest.
    // This final metadata pass retains the original deadline and fails closed.
    for (let offset = 0; offset < bindings.length; offset += ENROLLMENT_BATCH) {
      if (Date.now() >= deadline) return 'unknown';
      const wave = bindings.slice(offset, offset + ENROLLMENT_BATCH);
      // Bound outstanding filesystem work and drain the entire wave even when
      // one root fails. Never certify a saved snapshot without a fresh read.
      const results = await Promise.allSettled(wave.map(binding => canonicalNativeRuntimeManifest(binding, deadline)));
      const currentIndex = await indexSnapshot(wave);
      let changed = false;
      for (const [index, result] of results.entries()) {
        const binding = wave[index]!;
        const runtime = digest([binding.id, binding.owner, binding.provider]);
        const scan = scans[runtime];
        const indexState = currentIndex.get(runtime);
        if (result.status === 'rejected' || !scan || result.value.snapshot !== scan.snapshot
          || !indexState || scan.indexFingerprint !== indexState.fingerprint) {
          delete scans[runtime]; changed = true; continue;
        }
        indexChecks.push({ owner: binding.owner, provider: binding.provider, count: indexState.count, maximum: indexState.maximum });
        sourceCount += result.value.identities.length;
        fingerprints.push(scan.fingerprint);
        for (const [key, value] of Object.entries(scan.calls)) {
          if (!inWindow(value.at)) continue;
          if (calls.has(key) && calls.get(key) !== value.fingerprint) return 'unknown';
          calls.set(key, value.fingerprint);
          if (calls.size > 2000) return 'unknown';
        }
      }
      if (changed) { await savePartial(); return 'unknown'; }
    }
    if (Date.now() >= deadline || !await opts.authorize() || JSON.stringify(await population()) !== JSON.stringify(roster)) return 'unknown';
    if (micros(progress.since) >= micros(opts.until)) return 'gap';
    const receipt = { version: 1, since: progress.since, until: opts.until, sources: sourceCount, manifest,
      scanWindow, scans,
      runtimes: fingerprints.length,
      calls: calls.size, population: populationHash, canonical: digest(fingerprints), revision: progress.revision };
    const written = await sql`UPDATE harness_shared.sql_intent_progress SET native_capture_receipt=${sql.json(receipt)}
      WHERE workspace_id=${opts.workspaceId} AND scope_id=${scope} AND native_capture_revision=${progress.revision}::bigint
        AND native_capture_receipt IS NOT DISTINCT FROM ${sql.json(progress.receipt)}::jsonb
        AND NOT EXISTS (SELECT 1
          FROM jsonb_to_recordset(${sql.json(indexChecks)}::jsonb)
            AS b(owner text,provider text,count text,maximum text)
          CROSS JOIN LATERAL (SELECT count(*)::text AS count,COALESCE(max(a.id)::text,'0') AS maximum
            FROM harness_shared.agent_activity a WHERE a.workspace_id=${opts.workspaceId}
              AND a.harness_slug=${opts.harnessSlug} AND a.owner_id=b.owner AND a.agent=b.provider AND a.kind='tool') i
          WHERE i.count IS DISTINCT FROM b.count OR i.maximum IS DISTINCT FROM b.maximum)
      RETURNING 1`;
    if (!written.length) {
      for (const key of Object.keys(scans)) delete scans[key];
      await savePartial();
    }
    return written.length ? progress.historical ? 'gap' : 'complete' : 'unknown';
  } catch { return 'unknown'; }
}
