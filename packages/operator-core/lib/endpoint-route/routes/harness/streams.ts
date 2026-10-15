/**
 * SSE streams for the harness UI:
 *
 *   GET /api/harness/:slug/agents/:runId/stream   — live "thinking" timeline for one agent run
 *   GET /api/harness/:slug/stream                 — text log + feature-diff heartbeats
 *   GET /api/harness/:slug/log/stream             — structured JSONL log stream
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 38). All three share the `activeStreams` registry from
 * `lib/harness-active-streams.ts` (carved out in b36) and use the
 * `@papercusp/sse` `sseResponse` helper.
 */
import { join } from 'node:path';
import { statSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { sseResponse } from '@papercusp/sse';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { resolvePhasedProject, harnessDir, parseFeatures, tailFile } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import {
  activeStreams,
  HARNESS_STREAM_TOTAL_CAP,
  type StreamToken,
} from '../../../harness-active-streams';
import { defineTool } from '@papercusp/tooldef';
import type { AgentTimelineEntry } from '../../../cross-boundary-event-contracts';
import { createAgentTimelineParser, parseAgentTimelineChunks, readOwnerSessionTimeline, SESSION_STREAM_HEARTBEAT_MS } from '../../../owner-sessions/timeline';
export { splitCompleteJsonlSnapshot, createAgentTimelineParser, parseAgentTimelineChunks, pickSessionTurnWindow, sessionPartEntryKind, backfillFromSessionParts, POSITIONAL_SCAN_CEILING, positionalScanLimit, preferHigherFidelityBackfill, shouldServeDbBackfill, backfillFromSessionTurns, SESSION_STREAM_HEARTBEAT_MS, sessionThinkingKey } from '../../../owner-sessions/timeline';

function remoteIpFrom(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    req.headers.get('cf-connecting-ip') ??
    'unknown'
  );
}

export type { AgentTimelineEntry } from '../../../cross-boundary-event-contracts';

export const HARNESS_STREAM_LOG_CHUNK_BYTES = 64 * 1024;
export const HARNESS_STREAM_LOG_BATCH_LINES = 100;
export const HARNESS_STREAM_LOG_BATCH_BYTES = 64 * 1024;

/**
 * The old Run-view only reads these feature fields. `parseFeatures` also
 * returns notes, metadata, provenance, and other detail columns that can be
 * very large; sending those on every 3-second heartbeat made one `features`
 * event reach tens of megabytes. Keep the event name and list shape stable,
 * while retaining the fields the view actually renders/filters.
 */
export const HARNESS_STREAM_FEATURE_TEXT_CAP = 1_000;
export const HARNESS_STREAM_FEATURE_CLAIMS_CAP = 32;
export const HARNESS_STREAM_FEATURE_TAGS_CAP = 32;
export const HARNESS_STREAM_FEATURE_PAYLOAD_CAP_BYTES = 4 * 1024 * 1024;

const STREAM_TEXT_ENCODER = new TextEncoder();

function utf8ByteLength(value: string): number {
  return STREAM_TEXT_ENCODER.encode(value).byteLength;
}

/**
 * Split text on Unicode scalar boundaries so each returned string's encoded
 * bytes stay within `maxBytes`. A UTF-8 scalar is at most four bytes, so the
 * effective minimum is four even if a caller passes a smaller limit.
 * Pure — exported for regression tests.
 */
export function splitUtf8Chunks(
  value: string,
  maxBytes = HARNESS_STREAM_LOG_CHUNK_BYTES,
): string[] {
  if (!value) return [];
  const limit = Math.max(4, Math.floor(maxBytes));
  const chunks: string[] = [];
  let start = 0;
  let used = 0;

  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!;
    const width = codePoint > 0xffff ? 2 : 1;
    const charBytes = utf8ByteLength(value.slice(index, index + width));
    if (used > 0 && used + charBytes > limit) {
      chunks.push(value.slice(start, index));
      start = index;
      used = 0;
    }
    used += charBytes;
    index += width;
  }
  if (start < value.length) chunks.push(value.slice(start));
  return chunks;
}

