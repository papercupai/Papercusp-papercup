/**
 * session-transcript-resolvers — locate the on-disk transcript file for a
 * CODEX or OMP session, the non-claude legs of the agents-roster thinking pane
 * (claude resolution lives in claude-sessions.ts `findSessionTranscript`).
 *
 * Both resolvers are cheap bounded walks (a handful of readdirs, never an
 * all-owners sweep) and cache POSITIVE resolutions. Misses are NOT cached: the
 * thinking endpoint polls for a not-yet-written transcript (a live session
 * pre-first-turn) and must see it the moment it appears.
 *
 * ⚠ The cache's validity rule DIFFERS BY WHAT THE KEY NAMES, and conflating the two
 * is what caused EI-20219088862022620 (see CODEX_KEY_CACHE_TTL_MS below):
 *   - a key naming ONE FILE (a rollout uuid, an omp thread id) — "stable once
 *     written" holds, so an existence re-stat is a sufficient guard;
 *   - a key naming a DIRECTORY TO SEARCH (`findCodexRolloutPath`'s adv-session id →
 *     "the newest rollout in this CODEX_HOME") — the right answer MOVES to a new
 *     file on every carry-respawn while the old one lives on, so existence proves
 *     nothing and the entry must also expire.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';
import type { Sql } from 'postgres';
import type { IdentityTurnUsageBinding, IdentityTurnBilledCost } from './cupboard/shadow-metering-reader';
import type { ClosedCodexSessionPopulation, ClosedClaudeSessionPopulation } from './interactive-usage/ingest-adapters';
import { codexToolCallArgsRaw } from './transcript-wire';

class CodexSourceProofError extends Error {
  constructor(readonly code: Exclude<IdentityTurnBilledCost, { ok: true }>['code'], detail: string) { super(detail); }
}

/** One stable, complete host-owned source for both token and monetary proofs. */
async function readCompleteCodexSource(binding: { nativeSessionId: string; codexHome: string }) {
  const file = await findCodexRolloutPathByUuid(binding.nativeSessionId, { homeOverride: binding.codexHome });
  if (!file) throw new CodexSourceProofError('identity-usage-incomplete', 'the host native transcript is unavailable');
  return readCompleteNativeSource(binding.codexHome, 'sessions', file);
}

/** Shared physical byte proof for both maintained native CLI formats. */
async function readCompleteNativeSource(home: string, directory: 'sessions' | 'projects', file: string) {
  const [{ constants }, path] = await Promise.all([import('node:fs'), import('node:path')]);
  const root = path.join(await fs.realpath(home), directory);
  // The maintained container wrapper relocates the host-issued home itself.
  // Resolve that capability root, while refusing links below it: a rollout
  // cannot redirect the proof to a different file inside or outside the home.
  const relative = path.relative(path.resolve(home, directory), file);
  const realFile = await fs.realpath(file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ||
      realFile !== path.join(root, relative)) {
    throw new CodexSourceProofError('identity-usage-binding-mismatch', 'the native transcript must belong to this exact runtime home');
  }
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > 16 * 1024 * 1024) throw new CodexSourceProofError('identity-usage-incomplete', 'native transcript size is incomplete or unbounded');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw new CodexSourceProofError('identity-usage-incomplete', 'the native transcript changed during proof');
      offset += read.bytesRead;
    }
    const unchanged = async () => {
      const after = await fs.lstat(file);
      return after.isFile() && before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
        before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
    };
    if (!await unchanged()) throw new CodexSourceProofError('identity-usage-incomplete', 'the native transcript changed during proof');
    const transcript = bytes.toString('utf8');
    if (!Buffer.from(transcript, 'utf8').equals(bytes)) throw new CodexSourceProofError('identity-usage-incomplete', 'the native source is not complete UTF-8');
    return { file, transcript, sourceSha256: createHash('sha256').update(bytes).digest('hex'), unchanged };
  } finally { await handle.close(); }
}

type ClosedCodexSourceSubtotal = Extract<ClosedCodexSessionPopulation, { ok: true }> & {
  readonly file: string; readonly sourceSha256: string;
};
export type ClosedCodexSessionUsage = ClosedCodexSourceSubtotal |
  (Extract<ClosedCodexSessionPopulation, { ok: false }> & { readonly knownSubtotal?: ClosedCodexSourceSubtotal });

type ClosedClaudeSourceSubtotal = Extract<ClosedClaudeSessionPopulation, { ok: true }> & {
  readonly file: string; readonly sourceSha256: string;
};
export type ClosedClaudeSessionUsage = ClosedClaudeSourceSubtotal |
  (Extract<ClosedClaudeSessionPopulation, { ok: false }> & { readonly knownSubtotal?: ClosedClaudeSourceSubtotal });

/** All native sources in one issued Claude home, including earlier carries.
 * Non-transcript sidecars are not usage. Unknown or subagent JSONL sources
 * keep accounting incomplete until their identity/attribution is supported. */
async function listClaudeRuntimeSources(home: string) {
  const found: { nativeSessionId: string; file: string; sourceStamp: string }[] = [];
  let entries = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    const children = await fs.readdir(dir, { withFileTypes: true });
    entries += children.length;
    if (entries > 5000) throw new Error('native source directory census exceeds its bound');
    for (const child of children) {
      const file = join(dir, child.name);
      if (child.isDirectory() && depth < 5) { await walk(file, depth + 1); continue; }
      if (!child.isFile()) throw new Error('native source directory contains a link or unbounded subtree');
      if (!child.name.endsWith('.jsonl')) continue;
      const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(child.name);
      if (!match || depth !== 1) throw new Error('native source directory contains an unidentified transcript');
      const stat = await fs.lstat(file, { bigint: true });
      if (!stat.isFile()) throw new Error('native source census changed file kind');
      found.push({ nativeSessionId: match[1].toLowerCase(), file,
        sourceStamp: [file, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':') });
    }
  };
  await walk(join(home, 'projects'), 0);
  if (!found.length || found.length > 1000 || new Set(found.map(s => s.nativeSessionId)).size !== found.length) {
    throw new Error('native source census is empty or ambiguous');
  }
  return found.sort((a, b) => a.nativeSessionId.localeCompare(b.nativeSessionId));
}

