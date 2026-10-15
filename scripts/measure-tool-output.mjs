#!/usr/bin/env node
/**
 * P-001: raw Claude/Codex tool-output measurement, extending WI-6882's corpus reader.
 * Counts UTF-8 content bytes, not tokens or billed usage. See report.method.
 */
import { createHash } from 'node:crypto';
import { stat, realpath, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { walkRawTranscripts, readRawTranscript } from './lib/raw-session-corpus.mjs';
import { ENVELOPE_RE, unwrapWholePaste } from '../packages/operator-core/lib/turn-provenance/envelope-grammar.ts';

export const CAP_NAMES = ['codex-outer-exec', 'nested-shell', 'papercusp-door', 'unknown'];
const DEFAULT_ROOTS = [
  { client: 'claude', path: join(homedir(), '.claude/projects') },
  { client: 'claude', path: join(homedir(), '.papercusp/session-claude') },
  { client: 'codex', path: join(homedir(), '.codex/sessions') },
  { client: 'codex', path: join(homedir(), '.papercusp/su-codex-homes') },
];
const USAGE_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const DELIVERY_KEYS = new Set(['max_output_tokens', 'yield_time_ms', 'timeout_ms', 'timeout']);

function parseArgs(argv) {
  const options = { hours: 24, rerunSeconds: 120, roots: [], out: null, snapshot: null, metadata: null };
  const take = (i) => {
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(argv[i] + ' requires a value');
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i], value = take(i);
    if (a === '--hours' || a === '--window-hours') options.hours = Number(value);
    else if (a === '--since') {
      const m = /^(\d+(?:\.\d+)?)(h|d)$/.exec(value);
      if (!m) throw new Error('--since requires a duration such as 24h or 7d');
      options.hours = Number(m[1]) * (m[2] === 'd' ? 24 : 1);
    } else if (a === '--rerun-seconds') options.rerunSeconds = Number(value);
    else if (a === '--out') options.out = value;
    else if (a === '--snapshot') options.snapshot = value;
    else if (a === '--metadata') options.metadata = value;
    else if (a === '--claude-root' || a === '--codex-root' || a === '--root') {
      options.roots.push({ client: a === '--root' ? 'auto' : a === '--claude-root' ? 'claude' : 'codex', path: resolve(value) });
    } else throw new Error('unknown option ' + a);
    i += 1;
  }
  if (!(Number.isFinite(options.hours) && options.hours > 0)) throw new Error('--hours must be positive');
  if (!(Number.isFinite(options.rerunSeconds) && options.rerunSeconds > 0)) throw new Error('--rerun-seconds must be positive');
  if (!options.roots.length) {
    options.roots = [...DEFAULT_ROOTS];
    if (process.env.CODEX_HOME) options.roots.push({ client: 'codex', path: join(process.env.CODEX_HOME, 'sessions') });
  }
  return options;
}

/** Text blocks count their text; non-text blocks count their serialized representation. */
export function contentBytes(value) {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (Array.isArray(value)) return value.reduce((n, x) => n + contentBytes(x), 0);
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return contentBytes(value.text);
    return Buffer.byteLength(JSON.stringify(value));
  }
  return 0;
}
function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).join('\n');
  return value && typeof value.text === 'string' ? value.text : '';
}
function toolName(client, name) {
  const n = String(name || '(unmatched)').replace(/^functions\./, '');
  return client === 'codex' && n === 'exec' ? 'code-mode-exec' : n;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter((k) => !DELIVERY_KEYS.has(k)).map((k) => [k, canonical(value[k])]));
  return value;
}
function signature(tool, input) {
  let value = input;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch {
      // The exec pragma is a delivery setting; changing only its cap is still a repeat.
      value = value.replace(/^\s*\/\/\s*@exec:[^\n]*\n?/, '').trim();
    }
  }
  return createHash('sha256').update(JSON.stringify([tool, canonical(value ?? null)])).digest('hex');
}

/**
 * Marker-based, overlapping attribution. The outer formatter's warning must
 * be at the start of the rendered body; a warning inside a shell envelope is
 * a different cap. Projection-success footers are not truncation.
 */