/**
 * Join raw log lines into bounded SSE payloads. A line that is itself larger
 * than the limit is split safely by `splitUtf8Chunks`; normal lines remain
 * newline-delimited so the existing Run-view consumer can append them.
 * Pure — exported for regression tests.
 */
export function batchRawLogLines(
  lines: Iterable<string>,
  maxBytes = HARNESS_STREAM_LOG_BATCH_BYTES,
  maxLines = HARNESS_STREAM_LOG_BATCH_LINES,
): string[] {
  const byteLimit = Math.max(4, Math.floor(maxBytes));
  const lineLimit = Math.max(1, Math.floor(maxLines));
  const batches: string[] = [];
  let current = '';
  let currentBytes = 0;
  let currentLines = 0;
  const flush = () => {
    if (!current) return;
    batches.push(current);
    current = '';
    currentBytes = 0;
    currentLines = 0;
  };

  for (const rawLine of lines) {
    const line = rawLine.endsWith('\n') ? rawLine : `${rawLine}\n`;
    for (const part of splitUtf8Chunks(line, byteLimit)) {
      const partBytes = utf8ByteLength(part);
      if (current && (currentLines >= lineLimit || currentBytes + partBytes > byteLimit)) {
        flush();
      }
      current += part;
      currentBytes += partBytes;
      currentLines += 1;
      if (currentBytes >= byteLimit || currentLines >= lineLimit) flush();
    }
  }
  flush();
  return batches;
}

function capStreamFeatureText(value: unknown): unknown {
  if (typeof value !== 'string' || value.length <= HARNESS_STREAM_FEATURE_TEXT_CAP) return value;
  return `${value.slice(0, HARNESS_STREAM_FEATURE_TEXT_CAP)}…`;
}

/**
 * Project one parsed feature to the legacy Run-view contract without carrying
 * heavy detail columns across the SSE/IPC boundary. Pure — exported for tests.
 */
export function slimFeatureForStream(feature: any): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: feature?.id,
    title: capStreamFeatureText(feature?.title),
    status: feature?.status,
    attempts: feature?.attempts,
  };
  if (feature?.summary != null) out.summary = capStreamFeatureText(feature.summary);
  if (Array.isArray(feature?.claims)) {
    out.claims = feature.claims
      .slice(0, HARNESS_STREAM_FEATURE_CLAIMS_CAP)
      .map((claim: unknown) => capStreamFeatureText(claim));
  }
  if (feature?.project_id != null) out.project_id = capStreamFeatureText(feature.project_id);
  if (Array.isArray(feature?.tags)) {
    out.tags = feature.tags
      .slice(0, HARNESS_STREAM_FEATURE_TAGS_CAP)
      .map((tag: unknown) => capStreamFeatureText(tag));
  }
  return out;
}

export function slimFeaturesForStream(features: readonly any[]): Record<string, unknown>[] {
  return features.map(slimFeatureForStream);
}

export type HarnessStreamFeatureState = [unknown, unknown, unknown];

/** The compact state tuple used when even the legacy feature projection is too large. */
export function featureStateForStream(features: readonly any[]): HarnessStreamFeatureState[] {
  return features.map((feature) => [feature?.id, feature?.status, feature?.attempts]);
}

/**
 * Preserve the legacy feature-object payload for ordinary harnesses, but
 * degrade a pathological feature corpus to the compact state tuples already
 * used by the stream's change detector. This keeps the `features` event name
 * and array contract while preventing detail text from crossing IPC in bulk.
 */
export function featuresForStreamEvent(
  features: readonly any[],
): Record<string, unknown>[] | HarnessStreamFeatureState[] {
  const slim = slimFeaturesForStream(features);
  return utf8ByteLength(JSON.stringify(slim)) <= HARNESS_STREAM_FEATURE_PAYLOAD_CAP_BYTES
    ? slim
    : featureStateForStream(features);
}