async function readClosedClaudeSourceUsage(sql: Sql, binding: { workspaceId: string; nativeSessionId: string; claudeConfigDir: string },
  file: string): Promise<ClosedClaudeSessionUsage> {
  const fail = (detail: string): ClosedClaudeSessionUsage => ({ ok: false, detail });
  try {
    const source = await readCompleteNativeSource(binding.claudeConfigDir, 'projects', file);
    const [frontier] = await sql<{ byte_offset: string; parser_state: { fileGeneration?: number; initialized?: boolean; bootstrapOffset?: number } }[]>`
      SELECT byte_offset::text, parser_state FROM harness_shared.interactive_usage_files
      WHERE workspace_id = ${binding.workspaceId} AND file_path = ${source.file}`;
    const offset = Number(frontier?.byte_offset), sourceBytes = Buffer.byteLength(source.transcript);
    if (!frontier || frontier.parser_state?.initialized !== true || frontier.parser_state.bootstrapOffset !== undefined ||
        !Number.isSafeInteger(offset) || offset < 0 || offset > sourceBytes) {
      return fail('the canonical ingest frontier must identify verified native source bytes');
    }
    const { closedClaudeSessionPopulation } = await import('./interactive-usage/ingest-adapters');
    const input = { file: source.file, fileGeneration: frontier.parser_state.fileGeneration ?? 0, nativeSessionId: binding.nativeSessionId };
    const population = offset === sourceBytes ? closedClaudeSessionPopulation({ ...input, transcript: source.transcript }) :
      fail('the canonical ingest frontier does not cover the entire native source');
    if (!await source.unchanged()) return fail('the native source changed while reconciling its frontier');
    if (population.ok) return { ...population, file: source.file, sourceSha256: source.sourceSha256 };
    // Locate an earlier message closure inside the atomic frontier. The same
    // strict parser validates that whole prefix; it never turns a subtotal
    // into completeness or invents a synthetic native turn.
    let start = 0, consumedBytes = 0, closedEnd = 0;
    while (start < source.transcript.length) {
      const end = source.transcript.indexOf('\n', start);
      if (end < 0) break;
      const line = source.transcript.slice(start, end); consumedBytes += Buffer.byteLength(line + '\n');
      if (consumedBytes > offset) break;
      let record: { type?: unknown; message?: { stop_reason?: unknown } };
      try { record = JSON.parse(line); } catch { break; }
      if (!record || typeof record !== 'object' || Array.isArray(record)) break;
      if (record.type === 'assistant' && typeof record.message?.stop_reason === 'string') closedEnd = end + 1;
      start = end + 1;
    }
    if (!closedEnd) return population;
    const known = closedClaudeSessionPopulation({ ...input, transcript: source.transcript.slice(0, closedEnd) });
    return known.ok ? { ok: false, detail: population.detail,
      knownSubtotal: { ...known, file: source.file, sourceSha256: source.sourceSha256 } } : population;
  } catch { return fail('the complete native source and canonical frontier could not be verified'); }
}

/** Source-bound Claude message usage. Exact home/session comes from the
 * enrolled host. This supplies tokens and identities, never provider bills. */
export async function readClosedClaudeSessionUsage(sql: Sql, input: {
  readonly workspaceId: string; readonly nativeSessionId: string; readonly claudeConfigDir: string;
}): Promise<ClosedClaudeSessionUsage> {
  const binding = { ...input };
  try {
    if ([binding.workspaceId, binding.nativeSessionId, binding.claudeConfigDir].some(v => typeof v !== 'string' || !v.trim())) {
      throw new Error('missing native binding');
    }
    const census = await listClaudeRuntimeSources(binding.claudeConfigDir);
    const source = census.find(s => s.nativeSessionId === binding.nativeSessionId);
    if (!source) throw new Error('exact native source unavailable');
    const usage = await readClosedClaudeSourceUsage(sql, binding, source.file);
    return JSON.stringify(census) === JSON.stringify(await listClaudeRuntimeSources(binding.claudeConfigDir)) ? usage :
      { ok: false, detail: 'the native source census changed while verifying usage' };
  } catch { return { ok: false, detail: 'the exact host-owned native source could not be verified' }; }
}

type ClaudeMessageEvidenceBinding = {
  readonly workspaceId: string; readonly nativeSessionId: string; readonly claudeConfigDir: string;
  readonly nativeMessageId: string; readonly messageRecordIndex: number; readonly sourceSha256: string;
};
type ClaudeEvidenceRecord = {
  type?: unknown; sessionId?: unknown; uuid?: unknown; parentUuid?: unknown; timestamp?: unknown;
  message?: { role?: unknown; id?: unknown; stop_reason?: unknown; content?: unknown };
};

/** Share the canonical complete-source/frontier proof with usage accounting.
 * A Claude message is a measured provider identity, never a synthetic turn. */
async function readClosedClaudeMessageSource(sql: Sql, binding: ClaudeMessageEvidenceBinding) {
  if ([binding.workspaceId, binding.nativeSessionId, binding.claudeConfigDir, binding.nativeMessageId]
      .some(v => typeof v !== 'string' || !v.trim()) || !/^[a-f0-9]{64}$/.test(binding.sourceSha256) ||
      !Number.isSafeInteger(binding.messageRecordIndex) || binding.messageRecordIndex < 0) return null;
  const census = await listClaudeRuntimeSources(binding.claudeConfigDir);
  const entry = census.find(row => row.nativeSessionId === binding.nativeSessionId);
  if (!entry) return null;
  const source = await readCompleteNativeSource(binding.claudeConfigDir, 'projects', entry.file);
  const population = await readClosedClaudeSessionUsage(sql, binding);
  if (!population.ok || population.file !== source.file || population.sourceSha256 !== source.sourceSha256 ||
      source.sourceSha256 !== binding.sourceSha256 || !population.nativeMessageIds.includes(binding.nativeMessageId)) return null;
  const records: ClaudeEvidenceRecord[] = source.transcript.slice(0, -1).split('\n').map(line => JSON.parse(line));
  const message = records[binding.messageRecordIndex];
  const messageAt = typeof message?.timestamp === 'string' ? Date.parse(message.timestamp) : NaN;
  if (message?.type !== 'assistant' || message.sessionId !== binding.nativeSessionId ||
      message.message?.role !== 'assistant' || message.message.id !== binding.nativeMessageId ||
      typeof message.message.stop_reason !== 'string' || !Number.isFinite(messageAt)) return null;
  const ordinals = new Map<string, number>();
  for (const [index, record] of records.entries()) {
    if (typeof record.uuid !== 'string' || !record.uuid.trim()) continue;
    if (ordinals.has(record.uuid)) return null;
    ordinals.set(record.uuid, index);
  }
  const ancestor = (recordIndex: number, descendantIndex = binding.messageRecordIndex) => {
    if (!Number.isSafeInteger(recordIndex) || recordIndex < 0 || recordIndex >= descendantIndex) return false;
    let index = descendantIndex;
    while (index >= recordIndex) {
      const record = records[index];
      if (record?.sessionId !== binding.nativeSessionId || typeof record.uuid !== 'string' || ordinals.get(record.uuid) !== index) return false;
      if (index === recordIndex) return true;
      const parent = typeof record.parentUuid === 'string' ? ordinals.get(record.parentUuid) : undefined;
      if (parent === undefined || parent >= index) return false;
      index = parent;
    }
    return false;
  };
  if (!await source.unchanged() || JSON.stringify(census) !== JSON.stringify(await listClaudeRuntimeSources(binding.claudeConfigDir))) return null;
  return { ...source, records, ancestor, messageAt };
}

/** Exact user text on the native ancestry of a completed Claude message.
 * Provider consumption and host task termination require separate evidence. */
