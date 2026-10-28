/**
 * Decode retained output of the actual docs:search adapter, not an offline
 * retrieval approximation. This establishes label inputs only. Corpus/runtime
 * identity, judge qualification, retrieval cost and quality remain external.
 */
import { createHash } from 'node:crypto';
import { adapterFingerprint } from './adapter-baseline';
import type { RankedHit } from './labelled-relevance';

/** Freeze this framing in the judge pilot as well as the eventual study. */
export const DOCS_FINAL_INPUT_CONTRACT = 'docs-search-final-row-json-v1';

export const TYPESENSE_FINAL_INPUT_CONTRACT = 'restart-typesense-final-row-json-v1';

export const PROSE_FINAL_INPUT_CONTRACT = 'prose-search-final-row-json-v1';

/** Direct handler captures contain the complete MCP envelope. Effective scope
 * is pinned separately: production work_item requests also search plans.
 * Fulltext has no delivered degradation verdict; unknown must remain unknown.
 */
export function decodeProseSearchCapture(capture: unknown, expected: {
  id: string;
  adapter: 'search:fulltext' | 'search:semantic';
  args: Readonly<Record<string, unknown>>;
  effectiveScope: readonly string[];
}) {
  const saved = object(capture, 'capture');
  if (saved.schemaVersion !== 1 || saved.attemptId !== expected.id || saved.adapter !== expected.adapter)
    throw new Error('capture adapter or attempt differs from frozen request');
  const request = object(saved.request, 'request');
  if (adapterFingerprint(request as Parameters<typeof adapterFingerprint>[0]) !==
      adapterFingerprint(expected.args as Parameters<typeof adapterFingerprint>[0]))
    throw new Error('capture request differs from frozen request');
  if (typeof request.query !== 'string' || !request.query.trim() || !Number.isInteger(request.limit)
    || (request.limit as number) < 1 || typeof request.harness_slug !== 'string' || !request.harness_slug
    || !Array.isArray(request.scope) || !request.scope.length || !expected.effectiveScope.length
    || new Set(expected.effectiveScope).size !== expected.effectiveScope.length)
    throw new Error('requires explicit query, source/harness scope and cutoff');
  if (saved.exitCode !== 0 || typeof saved.stdout !== 'string' || !saved.stdout.trim()
    || typeof saved.deliveryWallMs !== 'number' || !Number.isFinite(saved.deliveryWallMs) || saved.deliveryWallMs < 0)
    throw new Error('missing successful complete capture or measured handler duration');
  const observation = object(saved.observation, 'observation');
  if (observation.plane !== 'direct-tool-handler' || observation.transportExercised !== false)
    throw new Error('requires explicit direct-handler measurement plane');
  const envelope = object(JSON.parse(saved.stdout), 'handler envelope');
  complete(envelope);
  if (envelope.isError === true || !Array.isArray(envelope.content) || envelope.content.length !== 1)
    throw new Error('not a complete successful prose handler envelope');
  const block = object(envelope.content[0], 'content block');
  if (block.type !== 'text' || typeof block.text !== 'string') throw new Error('missing exact prose response');
  const response = object(JSON.parse(block.text), 'response');
  complete(response);
  if (response.query !== request.query || JSON.stringify(response.scope) !== JSON.stringify(expected.effectiveScope)
    || !Array.isArray(response.results) || response.results.length > (request.limit as number))
    throw new Error('response query, effective scope or cutoff differs');
  let degraded: boolean | null = null;
  if (expected.adapter === 'search:semantic') {
    const legs = object(response.legs, 'observed legs');
    if (typeof legs.degraded !== 'boolean' || typeof response.embedder_available !== 'boolean'
      || !['ok', 'degraded'].includes(String(response.status)) || response.mode !== (request.mode ?? 'hybrid'))
      throw new Error('missing semantic path or degradation observations');
    const coverage = object(response.coverage, 'observed coverage');
    if (typeof coverage.degraded !== 'boolean') throw new Error('missing coverage degradation observation');
    degraded = response.status === 'degraded' || legs.degraded || coverage.degraded || !response.embedder_available;
  }
  if (response.total_hits !== null && (!Number.isInteger(response.total_hits) || (response.total_hits as number) < 0)
    || response.total_hits === null && (expected.adapter !== 'search:semantic' || degraded !== true))
    throw new Error('invalid or unqualified unknown hit count');
  const ids = new Set<string>();
  const hits: RankedHit[] = response.results.map((value, index) => {
    const hit = object(value, 'hit');
    if (typeof hit.source !== 'string' || !expected.effectiveScope.includes(hit.source)
      || typeof hit.source_id !== 'string' || !hit.source_id || typeof hit.excerpt !== 'string')
      throw new Error('invalid delivered prose identity or source scope');
    const docId = JSON.stringify([hit.source, hit.harness_slug ?? null, hit.source_id]);
    if (ids.has(docId)) throw new Error('duplicate delivered prose identity');
    ids.add(docId);
    const score = expected.adapter === 'search:fulltext' ? hit.rank : hit.score;
    if (score !== undefined && (typeof score !== 'number' || !Number.isFinite(score)))
      throw new Error('invalid delivered prose score');
    return { docId, rank: index + 1, source: expected.adapter, docText: JSON.stringify(hit),
      ...(typeof score === 'number' ? { score } : {}) };
  });
  return { inputContract: PROSE_FINAL_INPUT_CONTRACT, response, envelope, hits, degraded,
    measurementPlane: 'direct-tool-handler' as const, handlerWallMs: saved.deliveryWallMs,
    rawStdoutSha256: createHash('sha256').update(saved.stdout).digest('hex') };
}