async function readRunChunkBackfill(harnessSlug: string, runId: string): Promise<{ chunks: string[]; lastSeq: number } | null> {
  try {
    const { sql } = (await import('@papercusp/db-org')).getOrgPg();
    const rows = await sql<{ seq: number; chunk_data: string }[]>`
      SELECT seq, chunk_data
        FROM (
          SELECT seq, chunk_data
            FROM harness_shared.harness_run_chunks
           WHERE harness_slug = ${harnessSlug}
             AND run_id = ${runId}
           ORDER BY seq DESC
           LIMIT 500
        ) AS recent
       ORDER BY seq ASC
    `;
    return rows.length > 0
      ? { chunks: rows.map((r) => r.chunk_data), lastSeq: rows[rows.length - 1].seq }
      : null;
  } catch {
    return null;
  }
}

/**
 * SSE: live stream of one agent run's "thinking" — text deltas, tool
 * uses, tool results, and the terminal `result` event.
 *
 * Powers the hover popover on Now-running agent pills. On connect,
 * backfills the parsed timeline so the popover paints immediately,
 * then appends new events from the run-chunk bus. Closes when the
 * agent emits its `result` event or the client disconnects.
 */
const agentRunStream = defineTool({
  method: 'GET',
  path: '/harness/:slug/agents/:runId/stream',
  // SECURITY (auth: 'loopback', WI-1388): reads a harness run's "thinking" timeline
  // (tool inputs/RESULTS, which can hold file contents + secrets) by raw caller-supplied
  // slug/runId with NO workspace/ownership scoping — unauthenticated data exposure on a
  // network-exposed bind. The only consumer is the loopback desktop webview via a relative
  // /api URL (AgentThinkingPopover); the mobile path has its own device-JWT endpoint
  // (/device/harnesses/:slug/log/stream) and does not touch this one. Gate loopback-only:
  // non-loopback → 403 (enforced under ENDPOINT_AUTH_TIERS / fail-closed if the flag layer
  // is down; PAPERCUSP_ALLOW_REMOTE_ADMIN=1 is the deliberate remote opt-out). A per-principal
  // + workspace-scoped check is the follow-up for a genuine multi-tenant/exposed deployment.
  auth: 'loopback',
  sampleRate: 0,
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const runId = (ctx.params.runId as string).replace(/[^A-Za-z0-9_.-]/g, '');
    const logDir = join(harnessDir(project), 'logs');
    const jsonlPath = join(logDir, `${runId}.jsonl`);

    const remoteIP = remoteIpFrom(req);
    const streamKey = `agent|${remoteIP}|${project.slug}|${runId}`;
    if (!activeStreams.has(streamKey) && activeStreams.size >= HARNESS_STREAM_TOTAL_CAP) {
      return Response.json(
        { error: 'too many active streams', cap: HARNESS_STREAM_TOTAL_CAP },
        { status: 503 },
      );
    }
    const previous = activeStreams.get(streamKey);
    if (previous) previous.abort();

    const parser = createAgentTimelineParser();

    return sseResponse({
      signal: req.signal,
      heartbeatMs: SESSION_STREAM_HEARTBEAT_MS,
      setup: async (sink) => {
        const token: StreamToken = {
          abort: () => { sink.close(); },
          createdAt: Date.now(),
          remoteIP,
          slug: project.slug,
        };
        activeStreams.set(streamKey, token);
        sink.onClose(() => {
          if (activeStreams.get(streamKey) === token) activeStreams.delete(streamKey);
        });

        let lineBuf = '';
        let done = false;

        const emitChunk = (chunk: string) => {
          lineBuf += chunk;
          let nl: number;
          while ((nl = lineBuf.indexOf('\n')) !== -1) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            if (!line) continue;
            const entries = parser.parseLine(line);
            for (const e of entries) {
              sink.event('event', e);
              if (e.kind === 'result') {
                done = true;
                sink.event('done', {});
                sink.close();
                return;
              }
            }
          }
        };

        let backfillRaw: string | null = null;
        let backfillChunks: string[] | null = null;
        let backfillChunkLastSeq = -1;
        try {
          const { sql } = (await import('@papercusp/db-org')).getOrgPg();
          const rows = await sql<{ jsonl_body: string }[]>`
            SELECT jsonl_body FROM harness_shared.harness_run_output
             WHERE harness_slug = ${project.slug} AND run_id = ${runId}
             LIMIT 1
          `;
          if (rows.length > 0 && rows[0].jsonl_body) {
            backfillRaw = rows[0].jsonl_body;
          }
        } catch { /* fall through to disk */ }
        if (backfillRaw === null) {
          const chunkBackfill = await readRunChunkBackfill(project.slug, runId);
          if (chunkBackfill) {
            backfillChunks = chunkBackfill.chunks;
            backfillChunkLastSeq = chunkBackfill.lastSeq;
          }
        }
        if (backfillRaw === null) {
          try {
            const stat = statSync(jsonlPath);
            if (stat.size > 0) {
              backfillRaw = readFileSync(jsonlPath, 'utf8');
            }
          } catch { /* no file yet either */ }
        }

        if (backfillChunks && backfillChunks.length > 0) {
          const parsed = parseAgentTimelineChunks(backfillChunks);
          done = parsed.done;
          const capped = parsed.entries.length > 200 ? parsed.entries.slice(-200) : parsed.entries;
          sink.event('backfill', capped);
          if (done) { sink.event('done', {}); sink.close(); return; }
        } else if (backfillRaw && backfillRaw.length > 0) {
          const backfill: AgentTimelineEntry[] = [];
          for (const rawLine of backfillRaw.split('\n')) {
            const line = rawLine.trim();
            if (!line) continue;
            for (const e of parser.parseLine(line)) {
              backfill.push(e);
              if (e.kind === 'result') done = true;
            }
          }
          backfill.push(...parser.flush());
          const capped = backfill.length > 200 ? backfill.slice(-200) : backfill;
          sink.event('backfill', capped);
          if (done) { sink.event('done', {}); sink.close(); return; }
        } else {
          sink.event('backfill', []);
        }

        const { subscribe: busSubscribe } = await import('../../../run-chunk-bus');
        const channelKey = `${project.slug}:${runId}`;
        const busSub = busSubscribe(channelKey, (env) => {
          if (sink.closed) return;
          if (env.seq <= backfillChunkLastSeq) return;
          emitChunk(env.data);
        });
        for (const env of busSub.recent) {
          if (env.seq <= backfillChunkLastSeq) continue;
          emitChunk(env.data);
          if (sink.closed) break;
        }
        void busSub.whenDone.then(() => {
          if (!done && !sink.closed) {
            done = true;
            sink.event('done', {});
            sink.close();
          }
        });
        sink.onClose(() => busSub.unsubscribe());
      },
    });
  },
});

