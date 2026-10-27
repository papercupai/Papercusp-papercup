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