/** Decode the library's returned documents, not raw engine hits or Scout cards.
 * Branch observations must come from the runner; answer:null and hits:[] alone
 * cannot distinguish fallback, missing usage, or genuinely empty retrieval. */
export function decodeTypesenseCapture(capture: unknown, expected: {
  id: string;
  adapter: 'restart:typesense.search' | 'restart:typesense.searchWithConversation';
  args: Readonly<Record<string, unknown>>;
}) {
  const saved = object(capture, 'capture');
  if (saved.schemaVersion !== 1 || saved.adapter !== expected.adapter || saved.attemptId !== expected.id) {
    throw new Error('capture adapter or attempt differs from frozen request');
  }
  const request = object(saved.request, 'request');
  if (adapterFingerprint(request as Parameters<typeof adapterFingerprint>[0]) !==
      adapterFingerprint(expected.args as Parameters<typeof adapterFingerprint>[0])) {
    throw new Error('capture request differs from frozen request');
  }
  if (typeof request.q !== 'string' || !request.q.trim() || !Number.isInteger(request.limit) ||
      (request.limit as number) < 1 || typeof request.region !== 'string' || !request.region.trim()) {
    throw new Error('requires frozen query, region and positive cutoff');
  }
  if (saved.exitCode !== 0 || typeof saved.stdout !== 'string' || !saved.stdout.trim() ||
      typeof saved.deliveryWallMs !== 'number' || !Number.isFinite(saved.deliveryWallMs) || saved.deliveryWallMs < 0) {
    throw new Error('missing successful complete capture or measured duration');
  }
  const observation = object(saved.observation, 'observation');
  if (!['hybrid', 'keyword-only', 'conversation', 'conversation-fallback'].includes(String(observation.path)) ||
      typeof observation.degraded !== 'boolean' || typeof observation.evidenceRef !== 'string' ||
      !observation.evidenceRef.trim()) throw new Error('missing observed runtime branch');
  const conversational = expected.adapter === 'restart:typesense.searchWithConversation';
  if (conversational !== String(observation.path).startsWith('conversation') ||
      (observation.path === 'conversation-fallback' && observation.degraded !== true)) {
    throw new Error('runtime branch differs from adapter or hides fallback');
  }
  const response = object(JSON.parse(saved.stdout), 'response');
  complete(response);
  if (!Array.isArray(response.hits) || !Number.isInteger(response.found) || (response.found as number) < 0 ||
      response.hits.length > (observation.path === 'conversation' ? Math.min(request.limit as number, 20) : request.limit as number)) {
    throw new Error('invalid delivered ranking or cutoff');
  }
  if (conversational && ((response.answer !== null && typeof response.answer !== 'string') ||
      (response.conversationId !== null && typeof response.conversationId !== 'string') ||
      (observation.path === 'conversation-fallback' && (response.answer !== null || response.conversationId !== null)))) {
    throw new Error('invalid conversational response');
  }
  const ids = new Set<string>();
  const hits: RankedHit[] = response.hits.map((value, index) => {
    const hit = object(value, 'hit');
    if (typeof hit.id !== 'string' || !hit.id.trim() || ids.has(hit.id)) throw new Error('invalid or duplicate delivered hit');
    ids.add(hit.id);
    return { docId: hit.id, rank: index + 1, source: expected.adapter, docText: JSON.stringify(hit) };
  });
  return { inputContract: TYPESENSE_FINAL_INPUT_CONTRACT,
    rawStdoutSha256: createHash('sha256').update(saved.stdout).digest('hex'),
    clientDeliveryWallMs: saved.deliveryWallMs, degraded: observation.degraded, observation, hits, response };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}: expected object`);
  return value as Record<string, unknown>;
}

function complete(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(complete); return; }
  const row = value as Record<string, unknown>;
  if (row._partial === true || row._truncated === true || row.content_truncated === true ||
      (typeof row.__truncated === 'string' && row.__truncated.length > 0) ||
      (row._projection && object(row._projection, 'projection').truncated === true)) {
    throw new Error('partial delivered output cannot supply complete label inputs');
  }
  Object.values(row).forEach(complete);
}

export function decodeDocsSearchCapture(capture: unknown, expected: {
  id: string;
  args: Readonly<Record<string, unknown>>;
}) {
  const saved = object(capture, 'capture');
  if (saved.schemaVersion !== 1 || saved.adapter !== 'docs:search' || saved.attemptId !== expected.id) {
    throw new Error('capture adapter or attempt differs from frozen request');
  }
  const request = object(saved.request, 'request');
  if (adapterFingerprint(request as Parameters<typeof adapterFingerprint>[0]) !==
      adapterFingerprint(expected.args as Parameters<typeof adapterFingerprint>[0])) {
    throw new Error('capture request differs from frozen request');
  }
  if (typeof request.query !== 'string' || !request.query.trim() ||
      !Number.isInteger(request.limit) || (request.limit as number) < 1 ||
      typeof request.harness !== 'string' || !request.harness.trim() || request.scope !== undefined) {
    throw new Error('requires an explicit engineering or harness docs request and positive cutoff');
  }
  if (saved.exitCode !== 0) throw new Error('refused or failed capture cannot supply successful label inputs');
  if (typeof saved.stdout !== 'string' || !saved.stdout.trim()) throw new Error('missing exact adapter output');
  if (typeof saved.deliveryWallMs !== 'number' || !Number.isFinite(saved.deliveryWallMs) || saved.deliveryWallMs < 0) {
    throw new Error('missing observed client delivery duration');
  }
  const response = object(JSON.parse(saved.stdout), 'response');
  complete(response);
  if (response.query !== request.query || !Array.isArray(response.hits)) throw new Error('not this docs search response');
  if (request.harness === 'engineering' ? response.surface !== 'engineering' :
      response.surface !== 'harness' || response.harness_slug !== request.harness) {
    throw new Error('response surface differs from requested docs scope');
  }
  const legs = object(response.legs, 'observed legs');
  if (typeof legs.degraded !== 'boolean') throw new Error('missing observed degradation state');
  if (response.hits.length > (request.limit as number)) throw new Error('delivered ranking exceeds requested cutoff');
  const ids = new Set<string>();
  const hits: RankedHit[] = response.hits.map((value, index) => {
    const hit = object(value, 'hit');
    if (typeof hit.slug !== 'string' || !hit.slug.trim() || ids.has(hit.slug) ||
        typeof hit.title !== 'string' || typeof hit.excerpt !== 'string' || typeof hit.url !== 'string' ||
        (hit.score !== undefined && (typeof hit.score !== 'number' || !Number.isFinite(hit.score)))) {
      throw new Error('invalid or duplicate delivered docs hit');
    }
    ids.add(hit.slug);
    return {
      docId: hit.slug, rank: index + 1, source: 'docs:search',
      // The ENTIRE final returned row: no body re-fetch, second excerpt, clip,
      // dedup, field selection or re-ranking. Qualifiers/unknown fields survive.
      docText: JSON.stringify(hit),
      ...(typeof hit.score === 'number' ? { score: hit.score } : {}),
    };
  });
  return {
    inputContract: DOCS_FINAL_INPUT_CONTRACT,
    rawStdoutSha256: createHash('sha256').update(saved.stdout).digest('hex'),
    // Includes CLI startup/transport; this is not the server's engine duration.
    clientDeliveryWallMs: saved.deliveryWallMs,
    degraded: legs.degraded,
    hits,
    // Preserve counts, scope, coverage and warnings outside per-hit labels too.
    response,
  };
}