/**
 * SSE: tail run.log + push feature-diff heartbeats. Legacy text-log
 * stream consumed by the harness Run-view.
 */
const slugStream = defineTool({
  method: 'GET',
  path: '/harness/:slug/stream',
  // SECURITY (auth: 'loopback', WI-1388): tails a harness run.log (can hold tool
  // outputs + secrets) by raw caller-supplied slug with NO ownership scoping. The only
  // consumer is the loopback desktop webview via a relative /api URL (the Run-view);
  // the mobile path uses its own device-JWT endpoint. Gate loopback-only (non-loopback
  // → 403; PAPERCUSP_ALLOW_REMOTE_ADMIN=1 is the deliberate remote opt-out).
  auth: 'loopback',
  sampleRate: 0,
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const runLogPath = join(harnessDir(project), 'logs', 'run.log');

    const remoteIP = remoteIpFrom(req);
    const streamKey = `${remoteIP}|${project.slug}`;

    if (!activeStreams.has(streamKey) && activeStreams.size >= HARNESS_STREAM_TOTAL_CAP) {
      return Response.json(
        { error: 'too many active streams', cap: HARNESS_STREAM_TOTAL_CAP },
        { status: 503 },
      );
    }
    const previous = activeStreams.get(streamKey);
    if (previous) previous.abort();

    return sseResponse({
      signal: req.signal,
      heartbeatMs: SESSION_STREAM_HEARTBEAT_MS,
      setup: async (sink) => {
        const token: StreamToken = {
          abort: () => { sink.close(); },
          createdAt: Date.now(),
          remoteIP,
          slug: project.slug,
        };
        activeStreams.set(streamKey, token);
        sink.onClose(() => {
          if (activeStreams.get(streamKey) === token) activeStreams.delete(streamKey);
        });

        let lastFeatureState = '';

        const emitLogText = (text: string) => {
          for (const chunk of splitUtf8Chunks(text, HARNESS_STREAM_LOG_CHUNK_BYTES)) {
            if (sink.closed) return;
            sink.eventRaw('log', chunk);
          }
        };
        const emitLogLines = (lines: Iterable<string>) => {
          for (const batch of batchRawLogLines(
            lines,
            HARNESS_STREAM_LOG_BATCH_BYTES,
            HARNESS_STREAM_LOG_BATCH_LINES,
          )) {
            if (sink.closed) return;
            sink.eventRaw('log', batch);
          }
        };

        try {
          const chunk = tailFile(runLogPath, 256 * 1024);
          if (chunk) emitLogText(chunk);
        } catch { /* no log file yet */ }

        let liveLineBatch: string[] = [];
        let liveLineBatchBytes = 0;
        let liveFlushTimer: ReturnType<typeof setTimeout> | null = null;
        const flushLiveLines = () => {
          if (liveFlushTimer) {
            clearTimeout(liveFlushTimer);
            liveFlushTimer = null;
          }
          if (liveLineBatch.length === 0) return;
          const lines = liveLineBatch;
          liveLineBatch = [];
          liveLineBatchBytes = 0;
          emitLogLines(lines);
        };
        const queueLiveLine = (line: string) => {
          if (sink.closed) return;
          const text = line.endsWith('\n') ? line : `${line}\n`;
          liveLineBatch.push(text);
          liveLineBatchBytes += utf8ByteLength(text);
          if (
            liveLineBatch.length >= HARNESS_STREAM_LOG_BATCH_LINES ||
            liveLineBatchBytes >= HARNESS_STREAM_LOG_BATCH_BYTES
          ) {
            flushLiveLines();
          } else if (!liveFlushTimer) {
            // Coalesce a short burst without adding meaningful latency to the
            // Run-view. Thresholds above remain the hard memory/frame bounds.
            liveFlushTimer = setTimeout(flushLiveLines, 25);
          }
        };

        const { subscribe: logSubscribe } = await import('../../../harness-log-bus');
        const sub = logSubscribe(`${project.slug}:raw`, (env) => {
          queueLiveLine(env.line);
        });
        emitLogLines(sub.recent.map((env) => env.line));
        sink.onClose(() => {
          flushLiveLines();
          sub.unsubscribe();
        });

        const pushFeatures = async () => {
          if (sink.closed) return;
          // This legacy stream only publishes the Run-view projection below;
          // do not materialize notes/metadata/provenance for every 3s poll.
          const feats = await parseFeatures(project, { projection: 'stream' });
          const streamFeatures = featuresForStreamEvent(feats);
          const state = JSON.stringify(featureStateForStream(feats));
          if (state !== lastFeatureState) {
            lastFeatureState = state;
            sink.event('features', streamFeatures);
          }
        };
        while (!sink.closed) {
          await pushFeatures();
          if (sink.closed) break;
          await new Promise((r) => setTimeout(r, 3000));
        }
      },
    });
  },
});

