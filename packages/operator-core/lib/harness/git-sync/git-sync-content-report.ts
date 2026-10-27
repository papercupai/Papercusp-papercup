import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import type { ScopedContentError } from './run-git-sync';

/** Searchable/health views are previews; the artifact remains the exact evidence. */
export const CONTENT_REPORT_PREVIEW_LIMIT = 20;
const PREVIEW_FIELD_BYTES = 512;

export function contentReportPreviewText(value: string): string {
  if (Buffer.byteLength(value) <= PREVIEW_FIELD_BYTES) return value;
  return Buffer.from(value).subarray(0, PREVIEW_FIELD_BYTES - 3).toString('utf8').replace(/\uFFFD$/, '') + '…';
}

/** Same set identity as the former joined signature, with a fixed storage size. */
export function gitSyncContentSignature(errors: readonly ScopedContentError[]): string {
  const keys = [...new Set(errors.map(c => `${c.scope}\u001f${c.file}\u001f${c.detectorKey}`))].sort();
  return 'sha256:' + createHash('sha256').update(keys.join('\u001e')).digest('hex');
}

export function gitSyncContentPreview(errors: readonly ScopedContentError[]) {
  return errors.slice(0, CONTENT_REPORT_PREVIEW_LIMIT).map(c => ({
    scope: contentReportPreviewText(c.scope),
    file: contentReportPreviewText(c.file),
    detector: contentReportPreviewText(c.detectorKey),
    error: contentReportPreviewText(c.error),
    ...(c.contentHash ? { contentHash: contentReportPreviewText(c.contentHash) } : {}),
    ...(c.detectorResultHash ? { detectorResultHash: contentReportPreviewText(c.detectorResultHash) } : {}),
    ...(c.excludedRoot ? { excludedRoot: contentReportPreviewText(c.excludedRoot) } : {}),
    ...(c.excludedRootReason ? { excludedRootReason: contentReportPreviewText(c.excludedRootReason) } : {}),
  }));
}

export function gitSyncContentEscalationBody(
  slug: string, errors: readonly ScopedContentError[], consecutiveTicks: number,
  needsHuman: boolean, evidenceArtifact: string | null,
): string {
  const files = gitSyncContentPreview(errors);
  const list = files.map(c => `${c.scope}/${c.file} [${c.detector}]`).join(', ');
  return JSON.stringify({
    kind: 'git-sync-content-error', harness_slug: slug, files,
    file_count: errors.length, files_omitted: errors.length - files.length,
    evidence_artifact: evidenceArtifact,
    consecutive_content_error_ticks: consecutiveTicks, needs_human: needsHuman,
    emitted_at: Date.now(),
    detail: needsHuman
      ? `git-sync content guard: ${errors.length} file(s) STILL failing their content check after ${consecutiveTicks} ticks — the content-fixer could not repair them; a human must fix: ${list}. (They are quarantined — excluded from every auto-commit — so staging stays clean while they wait.) Full evidence: ${evidenceArtifact}.`
      : `git-sync quarantined ${errors.length} broken file(s) (excluded from the auto-commit so staging stays clean); content-fixer dispatched: ${list}. Full evidence: ${evidenceArtifact}.`,
  });
}

/** Reuse the non-indexed PG artifact store. Never spill full diagnostics into a
 * tsvector-backed summary. Workspace is explicit, including on conflict. */
export async function persistGitSyncContentReport(
  slug: string, workspaceId: string, errors: readonly ScopedContentError[],
): Promise<string | null> {
  if (errors.length === 0) return null;
  const content = JSON.stringify({ schemaVersion: 1, workspaceId, harness: slug, files: errors });
  const digest = createHash('sha256').update(content).digest('hex');
  const path = `git-sync/content-errors/${digest}.json`;
  const { sql } = getOrgPg();
  await sql.unsafe(
    `INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, updated_at, workspace_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (harness_slug, rel_path) DO UPDATE SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at
     WHERE harness_text_artifacts.workspace_id = EXCLUDED.workspace_id`,
    [slug, path, content, Date.now(), workspaceId],
  );
  return path;
}
