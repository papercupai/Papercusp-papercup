/** Publish-time indexing, recovered by the existing chunk sync / embedding sweep. */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { planChunks, resolveChunkSurface, sharedChunkStore, parentShaOf, embeddedChunkText } from '@papercusp/search';
import type { ReportRecord } from '../report-library';
import { REPORTS_CHUNK_SURFACE } from './chunks/registry';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export interface ReportDocumentEmbedder {
  embed: (text: string) => Promise<number[]>;
  profileId: string;
  mode: string;
}

export async function indexReport(sql: Sql, report: ReportRecord, embedder?: ReportDocumentEmbedder | null) {
  const surface = resolveChunkSurface(REPORTS_CHUNK_SURFACE);
  const store = sharedChunkStore();
  const key = [report.workspaceId, report.reportId];
  const text = [report.title, report.summary || null, report.bodyMd].filter(v => v !== null).join('\n');
  const header = report.title.slice(0, 400);
  const plan = planChunks(surface, text, header, hash);
  if (plan.truncated) throw new Error('Report exceeds the registered complete-body chunk capacity');
  // Commit missing vectors first: a failed embed leaves an accountable sweep backlog.
  await store.transaction(sql, async tx => {
    const old = new Map((await store.readExisting(tx, surface, key)).map(c => [c.chunkSha, c]));
    await store.replace(tx, surface, key, plan.chunks.map(c => ({
      ...c, embedding: old.get(c.chunkSha)?.embedding ?? null,
      embeddingMode: old.get(c.chunkSha)?.embeddingMode ?? null,
      embeddingProfile: old.get(c.chunkSha)?.embeddingProfile ?? null,
    })), { parentSha: parentShaOf(hash, text, header), splitterVersion: surface.splitterVersion, version: report.updatedAt });
  });
  if (embedder === undefined) {
    const { resolveBackfillEmbedder } = await import('./embed-backfill');
    const resolved = await resolveBackfillEmbedder();
    embedder = resolved.mode === 'disabled' ? null : {
      embed: resolved.embed, profileId: resolved.profile.profileId, mode: resolved.mode,
    };
  }
  if (!embedder) return { chunks: plan.chunks.length, embedded: 0 };
  let embedded = 0;
  for (const chunk of plan.chunks) {
    const vector = await embedder.embed(embeddedChunkText(chunk.header, chunk.content));
    const rows = await sql`UPDATE harness_shared.text_chunks
      SET embedding = ${JSON.stringify(vector)}::vector,
          embedding_profile = ${embedder.profileId}, embedding_mode = ${embedder.mode}, updated_at = now()
      WHERE surface = 'report' AND parent_key = ${key}::text[] AND chunk_idx = ${chunk.chunkIdx}
        AND chunk_sha = ${chunk.chunkSha} AND embedding IS NULL RETURNING chunk_idx`;
    embedded += rows.length;
  }
  return { chunks: plan.chunks.length, embedded };
}