/**
 * SSE: structured JSONL log stream. Tails run.log.jsonl (no polling),
 * emits one SSE event per JSON line. On connect, backfills the last
 * `tail` events.
 */
const logStream = defineTool({
  method: 'GET',
  path: '/harness/:slug/log/stream',
  // SECURITY (auth: 'loopback', WI-1388): tails a harness run.log.jsonl (structured
  // log; can hold tool outputs + secrets) by raw caller-supplied slug with NO ownership
  // scoping. The only consumer is the loopback desktop webview via a relative /api URL
  // (RealLogsPanel); the mobile path has its OWN device-JWT /device/harnesses/:slug/log/stream
  // (which re-implements the tail, not a proxy to this one). Gate loopback-only (non-loopback
  // → 403; PAPERCUSP_ALLOW_REMOTE_ADMIN=1 is the deliberate remote opt-out).
  auth: 'loopback',
  sampleRate: 0,
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const jsonlPath = join(harnessDir(project), 'logs', 'run.log.jsonl');
    const tailSize = Math.min(
      Math.max(parseInt(url.searchParams.get('tail') ?? '500', 10) || 500, 1),
      5000,
    );

    const remoteIP = remoteIpFrom(req);
    const streamKey = `jsonl|${remoteIP}|${project.slug}`;
    if (!activeStreams.has(streamKey) && activeStreams.size >= HARNESS_STREAM_TOTAL_CAP) {
      return Response.json(
        { error: 'too many active streams', cap: HARNESS_STREAM_TOTAL_CAP },
        { status: 503 },
      );
    }
    const previous = activeStreams.get(streamKey);
    if (previous) previous.abort();

    return sseResponse({
      signal: req.signal,
      heartbeatMs: SESSION_STREAM_HEARTBEAT_MS,
      setup: async (sink) => {
        const token: StreamToken = {
          abort: () => { sink.close(); },
          createdAt: Date.now(),
          remoteIP,
          slug: project.slug,
        };
        activeStreams.set(streamKey, token);
        sink.onClose(() => {
          if (activeStreams.get(streamKey) === token) activeStreams.delete(streamKey);
        });

        try {
          const stat = statSync(jsonlPath);
          const tailBytes = 1024 * 1024;
          const start = Math.max(0, stat.size - tailBytes);
          const len = stat.size - start;
          const buf = Buffer.alloc(len);
          const fd = openSync(jsonlPath, 'r');
          try { readSync(fd, buf, 0, len, start); }
          finally { closeSync(fd); }
          let chunk = buf.toString('utf8');
          if (start > 0) {
            const firstNl = chunk.indexOf('\n');
            if (firstNl >= 0) chunk = chunk.slice(firstNl + 1);
          }
          const allLines = chunk.split('\n').filter(Boolean);
          const toReplay = allLines.slice(-tailSize);
          let count = 0;
          for (const raw of toReplay) {
            if (sink.closed) break;
            try { JSON.parse(raw); }
            catch { continue; }
            sink.eventRaw('log', raw);
            count++;
          }
          sink.eventRaw('backfill-done', String(count));
        } catch {
          sink.eventRaw('backfill-done', '0');
        }

        const { subscribe: logSubscribe } = await import('../../../harness-log-bus');
        const sub = logSubscribe(`${project.slug}:log`, (env) => {
          if (sink.closed) return;
          try { JSON.parse(env.line); }
          catch { return; }
          sink.eventRaw('log', env.line);
        });
        for (const env of sub.recent) {
          if (sink.closed) break;
          try { JSON.parse(env.line); }
          catch { continue; }
          sink.eventRaw('log', env.line);
        }
        sink.onClose(() => sub.unsubscribe());
      },
    });
  },
});

const sessionThinkingStream = defineTool({
  method: 'GET',
  path: '/adv/session/thinking',
  auth: 'loopback',
  sampleRate: 0,
  handler: req => readOwnerSessionTimeline(req),
});

export default [agentRunStream, slugStream, logStream, sessionThinkingStream];
