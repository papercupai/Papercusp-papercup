/** P016: publication-backed notification carried by existing issue federation. */
import type { Sql } from 'postgres';
import { completionHeadBlobMap } from '@papercusp/operator-core/lib/agent-tools/work_items/completion-freshness';
import { mergeIssuePayload } from '@papercusp/operator-core/lib/issues-engineer';
import { runWithWorkspace } from '@papercusp/operator-core/lib/workspace-als';
import { deriveReporterStatus, type ReporterReleaseReceipt } from '@papercusp/operator-core/lib/harness/improvements/reporter-status';
import { releaseConfig } from './release-config';
import type { ReleaseRow } from './release-registry';

interface ReportFix {
  id: string; harness: string; kind: string; status: string; title: string; summary: string; payload: unknown;
  completionRef: string | null; authority: string | null;
}
export interface ReporterReleaseDeps {
  repositoryRoot: string;
  readItems(): Promise<ReportFix[]>;
  /** Checks the exact artifact tree, including nested Git links. */
  readBlobs(commit: string, paths: string[]): Promise<ReadonlyMap<string, { status: string; sha?: string }> | undefined>;
  stamp(item: ReportFix, receipt: ReporterReleaseReceipt): Promise<boolean>;
}
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

export async function publishReporterRelease(row: ReleaseRow, deps: ReporterReleaseDeps): Promise<{ notified: string[]; unconfirmed: string[] }> {
  const result: { notified: string[]; unconfirmed: string[] } = { notified: [], unconfirmed: [] };
  if (!row.publishedAt || !row.gitSha || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(row.gitSha)) return result;
  for (const item of await deps.readItems()) {
    if (!row.workItemIds.includes(item.id)) continue;
    const payload = object(item.payload);
    if (object(payload.reporter).kind !== 'end-user') continue;
    const status = deriveReporterStatus({ ...item, completionAuthority: item.authority, terminalCompletionRef: item.completionRef });
    if (status.status !== 'awaiting-release' && status.status !== 'fixed') continue;
    if (status.release?.version === row.version && status.release.channel === row.channel) continue;
    const manifest = object(object(payload._completionEvidence).settlementManifest);
    const identities = Array.isArray(manifest.contentIdentity) ? manifest.contentIdentity.map(object) : [];
    // Missing, dirty, multi-checkout or deletion-only evidence cannot prove this fix.
    // Keep it unconfirmed instead of inventing a release outcome.
    const valid = manifest.repositoryRoot === deps.repositoryRoot && identities.length > 0 && identities.every((entry) =>
      typeof entry.path === 'string' && entry.path.length > 0 && !entry.path.startsWith('/') && !entry.path.split('/').includes('..')
      && typeof entry.headBlobSha === 'string' && entry.headBlobSha === entry.workingTreeBlobSha
      && (!entry.repositoryRoot || entry.repositoryRoot === manifest.repositoryRoot));
    if (!valid || !item.completionRef) { result.unconfirmed.push(item.id); continue; }
    const paths = identities.map((entry) => entry.path as string);
    const blobs = await deps.readBlobs(row.gitSha, paths);
    if (!blobs || identities.some((entry) => blobs.get(entry.path as string)?.status !== 'resolved'
      || blobs.get(entry.path as string)?.sha !== entry.headBlobSha)) { result.unconfirmed.push(item.id); continue; }
    const receipt: ReporterReleaseReceipt = {
      schemaVersion: 'reporter-release-v1', version: row.version, channel: row.channel,
      publishedAt: row.publishedAt.toISOString(), artifactCommit: row.gitSha, completionRef: item.completionRef,
      contentIdentity: identities.map((entry) => ({ path: entry.path as string, blobSha: entry.headBlobSha as string })),
    };
    if (await deps.stamp(item, receipt)) result.notified.push(item.id);
    else result.unconfirmed.push(item.id);
  }
  return result;
}

export function defaultReporterReleaseDeps(sql: Sql, workspaceId: string, row: ReleaseRow): ReporterReleaseDeps {
  return {
    repositoryRoot: releaseConfig().integrationRoot,
    async readItems() {
      const rows = await sql<Array<{ feature_id: string; harness_slug: string; item_kind: string; status: string; title: string; summary: string;
        payload: unknown; terminal_completion_ref: string | null; authority: string | null }>>`
        SELECT feature_id, harness_slug, item_kind, status, title, summary, payload, terminal_completion_ref, authority
          FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId} AND feature_id = ANY(${row.workItemIds}::text[]) AND origin = 'local'`;
      return rows.map((item) => ({ id: item.feature_id, harness: item.harness_slug, kind: item.item_kind, status: item.status,
        title: item.title, summary: item.summary, payload: item.payload, completionRef: item.terminal_completion_ref, authority: item.authority }));
    },
    readBlobs: (commit, paths) => completionHeadBlobMap(releaseConfig().integrationRoot, commit, paths),
    async stamp(item, receipt) {
      // Existing canonical writer preserves remote-authorship refusal and emits the
      // usual federation/sync invalidations. No direct lifecycle SQL write.
      return runWithWorkspace(workspaceId, async () => Boolean(await mergeIssuePayload(item.id, { reporterRelease: receipt }, { harnessSlug: item.harness })));
    },
  };
}