export async function readClosedClaudeMessageInput(sql: Sql, input: ClaudeMessageEvidenceBinding & {
  readonly recordIndex: number; readonly contentIndex: number;
}): Promise<{ file: string; sourceSha256: string; nativeSessionId: string; nativeMessageId: string;
  messageRecordIndex: number; completedAt: string; recordIndex: number; recordUuid: string; contentIndex: number; at: string; text: string } | null> {
  const binding = { ...input };
  if (![binding.recordIndex, binding.contentIndex].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  try {
    const source = await readClosedClaudeMessageSource(sql, binding);
    if (!source || !source.ancestor(binding.recordIndex)) return null;
    const record = source.records[binding.recordIndex], content = record.message?.content;
    const block = Array.isArray(content) ? content[binding.contentIndex] : undefined;
    const text = typeof content === 'string' && binding.contentIndex === 0 ? content :
      block?.type === 'text' && typeof block.text === 'string' ? block.text : null;
    const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    if (record.type !== 'user' || record.message?.role !== 'user' || !text ||
        !Number.isFinite(at) || at > source.messageAt || !await source.unchanged()) return null;
    return { file: source.file, sourceSha256: source.sourceSha256, nativeSessionId: binding.nativeSessionId,
      nativeMessageId: binding.nativeMessageId, messageRecordIndex: binding.messageRecordIndex, completedAt: new Date(source.messageAt).toISOString(),
      recordIndex: binding.recordIndex, recordUuid: record.uuid as string, contentIndex: binding.contentIndex,
      at: new Date(at).toISOString(), text };
  } catch { return null; }
}

/** One unambiguous native tool_use/tool_result pair on the ancestry of a
 * later completed Claude message. Retain errors and block output verbatim. */
export async function readClosedClaudeMessageToolResult(sql: Sql, input: ClaudeMessageEvidenceBinding & {
  readonly callRecordIndex: number; readonly callContentIndex: number;
  readonly resultRecordIndex: number; readonly resultContentIndex: number;
}): Promise<{ file: string; sourceSha256: string; nativeSessionId: string; nativeMessageId: string;
  messageRecordIndex: number; completedAt: string; callRecordIndex: number; callContentIndex: number; callRecordUuid: string;
  resultRecordIndex: number; resultContentIndex: number; resultRecordUuid: string; callMessageId: string;
  callId: string; name: string; arguments: string; output: string | unknown[];
  isError: boolean | null; calledAt: string; at: string } | null> {
  const binding = { ...input };
  if (![binding.callRecordIndex, binding.callContentIndex, binding.resultRecordIndex, binding.resultContentIndex]
      .every(n => Number.isSafeInteger(n) && n >= 0) || binding.callRecordIndex >= binding.resultRecordIndex) return null;
  try {
    const source = await readClosedClaudeMessageSource(sql, binding);
    if (!source || !source.ancestor(binding.resultRecordIndex) || !source.ancestor(binding.callRecordIndex, binding.resultRecordIndex)) return null;
    const call = source.records[binding.callRecordIndex], result = source.records[binding.resultRecordIndex];
    const request = Array.isArray(call.message?.content) ? call.message.content[binding.callContentIndex] : undefined;
    const response = Array.isArray(result.message?.content) ? result.message.content[binding.resultContentIndex] : undefined;
    if (call.type !== 'assistant' || call.message?.role !== 'assistant' || typeof call.message.id !== 'string' || !call.message.id.trim() ||
        call.message.id === binding.nativeMessageId || result.type !== 'user' || result.message?.role !== 'user' ||
        request?.type !== 'tool_use' || typeof request.id !== 'string' || !request.id.trim() ||
        typeof request.name !== 'string' || !request.name.trim() || !request.input || typeof request.input !== 'object' || Array.isArray(request.input) ||
        response?.type !== 'tool_result' || response.tool_use_id !== request.id ||
        !(typeof response.content === 'string' || Array.isArray(response.content)) ||
        response.is_error !== undefined && typeof response.is_error !== 'boolean') return null;
    const blocks = source.records.flatMap(record => Array.isArray(record.message?.content) ? record.message.content : []);
    if (blocks.filter(block => block?.type === 'tool_use' && block.id === request.id).length !== 1 ||
        blocks.filter(block => block?.type === 'tool_result' && block.tool_use_id === request.id).length !== 1) return null;
    const calledAt = typeof call.timestamp === 'string' ? Date.parse(call.timestamp) : NaN;
    const at = typeof result.timestamp === 'string' ? Date.parse(result.timestamp) : NaN;
    if (!Number.isFinite(calledAt) || !Number.isFinite(at) || at < calledAt || at > source.messageAt || !await source.unchanged()) return null;
    return { file: source.file, sourceSha256: source.sourceSha256, nativeSessionId: binding.nativeSessionId,
      nativeMessageId: binding.nativeMessageId, messageRecordIndex: binding.messageRecordIndex, completedAt: new Date(source.messageAt).toISOString(),
      callRecordIndex: binding.callRecordIndex, callContentIndex: binding.callContentIndex, callRecordUuid: call.uuid as string,
      resultRecordIndex: binding.resultRecordIndex, resultContentIndex: binding.resultContentIndex, resultRecordUuid: result.uuid as string,
      callMessageId: call.message.id, callId: request.id, name: request.name, arguments: JSON.stringify(request.input),
      output: response.content, isError: response.is_error ?? null, calledAt: new Date(calledAt).toISOString(), at: new Date(at).toISOString() };
  } catch { return null; }
}

/** Complete physical source census, bracketed across every session read.
 * The authenticated host must separately establish process termination. */
export async function readClosedClaudeRuntimeUsage(sql: Sql, input: {
  readonly workspaceId: string; readonly claudeConfigDir: string;
}): Promise<{ complete: boolean; sessions: readonly { nativeSessionId: string; usage: ClosedClaudeSessionUsage }[] }> {
  const binding = { ...input };
  try {
    if ([binding.workspaceId, binding.claudeConfigDir].some(v => typeof v !== 'string' || !v.trim())) throw new Error('missing runtime binding');
    const census = await listClaudeRuntimeSources(binding.claudeConfigDir);
    const sessions: { nativeSessionId: string; usage: ClosedClaudeSessionUsage }[] = [];
    for (const source of census) sessions.push({ nativeSessionId: source.nativeSessionId,
      usage: await readClosedClaudeSourceUsage(sql, { ...binding, nativeSessionId: source.nativeSessionId }, source.file) });
    return { complete: JSON.stringify(census) === JSON.stringify(await listClaudeRuntimeSources(binding.claudeConfigDir)) &&
      sessions.every(source => source.usage.ok), sessions };
  } catch { return { complete: false, sessions: [] }; }
}

/** Complete session token census from native bytes plus the atomic ingest
 * frontier. Never promotes estimated/list-price costs to provider bills.
 * The authenticated execution host must verify process termination and supply
 * the exact home/session binding; this reader does not discover participants. */
export async function readClosedCodexSessionUsage(sql: Sql, input: {
  readonly workspaceId: string; readonly nativeSessionId: string; readonly codexHome: string;
}): Promise<ClosedCodexSessionUsage> {
  const binding = { ...input };
  const fail = (detail: string): ClosedCodexSessionUsage => ({ ok: false, detail });
  if ([binding.workspaceId, binding.nativeSessionId, binding.codexHome].some(v => typeof v !== 'string' || !v.trim())) {
    return fail('an exact workspace, native session and host-owned home are required');
  }
  try {
    const source = await readCompleteCodexSource(binding);
    const [frontier] = await sql<{ byte_offset: string; parser_state: { fileGeneration?: number; initialized?: boolean; bootstrapOffset?: number } }[]>`
      SELECT byte_offset::text, parser_state FROM harness_shared.interactive_usage_files
      WHERE workspace_id = ${binding.workspaceId} AND file_path = ${source.file}`;
    const offset = Number(frontier?.byte_offset), sourceBytes = Buffer.byteLength(source.transcript);
    if (!frontier || frontier.parser_state?.initialized !== true || frontier.parser_state.bootstrapOffset !== undefined ||
        !Number.isSafeInteger(offset) || offset < 0 || offset > sourceBytes) {
      return fail('the canonical ingest frontier must identify verified native source bytes');
    }
    const { closedCodexSessionPopulation } = await import('./interactive-usage/ingest-adapters');
    const populationInput = { file: source.file, fileGeneration: frontier.parser_state.fileGeneration ?? 0,
      nativeSessionId: binding.nativeSessionId };
    const population = offset === sourceBytes ? closedCodexSessionPopulation({ ...populationInput, transcript: source.transcript }) :
      fail('the canonical ingest frontier does not cover the entire native source');
    if (!await source.unchanged()) return fail('the native source changed while reconciling its frontier');
    if (population.ok) return { ...population, file: source.file, sourceSha256: source.sourceSha256 };
    // A later open turn or trailing partial record must not erase earlier
    // closed work. Locate a complete prefix within the atomic frontier, then
    // validate it through the SAME canonical population/key writer. The outer
    // result remains incomplete; this is a known subtotal, never a total.
    let start = 0, consumedBytes = 0, closedEnd = 0;
    while (start < source.transcript.length) {
      const end = source.transcript.indexOf('\n', start);
      if (end < 0) break;
      const line = source.transcript.slice(start, end);
      consumedBytes += Buffer.byteLength(line + '\n');
      if (consumedBytes > offset) break;
      let record: { type?: unknown; payload?: { type?: unknown } };
      try { record = JSON.parse(line); } catch { break; }
      if (!record || typeof record !== 'object' || Array.isArray(record) || !record.payload || typeof record.payload !== 'object') break;
      if (record.type === 'event_msg' && ['task_complete', 'turn_completed'].includes(String(record.payload.type))) closedEnd = end + 1;
      start = end + 1;
    }
    if (!closedEnd) return population;
    const known = closedCodexSessionPopulation({ ...populationInput, transcript: source.transcript.slice(0, closedEnd) });
    if (!known.ok) return population;
    return { ok: false, detail: population.detail,
      knownSubtotal: { ...known, file: source.file, sourceSha256: source.sourceSha256 } };
  } catch { return fail('the complete native source and canonical frontier could not be verified'); }
}

/** Exact native user input observed in a completed source turn. This proves
 * recording in the native turn, not a provider request body or billed send.
 * The host supplies the source indices; candidate text cannot select a ref. */
export async function readClosedCodexTurnInput(sql: Sql, input: {
  readonly workspaceId: string; readonly nativeSessionId: string; readonly codexHome: string;
  readonly nativeTurnId: string; readonly recordIndex: number; readonly contentIndex: number;
}): Promise<{ file: string; sourceSha256: string; nativeSessionId: string; nativeTurnId: string;
  recordIndex: number; contentIndex: number; at: string; text: string } | null> {
  const binding = { ...input };
  if ([binding.workspaceId, binding.nativeSessionId, binding.codexHome, binding.nativeTurnId].some(v => typeof v !== 'string' || !v.trim()) ||
      ![binding.recordIndex, binding.contentIndex].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  try {
    const source = await readCompleteCodexSource(binding);
    const population = await readClosedCodexSessionUsage(sql, binding);
    if (!population.ok || population.sourceSha256 !== source.sourceSha256 || population.file !== source.file ||
        !population.nativeTurnIds.includes(binding.nativeTurnId)) return null;
    // The canonical population proof already rejects malformed/partial records
    // and foreign headers. Keep the complete record ordinal, including header.
    const records = source.transcript.slice(0, -1).split('\n').map(line => JSON.parse(line));
    const record = records[binding.recordIndex];
    const payload = record?.payload, content = payload?.content?.[binding.contentIndex];
    if (record?.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user' ||
        !Array.isArray(payload.content) || content?.type !== 'input_text' || typeof content.text !== 'string' || !content.text.length ||
        typeof record.timestamp !== 'string' || !Number.isFinite(Date.parse(record.timestamp)) ||
        payload.turn_id !== undefined && payload.turn_id !== binding.nativeTurnId) return null;
    let active: string | null = null, started = false;
    for (const row of records.slice(0, binding.recordIndex)) {
      if (row.type === 'event_msg' && row.payload.type === 'task_started') {
        active = typeof row.payload.turn_id === 'string' ? row.payload.turn_id : null;
        started = active === binding.nativeTurnId;
      }
      if (row.type === 'turn_context') active = typeof row.payload.turn_id === 'string' ? row.payload.turn_id : null;
      if (row.type === 'event_msg' && ['task_complete', 'turn_completed'].includes(row.payload.type)) active = null;
    }
    if (!started || active !== binding.nativeTurnId || !await source.unchanged()) return null;
    return { file: source.file, sourceSha256: source.sourceSha256, nativeSessionId: binding.nativeSessionId,
      nativeTurnId: binding.nativeTurnId, recordIndex: binding.recordIndex, contentIndex: binding.contentIndex,
      at: new Date(record.timestamp).toISOString(), text: content.text };
  } catch { return null; }
}

/** Exact call/result pair in one completed native turn. Preserve the native
 * tool name and raw arguments: a functions.exec wrapper is not evidence that
 * any particular nested platform invocation succeeded. Semantic/tool-specific
 * authority must be joined separately, without guessing from timestamps. */
export async function readClosedCodexTurnToolResult(sql: Sql, input: {
  readonly workspaceId: string; readonly nativeSessionId: string; readonly codexHome: string;
  readonly nativeTurnId: string; readonly callRecordIndex: number; readonly resultRecordIndex: number;
}): Promise<{ file: string; sourceSha256: string; nativeSessionId: string; nativeTurnId: string;
  callRecordIndex: number; resultRecordIndex: number; callId: string; name: string;
  callType: 'function_call' | 'custom_tool_call';
  arguments: string; output: string | unknown[]; isError: boolean | null; calledAt: string; at: string } | null> {
  const binding = { ...input };
  if ([binding.workspaceId, binding.nativeSessionId, binding.codexHome, binding.nativeTurnId].some(v => typeof v !== 'string' || !v.trim()) ||
      ![binding.callRecordIndex, binding.resultRecordIndex].every(n => Number.isSafeInteger(n) && n >= 0) ||
      binding.callRecordIndex >= binding.resultRecordIndex) return null;
  try {
    const source = await readCompleteCodexSource(binding);
    const population = await readClosedCodexSessionUsage(sql, binding);
    if (!population.ok || population.sourceSha256 !== source.sourceSha256 || population.file !== source.file ||
        !population.nativeTurnIds.includes(binding.nativeTurnId)) return null;
    const records = source.transcript.slice(0, -1).split('\n').map(line => JSON.parse(line));
    const call = records[binding.callRecordIndex], result = records[binding.resultRecordIndex];
    const request = call?.payload, response = result?.payload;
    const outputType = request?.type === 'function_call' ? 'function_call_output' :
      request?.type === 'custom_tool_call' ? 'custom_tool_call_output' : null;
    const args = request && codexToolCallArgsRaw(request);
    if (!outputType || call?.type !== 'response_item' || result?.type !== 'response_item' ||
        response?.type !== outputType || typeof request.call_id !== 'string' || !request.call_id.trim() ||
        response.call_id !== request.call_id || typeof request.name !== 'string' || !request.name.trim() ||
        request.namespace !== undefined && (typeof request.namespace !== 'string' || !request.namespace.trim()) ||
        typeof args !== 'string' || !(typeof response.output === 'string' || Array.isArray(response.output)) ||
        response.is_error !== undefined && typeof response.is_error !== 'boolean' ||
        [request, response].some(row => row.turn_id !== undefined && row.turn_id !== binding.nativeTurnId)) return null;
    // Reject duplicate IDs anywhere in this source, including earlier turns.
    const pairs = records.filter(row => row.type === 'response_item' && row.payload?.call_id === request.call_id &&
      ['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output'].includes(row.payload.type));
    if (pairs.length !== 2) return null;
    let active: string | null = null, startIndex: number | null = null;
    let callStart: number | null = null, resultStart: number | null = null;
    for (let index = 0; index <= binding.resultRecordIndex; index++) {
      const row = records[index];
      if (index === binding.callRecordIndex && active === binding.nativeTurnId) callStart = startIndex;
      if (index === binding.resultRecordIndex && active === binding.nativeTurnId) resultStart = startIndex;
      if (row.type === 'event_msg' && row.payload?.type === 'task_started') {
        active = typeof row.payload.turn_id === 'string' ? row.payload.turn_id : null;
        startIndex = index;
      }
      if (row.type === 'turn_context') {
        const turn = typeof row.payload?.turn_id === 'string' ? row.payload.turn_id : null;
        if (turn !== active) startIndex = null;
        active = turn;
      }
      if (row.type === 'event_msg' && ['task_complete', 'turn_completed'].includes(row.payload?.type)) {
        active = null; startIndex = null;
      }
    }
    const calledAt = typeof call.timestamp === 'string' ? Date.parse(call.timestamp) : NaN;
    const at = typeof result.timestamp === 'string' ? Date.parse(result.timestamp) : NaN;
    if (callStart === null || callStart !== resultStart || !Number.isFinite(calledAt) || !Number.isFinite(at) || at < calledAt ||
        !await source.unchanged()) return null;
    return { file: source.file, sourceSha256: source.sourceSha256, nativeSessionId: binding.nativeSessionId,
      nativeTurnId: binding.nativeTurnId, callRecordIndex: binding.callRecordIndex, resultRecordIndex: binding.resultRecordIndex,
      callId: request.call_id, name: `${request.namespace ? request.namespace + '.' : ''}${request.name}`,
      callType: request.type,
      arguments: args, output: response.output, isError: response.is_error ?? null,
      calledAt: new Date(calledAt).toISOString(), at: new Date(at).toISOString() };
  } catch { return null; }
}

/** Source-defined carry/recovery census within one host-allocated runtime home.
 * A latest adv_sessions.session_id is not the population: a carry can leave
 * multiple native transcripts behind. Bound and re-read the directory census,
 * retaining an explicit failure for each unreadable/incomplete source. */
export async function readClosedCodexRuntimeUsage(sql: Sql, input: {
  readonly workspaceId: string; readonly codexHome: string;
}): Promise<{ complete: boolean; sessions: readonly { nativeSessionId: string; usage: ClosedCodexSessionUsage }[] }> {
  const binding = { ...input };
  const list = async () => {
    const root = join(binding.codexHome, 'sessions');
    const found: { nativeSessionId: string; sourceStamp: string }[] = [];
    let entries = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      const children = await fs.readdir(dir, { withFileTypes: true });
      entries += children.length;
      if (entries > 5000) throw new Error('native source directory census exceeds its bound');
      for (const child of children) {
        if (child.isDirectory() && depth < 3 && /^\d+$/.test(child.name)) { await walk(join(dir, child.name), depth + 1); continue; }
        if (!child.isFile()) throw new Error('native source directory contains a noncanonical entry');
        const match = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(child.name);
        if (!match || depth !== 3) throw new Error('native source directory contains an unidentified source');
        const file = join(dir, child.name), stat = await fs.lstat(file, { bigint: true });
        if (!stat.isFile()) throw new Error('native source census changed file kind');
        found.push({ nativeSessionId: match[1].toLowerCase(),
          sourceStamp: [file, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':') });
      }
    };
    await walk(root, 0);
    if (!found.length || found.length > 1000 || new Set(found.map(source => source.nativeSessionId)).size !== found.length) throw new Error('native source census is empty or ambiguous');
    return found.sort((a, b) => a.nativeSessionId.localeCompare(b.nativeSessionId));
  };
  try {
    if ([binding.workspaceId, binding.codexHome].some(v => typeof v !== 'string' || !v.trim())) throw new Error('missing runtime binding');
    // ID equality alone misses changes to an earlier source during a later
    // frontier read. Cover the whole read with physical content/identity stamps.
    const census = await list();
    const sessions: { nativeSessionId: string; usage: ClosedCodexSessionUsage }[] = [];
    for (const { nativeSessionId } of census) sessions.push({ nativeSessionId, usage: await readClosedCodexSessionUsage(sql, { ...binding, nativeSessionId }) });
    return { complete: JSON.stringify(census) === JSON.stringify(await list()) && sessions.every(source => source.usage.ok), sessions };
  } catch { return { complete: false, sessions: [] }; }
}

/** Trusted Codex host resolver. The native home is a runtime capability owned
 * by the authenticated engine, never a command argument. Full source defines
 * the expected set; SQL supplies only its atomic frontier and billed evidence. */
export async function readClosedCodexTurnBilledCost(sql: Sql,
  input: Omit<IdentityTurnUsageBinding, 'usageEventKeys'> & { readonly codexHome: string },
): Promise<(Extract<IdentityTurnBilledCost, { ok: true }> & { readonly usageEventKeys: readonly string[] }) | Exclude<IdentityTurnBilledCost, { ok: true }>> {
  const binding = { ...input };
  const fail = (code: Exclude<IdentityTurnBilledCost, { ok: true }>['code'], detail: string): Exclude<IdentityTurnBilledCost, { ok: true }> =>
    ({ ok: false, code, detail });
  if ([binding.workspaceId, binding.ownerId, binding.principalId, binding.nativeSessionId, binding.nativeTurnId,
      binding.specificationRevision, binding.stateRevision, binding.codexHome].some((v) => typeof v !== 'string' || !v.trim())) {
    return fail('identity-usage-invalid-binding', 'a closed host turn needs its exact native runtime and identity');
  }
  try {
    const [{ readIdentityTurnBilledCost }, { closedCodexTurnPopulation }] = await Promise.all([
      import('./cupboard/shadow-metering-reader'), import('./interactive-usage/ingest-adapters'),
    ]);
    const source = await readCompleteCodexSource(binding);
    const { file, transcript } = source;
    const [frontier] = await sql<{ byte_offset: string; parser_state: { fileGeneration?: number; initialized?: boolean; bootstrapOffset?: number } }[]>`
      SELECT byte_offset::text, parser_state FROM harness_shared.interactive_usage_files
      WHERE workspace_id = ${binding.workspaceId} AND file_path = ${file}`;
    if (!frontier || frontier.parser_state?.initialized !== true || frontier.parser_state.bootstrapOffset !== undefined) {
      return fail('identity-usage-incomplete', 'the native source has no complete canonical ingest frontier');
    }
    const population = closedCodexTurnPopulation({ transcript, file, fileGeneration: frontier.parser_state.fileGeneration ?? 0,
      nativeSessionId: binding.nativeSessionId, nativeTurnId: binding.nativeTurnId });
    if (!population.ok) return fail('identity-usage-incomplete', population.detail);
    const byteOffset = Number(frontier.byte_offset);
    if (!Number.isSafeInteger(byteOffset) || byteOffset < population.closedByteOffset || byteOffset > Buffer.byteLength(transcript)) {
      return fail('identity-usage-incomplete', 'the atomic ingest frontier does not cover the full native turn closure');
    }
    const cost = await readIdentityTurnBilledCost(sql, { ...binding, usageEventKeys: population.usageEventKeys });
    if (!await source.unchanged()) return fail('identity-usage-incomplete', 'the native source changed while verifying its bill');
    return cost.ok ? { ...cost, usageEventKeys: population.usageEventKeys } : cost;
  } catch (error) {
    if (error instanceof CodexSourceProofError) return fail(error.code, error.message);
    return fail('identity-usage-unavailable', 'the complete native source and canonical billed proof could not be verified');
  }
}

/**
 * OMP transcript root. Tracked psu sessions isolate PI_CODING_AGENT_DIR under
 * `~/.papercusp/su-omp-homes/session-<adv id>/agent`; only untracked OMP
 * sessions use the shared `~/.omp/agent` home. Kept lazy because `homedir()` at
 * module scope breaks the vite renderer stub.
 */
export function ompSessionsRootForSessionKey(
  sessionKey?: string | number,
  home: string = homedir(),
): string {
  return join(ompAgentHomeForSessionKey(sessionKey, home), 'sessions');
}

/**
 * The OMP agent home that owns one session's transcript/config state.
 *
 * Keep this path paired with {@link ompSessionsRootForSessionKey}: native
 * session handles need the AGENT HOME while transcript readers need its
 * `sessions` child. Before this helper existed the handle reconstructed the
 * shared `~/.omp/agent` path while the resolver correctly searched the tracked
 * per-session home, so one runtime carried two contradictory roots.
 */
export function ompAgentHomeForSessionKey(
  sessionKey?: string | number,
  home: string = homedir(),
): string {
  return sessionKey == null
    ? join(home, '.omp', 'agent')
    : join(ompSessionHomesRoot(home), `session-${sessionKey}`, 'agent');
}

/**
 * The container of every PER-SESSION omp home — `<here>/session-<advId>/agent/sessions/…`
 * (WI-41496).
 *
 * Exported because two layers must agree on it and did not: the search corpus
 * already walks this root (session-ingest's omp adapter, added by
 * EI-20212281439039808 with the note "this pair must not drift again"), while
 * this module — the LIVE transcript resolver the HUD conversation popup streams
 * through — only ever looked in the shared `~/.omp` home. A psu-launched omp
 * agent never writes there, so its popup was permanently empty: measured live,
 * a 25 KB transcript on disk and `backfill: []` on the wire.
 */
export function ompSessionHomesRoot(home: string = homedir()): string {
  return process.env.PAPERCUSP_SU_OMP_HOMES_DIR || join(home, '.papercusp', 'su-omp-homes');
}

interface CachedPath {
  path: string;
  /** When this resolution was computed — checked against {@link CODEX_KEY_CACHE_TTL_MS}. */
  at: number;
}

const codexPathCache = new Map<string, CachedPath>();
const ompPathCache = new Map<string, CachedPath>();

/**
 * WI-41496 — how long a FAILED per-session-home sweep suppresses the next one
 * for the same thread id.
 *
 * Misses are deliberately never cached in this module (a live session's file
 * appears mid-poll and must be seen at once), and that rule is right for the
 * cheap single-root walks. The all-homes fallback is a different cost class —
 * one readdir per per-session home — and the thinking route re-resolves every
 * second while a pane is open on a session with no file yet. Short enough that
 * a transcript appearing is picked up within a couple of ticks, long enough
 * that N open panes cannot turn into a readdir storm.
 */
export const OMP_HOME_SWEEP_COOLDOWN_MS = 5_000;
const ompHomeSweepCooldown = new Map<string, number>();

/**
 * EI-20219088862022620 / WI-38090 — how long a PER-HOME ("newest rollout in this
 * CODEX_HOME") resolution may be reused before it is re-walked.
 *
 * The module header's premise — "a transcript path is stable once written" — is true
 * for a key that names a FILE (a claude session_id, a rollout uuid) and FALSE for a key
 * that names a DIRECTORY to search. `findCodexRolloutPath` is keyed by the adv-session
 * id, which is STABLE ACROSS CARRY-RESPAWNS (a respawn reuses the same adv row and the
 * same per-session CODEX_HOME) while the rollout FILE it must resolve to changes on
 * every respawn. The old guard re-stat'd only the cached path, and since rollouts are
 * never deleted that stat always succeeded — so the first resolution was pinned for the
 * life of the process and every later generation was invisible.
 *
 * The damage was not a stale display: the compaction watchdog estimates context from
 * this path, so after one carry-respawn it read a DEAD predecessor's frozen rollout as
 * the live successor's usage. `coord_presence.context_tokens` froze at the dead value
 * while `context_estimated_at` kept refreshing (a stale VALUE wearing a fresh
 * TIMESTAMP), the watchdog cut live successors sitting at ~66k real tokens, and because
 * the frozen number could never fall below the limit the WI-5075 respawn-streak guard
 * concluded "the estimate never drops" and permanently suppressed BOTH enforcement
 * rungs — leaving the real session to run unmonitored into "Prompt is too long".
 * 48 sessions were reported over their ceiling, one at 2.7× its true usage.
 *
 * A TTL rather than no cache at all: the resolvers are called several times for the
 * same owner within one watchdog sweep (estimate, window, carry-spec build) and by the
 * roster's thinking poll, which is what the cache exists to collapse. 10s is far below
 * the 2-minute sweep, so every sweep re-resolves, and it matches
 * `isCodexSessionThinking`'s own `activeMs` window.
 */
const CODEX_KEY_CACHE_TTL_MS = 10_000;

/**
 * WI-6794: the cache key MUST carry the ROOT that was searched, not just the
 * session id. Every resolver here takes a home/root override, so keying by id
 * alone serves one home's answer to a caller that asked about another — and
 * the staleness guard cannot catch it, because it only re-stats the cached
 * path, which still exists under the wrong root. Caught by WI-6581's live
 * probe, where a homeOverride hit made a later default lookup report a file
 * that is not in the default home at all.
 */
function pathCacheKey(kind: string, id: string | number, root: string): string {
  return `${kind}::${id}::${root}`;
}

/** Test seam. */
export function __resetTranscriptResolverCaches(): void {
  codexPathCache.clear();
  ompPathCache.clear();
  ompHomeSweepCooldown.clear();
}

async function statMtime(p: string): Promise<number | null> {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The NEWEST codex rollout jsonl for a tracked codex session — codex keys its
 * per-session CODEX_HOME by the adv-session row id and writes rollouts at
 * `<home>/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl`. Newest-by-mtime
 * because a resumed session may add a second rollout file. Null until codex
 * takes its first turn (no sessions dir yet).
 */
export async function findCodexRolloutPath(
  sessionKey: string | number,
  opts: { homeOverride?: string; nowMs?: number } = {},
): Promise<string | null> {
  const now = opts.nowMs ?? Date.now();
  const root = join(opts.homeOverride ?? codexHomeForSessionKey(sessionKey), 'sessions');
  const cacheKey = pathCacheKey('codex-key', sessionKey, root);
  const cached = codexPathCache.get(cacheKey);
  if (cached) {
    // The path must still EXIST *and* the resolution must still be FRESH: this key names
    // a home to search, not a file, so a carry-respawn silently changes the right answer
    // while the cached file lives on forever (CODEX_KEY_CACHE_TTL_MS).
    if (now - cached.at < CODEX_KEY_CACHE_TTL_MS && (await statMtime(cached.path)) !== null) {
      return cached.path;
    }
    codexPathCache.delete(cacheKey);
  }
  let best: { path: string; mtime: number } | null = null;
  // Bounded walk: sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl — one home, ≤4 levels.
  let years: string[];
  try {
    years = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const y of years) {
    let months: string[];
    try {
      months = await fs.readdir(join(root, y));
    } catch {
      continue;
    }
    for (const m of months) {
      let days: string[];
      try {
        days = await fs.readdir(join(root, y, m));
      } catch {
        continue;
      }
      for (const d of days) {
        let files: string[];
        try {
          files = await fs.readdir(join(root, y, m, d));
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
          const p = join(root, y, m, d, f);
          const mtime = await statMtime(p);
          if (mtime !== null && (!best || mtime > best.mtime)) best = { path: p, mtime };
        }
      }
    }
  }
  if (best) codexPathCache.set(cacheKey, { path: best.path, at: now });
  return best?.path ?? null;
}

const CODEX_THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the native Codex thread id BEFORE its first rollout JSONL exists.
 *
 * Codex 0.151 creates `<CODEX_HOME>/thread-writer-locks/<thread-id>.lock`
 * during interactive startup, but does not create the rollout file until the
 * first owner turn is persisted. Requiring a rollout before PUI can attach
 * creates a deadlock: PUI needs an adapter to send that first turn, while the
 * adapter used to require the file that only that turn creates.
 *
 * This is deliberately a live-runtime bootstrap seam, not an exact-resume
 * claim. Callers still treat `rolloutPath === null` as "not durably
 * resumable yet"; the lock supplies only the stable native identity needed to
 * address the already-running process.
 */
export async function findCodexLiveThreadId(codexHome: string): Promise<string | null> {
  const root = join(codexHome, 'thread-writer-locks');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  let newest: { id: string; mtime: number } | null = null;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.lock')) continue;
    const id = entry.name.slice(0, -'.lock'.length);
    if (!CODEX_THREAD_ID_RE.test(id)) continue;
    const mtime = await statMtime(join(root, entry.name));
    if (mtime !== null && (!newest || mtime > newest.mtime)) newest = { id, mtime };
  }
  return newest?.id ?? null;
}

/**
 * A codex rollout jsonl matched by its ROLLOUT UUID (the trailing uuid of
 * `rollout-<ts>-<uuid>.jsonl`) under the GLOBAL `~/.codex` home — the id the
 * session-turns transcript index keys codex turns by (session-ingest's codex
 * adapter), so a transcript-search hit can deep-link a codex session that has
 * no adv-session row key (agents-pill-inactive-search-2026-07-09 P-005).
 * Same bounded ≤4-level walk as findCodexRolloutPath; newest mtime wins when
 * the uuid somehow appears twice. Null when the rollout no longer exists.
 */
export async function findCodexRolloutPathByUuid(
  rolloutId: string,
  opts: { homeOverride?: string } = {},
): Promise<string | null> {
  if (!/^[0-9a-f][0-9a-f-]{7,}$/i.test(rolloutId)) return null;
  const root = join(opts.homeOverride ?? join(homedir(), '.codex'), 'sessions');
  const cacheKey = pathCacheKey('codex-uuid', rolloutId, root);
  const cached = codexPathCache.get(cacheKey);
  if (cached) {
    // No TTL here, deliberately: this key names ONE FILE by its uuid, so the correct
    // answer cannot change while that file exists — unlike the per-home key above,
    // whose answer moves to a new rollout on every carry-respawn (WI-38090).
    if ((await statMtime(cached.path)) !== null) return cached.path;
    codexPathCache.delete(cacheKey);
  }
  const wanted = `-${rolloutId.toLowerCase()}.jsonl`;
  let best: { path: string; mtime: number } | null = null;
  let years: string[];
  try {
    years = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const y of years) {
    let months: string[];
    try { months = await fs.readdir(join(root, y)); } catch { continue; }
    for (const m of months) {
      let days: string[];
      try { days = await fs.readdir(join(root, y, m)); } catch { continue; }
      for (const d of days) {
        let files: string[];
        try { files = await fs.readdir(join(root, y, m, d)); } catch { continue; }
        for (const f of files) {
          if (!f.startsWith('rollout-') || !f.toLowerCase().endsWith(wanted)) continue;
          const p = join(root, y, m, d, f);
          const mtime = await statMtime(p);
          if (mtime !== null && (!best || mtime > best.mtime)) best = { path: p, mtime };
        }
      }
    }
  }
  if (best) codexPathCache.set(cacheKey, { path: best.path, at: Date.now() });
  return best?.path ?? null;
}

/**
 * "Actively thinking" proxies for the roster's pulsing indicator — the codex /
 * omp analogues of claude-sessions' isSessionThinking: the session's transcript
 * file was appended within `activeMs`. Best-effort; false when unresolvable.
 */
/**
 * BOTH signals the roster needs about a non-claude session, from ONE resolve
 * (WI-41497) — the codex/omp analogue of claude-sessions'
 * `resolveSessionThinkingState`:
 *
 *   - `resolvable` — a transcript EXISTS to stream. False is what routes the
 *     conversation popup to its "no live transcript … it has ended, or its
 *     transcript was rotated away" note, so it is a claim about the record, not
 *     a default to leave lying around: before this existed, adv-roster never
 *     assigned it on the codex/omp legs at all and every codex row inherited a
 *     verdict from the CLAUDE resolver, which of course could not find a codex
 *     rollout. 237 of 257 live codex agents were being told they had ended.
 *   - `thinking` — that transcript was appended within `activeMs`.
 *
 * Returned together because the callers want both and a second resolve would be
 * a second chance for the two to disagree about the same session.
 */
export interface TranscriptThinkingState {
  resolvable: boolean;
  thinking: boolean;
}

const UNRESOLVED: TranscriptThinkingState = { resolvable: false, thinking: false };

async function stateForPath(
  p: string | null,
  opts: { nowMs?: number; activeMs?: number },
): Promise<TranscriptThinkingState> {
  if (!p) return UNRESOLVED;
  const mtime = await statMtime(p);
  if (mtime === null) return UNRESOLVED;
  return {
    resolvable: true,
    thinking: (opts.nowMs ?? Date.now()) - mtime < (opts.activeMs ?? 10_000),
  };
}

export async function resolveCodexThinkingState(
  sessionKey: string | number,
  opts: { nowMs?: number; activeMs?: number; homeOverride?: string } = {},
): Promise<TranscriptThinkingState> {
  return stateForPath(
    await findCodexRolloutPath(sessionKey, { homeOverride: opts.homeOverride }),
    opts,
  );
}

export async function resolveOmpThinkingState(
  threadId: string,
  opts: { nowMs?: number; activeMs?: number; rootOverride?: string; sessionKey?: string | number } = {},
): Promise<TranscriptThinkingState> {
  return stateForPath(
    await findOmpSessionPath(threadId, {
      rootOverride: opts.rootOverride,
      sessionKey: opts.sessionKey,
    }),
    opts,
  );
}

/**
 * "Actively thinking" proxies for the roster's pulsing indicator — the codex /
 * omp analogues of claude-sessions' isSessionThinking: the session's transcript
 * file was appended within `activeMs`. Best-effort; false when unresolvable.
 *
 * Thin wrappers over the state resolvers above, so a caller that wants only the
 * freshness half reads the same probe rather than a parallel one.
 */
export async function isCodexSessionThinking(
  sessionKey: string | number,
  opts: { nowMs?: number; activeMs?: number; homeOverride?: string } = {},
): Promise<boolean> {
  return (await resolveCodexThinkingState(sessionKey, opts)).thinking;
}

export async function isOmpThreadThinking(
  threadId: string,
  opts: { nowMs?: number; activeMs?: number; rootOverride?: string; sessionKey?: string | number } = {},
): Promise<boolean> {
  return (await resolveOmpThinkingState(threadId, opts)).thinking;
}

/**
 * The omp session jsonl for a thread id — omp stores sessions as
 * `~/.omp/agent/sessions/<cwd-encoded>/<timestamp>_<session-id>.jsonl` and the
 * adv row's `omp_thread_id` IS that session id, so the file is found by suffix
 * across the (bounded, per-cwd) session dirs.
 */
export async function findOmpSessionPath(
  threadId: string,
  opts: { rootOverride?: string; sessionKey?: string | number; home?: string } = {},
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{6,}$/.test(threadId)) return null;
  const home = opts.home ?? homedir();
  const root = opts.rootOverride ?? ompSessionsRootForSessionKey(opts.sessionKey, home);
  const cacheKey = pathCacheKey('omp', threadId, root);
  const cached = ompPathCache.get(cacheKey);
  if (cached) {
    // Existence-only, like the uuid leg: the key names ONE file (`_<threadId>.jsonl`).
    if ((await statMtime(cached.path)) !== null) return cached.path;
    ompPathCache.delete(cacheKey);
  }
  const hit = await searchOmpRoot(root, threadId);
  if (hit) {
    ompPathCache.set(cacheKey, { path: hit, at: Date.now() });
    return hit;
  }

  /* WI-41496 — the caller could not name the session's home, so search the
     per-session homes too.
     A caller that KNOWS the adv-session id (the roster's freshness probe, and
     now the stream route) passes `sessionKey` and lands in exactly one home
     above; this leg is for the callers that structurally cannot — an archive
     re-resolve, a transcript-search deep-link that carries only the thread id.
     Before it existed those callers searched the shared `~/.omp` home ONLY,
     where a psu-launched agent never writes, and reported the session as having
     no transcript at all.
     Bounded and cooled-down rather than free: the thinking route re-resolves on
     a 1 Hz tick while a session has no file yet, so an uncooled sweep of every
     home would be a readdir storm for each open pane. A hit is cached by the
     normal path cache above; a miss suppresses the sweep for
     OMP_HOME_SWEEP_COOLDOWN_MS. */
  if (opts.rootOverride || opts.sessionKey != null) return null;
  const homesRoot = ompSessionHomesRoot(home);
  const now = Date.now();
  const cooledAt = ompHomeSweepCooldown.get(threadId);
  if (cooledAt !== undefined && now - cooledAt < OMP_HOME_SWEEP_COOLDOWN_MS) return null;
  let homes: string[];
  try {
    homes = await fs.readdir(homesRoot);
  } catch {
    ompHomeSweepCooldown.set(threadId, now);
    return null;
  }
  for (const dir of homes) {
    const sessionsRoot = join(homesRoot, dir, 'agent', 'sessions');
    const p = await searchOmpRoot(sessionsRoot, threadId);
    if (p) {
      ompPathCache.set(cacheKey, { path: p, at: Date.now() });
      ompHomeSweepCooldown.delete(threadId);
      return p;
    }
  }
  ompHomeSweepCooldown.set(threadId, now);
  return null;
}

/** One omp sessions root: `<root>/<cwd-encoded>/<ts>_<threadId>.jsonl`. */
async function searchOmpRoot(root: string, threadId: string): Promise<string | null> {
  const suffix = `_${threadId}.jsonl`;
  let cwdDirs: string[];
  try {
    cwdDirs = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const dir of cwdDirs) {
    let files: string[];
    try {
      files = await fs.readdir(join(root, dir));
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith(suffix)) return join(root, dir, f);
    }
  }
  return null;
}