export function capFor(client, tool, value) {
  const caps = new Set();
  const body = contentText(value);
  const outerBody = body.replace(/^Script [^\n]*\n(?:Wall time[^\n]*\n)?Output:\s*\n?/, '');
  const warning = /^(?:Warning: truncated output[^\n]*|(?:\d[\d,]* tokens truncated(?:[^\n]*)))/i;
  const nativeShell = /^(?:exec_command|write_stdin|shell|local_shell_call)$/.test(tool);
  if (client === 'codex' && tool === 'code-mode-exec' && warning.test(outerBody.trimStart())) caps.add('codex-outer-exec');
  if (client === 'codex' && nativeShell && /(?:Warning: truncated output|[\d,]+ tokens truncated)/i.test(body)) caps.add('nested-shell');
  if (/^(?:Bash|.*capability[_:]bash)$/.test(tool) && /(?:output (?:was )?truncated|\[truncated|truncated output)/i.test(body)) caps.add('nested-shell');
  if (/^\[result-door:/m.test(body)) caps.add('papercusp-door');

  // Traverse only recorded output/envelope values; never evaluate tool arguments.
  const visit = (node, depth = 0) => {
    if (depth > 8 || node == null) return;
    if (typeof node === 'string') {
      const s = node.trim();
      if (/^\[result-door:/m.test(s)) caps.add('papercusp-door');
      if (s.startsWith('{') || s.startsWith('[')) {
        try { visit(JSON.parse(s), depth + 1); } catch { /* outer cap may leave partial JSON */ }
      }
      return;
    }
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    if (typeof node !== 'object') return;
    if (node._projection?.truncated === true && node._projection?.kind === 'bounded-payload') caps.add('papercusp-door');
    if (node._meta?.resultDoor?.truncated === true) caps.add('papercusp-door');
    if ((node.truncated === true && typeof node.log_path === 'string')
      || (typeof node.output === 'string' && (node.original_token_count != null || node.chunk_id != null)
        && /Warning: truncated output|[\d,]+ tokens truncated/.test(node.output))) caps.add('nested-shell');
    for (const [key, child] of Object.entries(node)) {
      if (key === 'input' || key === 'arguments') continue;
      visit(child, depth + 1);
    }
  };
  visit(value);
  // JSON may be preceded by the code-mode status preamble.
  visit(outerBody);
  // A clipped envelope can still retain an exact escaped shell warning.
  if (tool === 'code-mode-exec' && /"output"\s*:\s*"(?:Warning: truncated output|[^"]*\\nWarning: truncated output)/.test(body)) caps.add('nested-shell');
  if (!caps.size && /Warning: truncated output|[\d,]+ tokens truncated|^\[TRUNCATED\b/m.test(body)) caps.add('unknown');
  return [...caps];
}

function distribution(sizes) {
  const sorted = [...sizes].sort((a, b) => a - b);
  const at = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
  return { count: sorted.length, p50: at(.5), p90: at(.9), p95: at(.95), p99: at(.99), max: at(1) };
}
function summary(rows) {
  const bytes = rows.reduce((n, x) => n + x.bytes, 0);
  const byCap = Object.fromEntries(CAP_NAMES.map((cap) => {
    const matches = rows.filter((x) => x.caps.includes(cap));
    const capBytes = matches.reduce((n, x) => n + x.bytes, 0);
    return [cap, { results: matches.length, bytes: capBytes, shareOfResults: rows.length ? matches.length / rows.length : 0,
      shareOfBytes: bytes ? capBytes / bytes : 0,
      reruns: matches.reduce((n, x) => n + x.reruns, 0), rerunBytes: matches.reduce((n, x) => n + x.rerunBytes, 0) }];
  }));
  const truncated = rows.filter((x) => x.caps.length).length;
  return { results: rows.length, bytes, size: distribution(rows.map((x) => x.bytes)),
    rereadBytes: rows.reduce((n, x) => n + x.rereadBytes, 0),
    truncation: { results: truncated, shareOfResults: rows.length ? truncated / rows.length : 0, byCap },
    reruns: { callsAfterTruncation: rows.reduce((n, x) => n + x.reruns, 0),
      bytesAfterTruncation: rows.reduce((n, x) => n + x.rerunBytes, 0) } };
}

// Only recorded top-level invocations are classified. JS inside exec is opaque;
// command strings are not guessed to be reads, and arguments are never executed.
function callKind(tool) {
  if (/^(?:wait|write_stdin|wait_agent)$/.test(tool)) return 'wait';
  if (/^(?:Read|read_file|view_image)$/.test(tool) || /(?:__|:)capability(?:_|:)read$/.test(tool)) return 'read';
  return 'other';
}
function durationBand(seconds) {
  return seconds == null ? 'unknown' : seconds < 300 ? '<5m' : seconds < 1800 ? '5-30m' : seconds < 7200 ? '30-120m' : '>=2h';
}
export function roleFor(nativeSessionId, metadata) {
  const matches = nativeSessionId ? metadata.filter((r) => r.nativeSessionId === nativeSessionId) : [];
  const roles = [...new Set(matches.map((r) => r.role).filter(Boolean))].sort();
  const owners = [...new Set(matches.map((r) => r.ownerId).filter(Boolean))].sort();
  const ambiguous = roles.length > 1 || owners.length > 1;
  return { role: ambiguous ? 'ambiguous' : roles[0] || 'unknown',
    status: ambiguous ? 'ambiguous' : roles.length ? 'matched' : 'unknown',
    owners, sources: [...new Set(matches.map((r) => r.source).filter(Boolean))].sort() };
}

/** Reconciles disjoint native-session cohorts without treating files as actors. */
export function driverCohorts(files) {
  const active = files.filter((f) => f.modelCalls > 0);
  const groups = new Map();
  for (const f of active) {
    const key = JSON.stringify([f.client, f.nativeSessionId || f.path]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  // Copied/forked files with the same native identity cannot be safely summed.
  const duplicates = [...groups.values()].filter((g) => g.length > 1);
  const sessions = [...groups.values()].filter((g) => g.length === 1).map(([f]) => ({
    path: f.path, client: f.client, nativeSessionId: f.nativeSessionId, role: f.identity.role,
    ownerId: f.identity.owners.length === 1 ? f.identity.owners[0] : null,
    identityStatus: f.identity.status, durationBand: durationBand(f.drivers.observedSeconds),
    ...f.drivers, modelCalls: f.modelCalls,
    wakeSource: Object.keys(f.drivers.callsByOrigin).length === 1
      ? Object.keys(f.drivers.callsByOrigin)[0] : 'mixed',
  }));
  const by = (field) => {
    const rows = new Map();
    for (const s of sessions) {
      const cohort = typeof field === 'function' ? field(s) : s[field];
      const key = JSON.stringify([s.client, cohort]);
      if (!rows.has(key)) rows.set(key, { client: s.client, cohort, sessions: 0, modelCalls: 0,
        waits: 0, repeatedReads: 0, calls: [] });
      const row = rows.get(key);
      row.sessions += 1; row.modelCalls += s.modelCalls; row.waits += s.waitCalls;
      row.repeatedReads += s.repeatedReadCalls; row.calls.push(s.modelCalls);
    }
    return [...rows.values()].map(({ calls, ...r }) => ({ ...r, callsPerSession: r.modelCalls / r.sessions,
      requestDistribution: distribution(calls) })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  };
  const byOwner = new Map();
  for (const s of sessions.filter((s) => s.ownerId)) {
    const key = JSON.stringify([s.client, s.ownerId]);
    if (!byOwner.has(key)) byOwner.set(key, { client: s.client, ownerId: s.ownerId, nativeSessions: 0, modelCalls: 0 });
    const row = byOwner.get(key); row.nativeSessions += 1; row.modelCalls += s.modelCalls;
  }
  return { sessions, byRole: by('role'), byWakeSource: by('wakeSource'), byDuration: by('durationBand'),
    byRoleWakeDuration: by((s) => JSON.stringify([s.role, s.wakeSource, s.durationBand])),
    byOwner: [...byOwner.values()],
    coverage: { activeFiles: active.length, includedSessions: sessions.length,
      sessionsWithOwner: sessions.filter((s) => s.ownerId).length,
      unidentifiedNativeFiles: sessions.filter((s) => !s.nativeSessionId).length,
      duplicateNativeFiles: duplicates.map((g) => ({ client: g[0].client, nativeSessionId: g[0].nativeSessionId,
        files: g.map((f) => f.path), excludedModelCalls: g.reduce((n, f) => n + f.modelCalls, 0) })),
      unknownIdentitySessions: sessions.filter((s) => s.identityStatus === 'unknown').length,
      ambiguousIdentitySessions: sessions.filter((s) => s.identityStatus === 'ambiguous').length } };
}

/** One finite file snapshot, with request/result identities local to that native session. */
export async function scan(file, client, { start, end, rerunSeconds = 120, snapshotBytes } = {}) {
  const calls = new Map(), seenResults = new Set(), seenRequests = new Set(), recentTruncated = new Map();
  const rows = [], segments = [0];
  const driver = { toolCalls: 0, waitCalls: 0, readCalls: 0, repeatedReadCalls: 0, opaqueExecCalls: 0,
    shortWaitCalls: 0, repeatedWaitCalls: 0, unchangedWaitResults: 0, waitYieldMilliseconds: {},
    callsByOrigin: {}, toolCallsByOrigin: {}, turnsByOrigin: {}, callsByTool: {},
    callsWithoutTimestamp: 0, firstRecordAt: null, lastRecordAt: null };
  const seenReads = new Set(), seenTurnNonces = new Set(), seenWaits = new Set(), waitResults = new Map();
  let origin = 'unmarked';
  const coverage = { parseErrors: 0, resultsWithoutTimestamp: 0, requestsWithoutTimestamp: 0,
    duplicateResults: 0, duplicateRequests: 0, requestsWithoutIdentity: 0, unmatchedResults: 0, nativeCompactions: 0, futureResults: 0, lines: 0 };
  let segment = 0, modelCalls = 0, ordinal = 0, nativeSessionId = null;
  const inWindow = (ts) => Number.isFinite(ts) && ts >= start && ts <= end;
  const request = (key, ts) => {
    if (!Number.isFinite(ts)) { coverage.requestsWithoutTimestamp += 1; return; }
    if (key && seenRequests.has(key)) { coverage.duplicateRequests += 1; return; }
    if (key) seenRequests.add(key); else coverage.requestsWithoutIdentity += 1;
    if (inWindow(ts)) {
      segments[segment] += 1; modelCalls += 1;
      driver.callsByOrigin[origin] = (driver.callsByOrigin[origin] || 0) + 1;
    }
  };
  const call = (id, name, input, ts) => {
    if (id && calls.has(id)) return;
    const tool = toolName(client, name), sig = signature(tool, input), previous = recentTruncated.get(sig);
    if (!Number.isFinite(ts)) driver.callsWithoutTimestamp += 1;
    if (inWindow(ts)) {
      driver.toolCalls += 1;
      driver.callsByTool[tool] = (driver.callsByTool[tool] || 0) + 1;
      driver.toolCallsByOrigin[origin] = (driver.toolCallsByOrigin[origin] || 0) + 1;
      if (callKind(tool) === 'wait') {
        driver.waitCalls += 1;
        if (seenWaits.has(sig)) driver.repeatedWaitCalls += 1;
        seenWaits.add(sig);
        let args = input;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
        const ms = args?.yield_time_ms;
        const band = !Number.isFinite(ms) ? 'unspecified' : ms <= 1000 ? '<=1000' : ms <= 10000 ? '1001-10000' : '>10000';
        driver.waitYieldMilliseconds[band] = (driver.waitYieldMilliseconds[band] || 0) + 1;
        if (Number.isFinite(ms) && ms <= 1000) driver.shortWaitCalls += 1;
      }
      if (callKind(tool) === 'read') {
        driver.readCalls += 1;
        if (seenReads.has(sig)) driver.repeatedReadCalls += 1;
        seenReads.add(sig);
      }
      if (tool === 'code-mode-exec') driver.opaqueExecCalls += 1;
    }
    const retryOf = previous && Number.isFinite(ts) && ts >= previous.ts && ts - previous.ts <= rerunSeconds * 1000 && inWindow(ts) ? previous : null;
    if (retryOf) { retryOf.reruns += 1; recentTruncated.delete(sig); }
    calls.set(id || '(anonymous-call-' + ordinal + ')', { tool, sig, retryOf });
  };
  const result = (id, value, ts) => {
    const identity = id || '(anonymous-result-' + ordinal + ')';
    if (seenResults.has(identity)) { coverage.duplicateResults += 1; return; }
    seenResults.add(identity);
    if (!Number.isFinite(ts)) { coverage.resultsWithoutTimestamp += 1; return; }
    if (ts > end) coverage.futureResults += 1;
    if (!inWindow(ts)) return;
    const info = calls.get(id);
    if (!info) coverage.unmatchedResults += 1;
    const tool = info?.tool || '(unmatched)', bytes = contentBytes(value);
    if (info && callKind(tool) === 'wait') {
      const digest = createHash('sha256').update(contentText(value)).digest('hex');
      if (waitResults.get(info.sig) === digest) driver.unchangedWaitResults += 1;
      waitResults.set(info.sig, digest);
    }
    if (info?.retryOf) info.retryOf.rerunBytes += bytes;
    const row = { tool, bytes, caps: capFor(client, tool, value), segment, at: segments[segment], ts, rereadBytes: 0, reruns: 0, rerunBytes: 0 };
    rows.push(row);
    if (row.caps.length && info) recentTruncated.set(info.sig, row);
  };
  for await (const item of readRawTranscript(file, { snapshotBytes })) {
    coverage.lines += 1; ordinal += 1;
    if (item.error) { coverage.parseErrors += 1; continue; }
    const rec = item.record;
    if (!rec || typeof rec !== 'object') { coverage.parseErrors += 1; continue; }
    const p = rec.payload, ts = Date.parse(rec.timestamp || '');
    if (rec.type === 'session_meta') nativeSessionId = p?.id || nativeSessionId;
    if (rec.sessionId) nativeSessionId = rec.sessionId;
    if (client === 'auto') {
      if (rec.type === 'session_meta' || rec.type === 'response_item') client = 'codex';
      else if (rec.type === 'user' || rec.type === 'assistant') client = 'claude';
    }
    if (inWindow(ts)) {
      driver.firstRecordAt = driver.firstRecordAt == null ? ts : Math.min(driver.firstRecordAt, ts);
      driver.lastRecordAt = driver.lastRecordAt == null ? ts : Math.max(driver.lastRecordAt, ts);
    }
    // Tool-result user rows are not new turns. Codex also emits user_message
    // events; use response_item only so one prompt is not counted twice.
    const userContent = client === 'claude' && rec.type === 'user'
      ? rec.message?.content : client === 'codex' && rec.type === 'response_item'
        && p?.type === 'message' && p.role === 'user' ? p.content : null;
    if (userContent != null && !(Array.isArray(userContent) && userContent.some((b) => b?.type === 'tool_result'))) {
      const match = ENVELOPE_RE.exec(unwrapWholePaste(contentText(userContent)));
      origin = match?.[1] || 'unmarked';
      if (!match || !seenTurnNonces.has(match[2])) {
        if (match) seenTurnNonces.add(match[2]);
        if (inWindow(ts)) driver.turnsByOrigin[origin] = (driver.turnsByOrigin[origin] || 0) + 1;
      }
    }
    if (rec.type === 'compacted' || p?.type === 'context_compacted' || (rec.type === 'system' && rec.subtype === 'compact_boundary')) {
      coverage.nativeCompactions += 1; segment += 1; segments.push(0); recentTruncated.clear(); seenReads.clear(); seenWaits.clear(); waitResults.clear(); continue;
    }
    if (client === 'claude') {
      const m = rec.message;
      if (rec.type === 'assistant' && m) {
        request(m.id ? segment + ':' + m.id : rec.requestId ? segment + ':' + rec.requestId : null, ts);
        for (const b of Array.isArray(m.content) ? m.content : []) {
          if (b?.type === 'tool_use') call(b.id, b.name, b.input, ts);
        }
      } else if (rec.type === 'user' && m) {
        for (const b of Array.isArray(m.content) ? m.content : []) {
          if (b?.type === 'tool_result') result(b.tool_use_id, b.content, ts);
        }
      }
    } else if (client === 'codex') {
      if (rec.type === 'event_msg' && p?.type === 'token_count') {
        const u = p.info?.last_token_usage, total = p.info?.total_token_usage;
        // Rate-limit updates and zero/reset notifications are not model responses.
        if (!u || !USAGE_FIELDS.some((k) => Number.isFinite(u[k]) && u[k] > 0)) continue;
        const entries = total && USAGE_FIELDS.filter((k) => total[k] !== undefined).map((k) => [k, total[k]]);
        const valid = entries?.length && entries.every(([, n]) => Number.isFinite(n) && n >= 0) && entries.some(([, n]) => n > 0);
        request(valid ? segment + ':' + JSON.stringify(entries) : null, ts);
      } else if (rec.type === 'response_item' && p) {
        if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) call(p.call_id || p.id, p.name || p.type, p.arguments ?? p.input ?? p.action, ts);
        else if (['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'].includes(p.type)) result(p.call_id || p.id, p.output, ts);
      }
    }
  }
  for (const row of rows) row.rereadBytes = row.bytes * Math.max(0, segments[row.segment] - row.at);
  const { firstRecordAt, lastRecordAt, ...counts } = driver;
  return { client, nativeSessionId, rows, modelCalls, coverage, drivers: { ...counts,
    firstRecordAt: firstRecordAt == null ? null : new Date(firstRecordAt).toISOString(),
    lastRecordAt: lastRecordAt == null ? null : new Date(lastRecordAt).toISOString(),
    observedSeconds: firstRecordAt == null ? null : (lastRecordAt - firstRecordAt) / 1000 } };
}

export async function measure(roots = DEFAULT_ROOTS, hours = 24, { now = Date.now(), rerunSeconds = 120, snapshot, sessionMetadata = [] } = {}) {
  if (!Array.isArray(sessionMetadata)) throw new Error('sessionMetadata must be an array');
  if (snapshot) {
    now = Date.parse(snapshot.window.end);
    hours = (now - Date.parse(snapshot.window.start)) / 3600_000;
    if (!Number.isFinite(now) || !(hours > 0)) throw new Error('invalid snapshot window');
  }
  const start = now - hours * 3600_000, end = now, rows = { claude: [], codex: [] };
  const modelCalls = { claude: 0, codex: 0 }, seenFiles = new Set(), files = [], rootCoverage = [];
  const diagnostics = { duplicatePaths: 0, unreadablePaths: 0, unknownClientFiles: 0, shortenedSnapshots: 0 };
  const unavailableFiles = [];
  const candidates = snapshot ? [{ client: 'snapshot', path: '.', files: snapshot.sourceCoverage.files }] : roots;
  for (const root of candidates) {
    const entry = { client: root.client, path: resolve(root.path), status: 'read', files: 0, skippedBeforeWindow: 0, errors: 0 };
    rootCoverage.push(entry);
    const discovered = root.files ? root.files.map((f) => f.path) : walkRawTranscripts(root.path, { onError: () => { entry.errors += 1; entry.status = entry.files ? 'partial' : 'unavailable'; } });
    const frozen = new Map((root.files || []).map((f) => [f.path, f]));
    for await (const file of discovered) {
      if (root.client === 'codex' && !/^rollout-.*\.jsonl$/.test(file.split('/').at(-1))) continue;
      let before, canonicalPath;
      try { before = await stat(file); canonicalPath = await realpath(file); } catch {
        diagnostics.unreadablePaths += 1;
        unavailableFiles.push({ path: file, ...frozen.get(file), error: 'unreadable' });
        continue;
      }
      if (seenFiles.has(canonicalPath)) { diagnostics.duplicatePaths += 1; continue; }
      seenFiles.add(canonicalPath);
      // Same discovery optimization as WI-6882. The actual result boundary is
      // still per record; discovery omissions are exposed, never called empty.
      if (!snapshot && before.mtimeMs < start) { entry.skippedBeforeWindow += 1; continue; }
      try {
        const original = frozen.get(file), snapshotBytes = original?.snapshotBytes ?? before.size;
        if (!Number.isSafeInteger(snapshotBytes) || snapshotBytes < 0) throw new Error('invalid snapshot size');
        if (before.size < snapshotBytes) { diagnostics.shortenedSnapshots += 1; throw new Error('source shorter than frozen snapshot'); }
        const scanned = await scan(file, original?.client || root.client, { start, end, rerunSeconds, snapshotBytes });
        entry.files += 1;
        if (!rows[scanned.client]) { diagnostics.unknownClientFiles += 1; continue; }
        rows[scanned.client].push(...scanned.rows); modelCalls[scanned.client] += scanned.modelCalls;
        const after = await stat(file);
        files.push({ path: canonicalPath, client: scanned.client, nativeSessionId: scanned.nativeSessionId,
          snapshotBytes, mtime: new Date(before.mtimeMs).toISOString(), changedDuringRead: before.size !== after.size || before.mtimeMs !== after.mtimeMs,
          results: scanned.rows.length, modelCalls: scanned.modelCalls, coverage: scanned.coverage,
          identity: roleFor(scanned.nativeSessionId, sessionMetadata), drivers: scanned.drivers });
      } catch (error) {
        entry.errors += 1; entry.status = 'partial'; diagnostics.unreadablePaths += 1;
        unavailableFiles.push({ path: file, ...frozen.get(file), error: error.message });
      }
    }
  }
  const clients = Object.fromEntries(Object.entries(rows).map(([client, results]) => {
    const tools = [...new Set(results.map((r) => r.tool))].sort().map((tool) => ({ tool, ...summary(results.filter((r) => r.tool === tool)) }));
    return [client, { ...summary(results), modelCalls: modelCalls[client], files: files.filter((f) => f.client === client).length, tools }];
  }));
  const coverage = {};
  for (const file of files) for (const [k, n] of Object.entries(file.coverage)) coverage[k] = (coverage[k] || 0) + n;
  return { schemaVersion: 'tool-output-measurement-v1', measuredAt: new Date(now).toISOString(), windowHours: hours,
    window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() }, rerunWindowSeconds: rerunSeconds,
    method: {
      source: 'Raw Claude transcripts and Codex rollouts; never capped session_turn_parts.',
      bytes: 'UTF-8 content text; non-text blocks measured as serialized JSON. Transport envelopes are excluded. No tokenizer ran.',
      percentiles: 'Sorted byte sizes at floor(p * n), capped at n - 1; empty populations are zero.',
      rereadBytes: 'Replay estimate: result bytes times later recorded model responses inside this window and native compaction segment. Includes the first request consuming the output; no billing/cache assertion. Server-side pruning and branches are not reconstructed.',
      requests: 'Claude unique message.id; Codex nonzero last_token_usage deduped by cumulative usage per compaction segment. Missing request identities are counted by line and exposed.',
      truncation: 'Marker-based lower bound; hidden inner markers are unobservable. byCap populations overlap when several caps fire. Projection-success footers do not count.',
      reruns: 'Heuristic: next call with the same tool and canonical arguments within the declared seconds after a marked result. Delivery caps/timeouts are ignored; each repeat attaches to at most one prior result. Does not prove truncation caused the repeat. Bytes are the observed repeat result bytes.',
      coverage: 'Finite initial file-size snapshots; mtime selects candidate files, record timestamps select results/requests. Missing timestamps excluded. Overlapping real paths deduped; distinct copied/forked files are separate transcript observations.',
      drivers: 'Recorded top-level calls only; exec bodies are opaque. Repeated reads have identical canonical arguments within a native compaction segment and the window; repetition does not prove waste. Model requests are assigned to the preceding user-turn head marker; unmarked is unknown, not owner-typed. Durations are observed record spans within the window, not CPU time or full session lifetime.',
      waits: 'wait/write_stdin/wait_agent invocations; short means an explicitly requested yield_time_ms <=1000, not measured wall time. Repeated waits share canonical arguments in the segment/window. Unchanged means identical output text for the same invocation signature; it does not imply completion, and formatting/timing can make an unchanged process look different.',
      cohorts: 'Active native sessions with one source file (missing native IDs are exposed), grouped by client/role, client/wake source, client/duration and their joint tuple. byOwner separately sums known owner IDs across native incarnations; unknown/ambiguous owners are excluded from that denominator. Multiple files for one native identity are excluded explicitly. Historical identity-ledger and adv_sessions metadata are supplied as a dated sidecar; conflicting roles/owners are ambiguous, missing matches unknown. Snapshot mode reuses exact candidate files, byte limits and window; unavailable or shortened sources are exposed.',
    },
    ...summary([...rows.claude, ...rows.codex]), clients, drivers: driverCohorts(files),
    sourceCoverage: { roots: rootCoverage, files, unavailableFiles, diagnostics, ...coverage,
      changedDuringRead: files.filter((f) => f.changedDuringRead).length },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  const snapshot = options.snapshot ? JSON.parse(await readFile(options.snapshot, 'utf8')) : undefined;
  const metadata = options.metadata ? JSON.parse(await readFile(options.metadata, 'utf8')) : undefined;
  const report = await measure(options.roots, options.hours, { rerunSeconds: options.rerunSeconds, snapshot,
    sessionMetadata: metadata ? metadata.sessions : [] });
  if (metadata) report.metadataCoverage = { capturedAt: metadata.capturedAt, source: metadata.source, rows: metadata.sessions?.length || 0 };
  if (options.out) await writeFile(options.out, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
