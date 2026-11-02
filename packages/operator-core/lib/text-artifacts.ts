/**
 * PG-canonical text artifacts (Migration 035, Phase 2).
 *
 * Reads/writes for free-form text files keyed (harness_slug, rel_path).
 * The on-disk files at `<harness_dir>/.papercusp/<rel_path>` are written
 * as best-effort mirrors on each save so tools running INSIDE the
 * harness process (orchestrator, workers, plugin scripts) see the same
 * content. PG remains canonical.
 *
 * The orchestrator's role-prompt + snapshot-state read these files
 * directly: supervisor-notes.md, issues.md, memory/*.md, prompts/*.md,
 * etc. If a write only lands in PG and never on disk, the operator UI
 * reads it via loadTextArtifact but the orchestrator/worker is blind
 * to it (verified at round 18: PG=146986b vs file=148628b drift on
 * sheets/issues.md after operator-side edits).
 *
 * Path normalization: PG keys are relative-to-harness-dir (no leading
 * `.papercusp/`). Some callers pass paths with `.papercusp/` prefix (e.g. the
 * memory-file UI uses MEMORY_MAP entries that include the prefix); those
 * get stripped here so reads/writes always hit the same row. Disk path
 * always restores `<harness_dir>/.papercusp/<key>`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { getOrgPg, generated, typedSql } from '@papercusp/db-org';
import { and, eq, or, sql } from 'drizzle-orm';

const t = generated.harnessTextArtifactsInHarnessShared;
import { loadHarnessRegistry } from './harness-registry';
import { notifySyncInvalidate } from './sync-sse';
import { activeWorkspaceId } from './workspace-registry';

/**
 * workspace_id stamp for operator-side writes (EI-280): this lib runs on the
 * admin handle (RLS-bypass), so without an explicit stamp every insert minted
 * a blank-workspace row — invisible to the RLS-scoped artifacts:* agent tools
 * and a poison pill for their upserts. Stamp the operator's active workspace;
 * on conflict, adopt a blank-stamped legacy row (never re-home a properly
 * stamped one).
 */
const adoptBlankWorkspace = sql`CASE WHEN ${t.workspaceId} = '' THEN EXCLUDED.workspace_id ELSE ${t.workspaceId} END`;

function normalizeRelPath(rel: string): string {
  // Drop leading `.papercusp/` so the PG key is consistent with the bare
  // relative-to-harness-dir convention.
  return rel.replace(/^\.papercusp\//, '');
}

/** Content-addressed snapshots share the canonical artifact table, not its mirrors.
 * Ordinary artifact mutations cannot replace, append to or delete these revisions.
 * Raw DB/admin compromise is outside this API guarantee; reads verify bytes anew.
 */
const IMMUTABLE_PREFIX = 'immutable/sha256/';
function assertMutableKey(key: string): void {
  if (key.startsWith('immutable/')) throw new Error('text_artifact_immutable_namespace');
}
function immutableKey(sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('text_artifact_invalid_digest');
  return `${IMMUTABLE_PREFIX}${sha256}.json`;
}
const contentSha256 = (content: string) => createHash('sha256').update(content).digest('hex');

export async function loadImmutableTextArtifact(slug: string, sha256: string): Promise<string | null> {
  const { db } = getOrgPg();
  const rows = await db.select({ content: t.content }).from(t).where(and(
    eq(t.harnessSlug, slug), eq(t.relPath, immutableKey(sha256)), eq(t.workspaceId, activeWorkspaceId()),
  )).limit(1);
  const content = rows[0]?.content ?? null;
  if (content !== null && contentSha256(content) !== sha256) throw new Error('text_artifact_immutable_corrupt');
  return content;
}

/** Idempotent concurrent insert; a collision/foreign scope never overwrites a row. */
export async function saveImmutableTextArtifact(slug: string, content: string): Promise<{ sha256: string; relPath: string }> {
  const sha256 = contentSha256(content), relPath = immutableKey(sha256);
  const { db } = getOrgPg();
  await db.insert(t).values({ harnessSlug: slug, relPath, content,
    updatedAt: Date.now(), workspaceId: activeWorkspaceId() }).onConflictDoNothing();
  if (await loadImmutableTextArtifact(slug, sha256) !== content) throw new Error('text_artifact_immutable_conflict');
  return { sha256, relPath };
}

/** Permanent first-writer slots in the SAME canonical store. Used for execution
 * consumption, where content addressing alone cannot exclude a second start.
 * A crash after claiming deliberately leaves an uncertain/consumed execution;
 * callers must inspect it, never silently retry a potentially effected run.
 */
function immutableClaimKey(slot: string): string {
  if (!slot.trim()) throw new Error('text_artifact_empty_claim');
  return `immutable/claims/${contentSha256(slot)}.json`;
}
export async function loadImmutableTextArtifactClaim(slug: string, slot: string): Promise<string | null> {
  const { db } = getOrgPg();
  const rows = await db.select({ content: t.content }).from(t).where(and(
    eq(t.harnessSlug, slug), eq(t.relPath, immutableClaimKey(slot)), eq(t.workspaceId, activeWorkspaceId()),
  )).limit(1);
  if (!rows.length) return null;
  const value = JSON.parse(rows[0].content) as { sha256: string; content: string };
  if (typeof value.content !== 'string' || contentSha256(value.content) !== value.sha256) {
    throw new Error('text_artifact_immutable_corrupt');
  }
  return value.content;
}
export async function claimImmutableTextArtifact(slug: string, slot: string, content: string): Promise<boolean> {
  const { db } = getOrgPg();
  const rows = await db.insert(t).values({ harnessSlug: slug, relPath: immutableClaimKey(slot),
    content: JSON.stringify({ sha256: contentSha256(content), content }),
    updatedAt: Date.now(), workspaceId: activeWorkspaceId(),
  }).onConflictDoNothing().returning({ relPath: t.relPath });
  if (await loadImmutableTextArtifactClaim(slug, slot) !== content) throw new Error('text_artifact_immutable_claim_conflict');
  return rows.length === 1;
}

async function notifyTextArtifactChange(slug: string, _key: string): Promise<void> {
  // Generic invalidation — clients subscribed to harnessTextArtifact.byHarness
  // refetch. The query returns all rows for the slug, so per-relPath args
  // would be ignored. (Renamed from byHarnessAndPath in the eager-fetch arc.)
  await notifySyncInvalidate('harnessTextArtifact.byHarness', {
    harnessSlug: slug,
  });
}

/** Resolve `<harness_dir>/.papercusp/<rel_path>` for the given slug. Returns
 *  null when the harness isn't in the registry (operator-side write to a
 *  not-yet-registered harness — ignore the disk mirror in that case). */
async function diskPathFor(slug: string, key: string): Promise<string | null> {
  const reg = await loadHarnessRegistry();
  const project = reg.projects.find((p) => p.slug === slug);
  if (!project) return null;
  return join(project.path, '.papercusp', key);
}

/** Best-effort mirror to disk. PG row is canonical; disk is for the
 *  orchestrator/worker process to read via `<harness_dir>/.papercusp/<rel>`. */
async function mirrorToDisk(slug: string, key: string, content: string): Promise<void> {
  try {
    const path = await diskPathFor(slug, key);
    if (!path) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  } catch {
    /* file write failed — PG already won; orchestrator will see stale on
     *  disk until next write. Acceptable for V1; the alternative (failing
     *  the PG write) trades a worse failure mode (silent UI loss). */
  }
}

export async function loadTextArtifact(slug: string, relPath: string): Promise<string | null> {
  const key = normalizeRelPath(relPath);
  const { db } = getOrgPg();
  const rows = await db
    .select({ content: t.content })
    .from(t)
    .where(and(eq(t.harnessSlug, slug), eq(t.relPath, key)))
    .limit(1);
  return rows[0]?.content ?? null;
}

export interface SaveTextArtifactOpts {
  /** Override the disk mirror path. Default: `<project.path>/.papercusp/<rel_path>`.
   *  Use for files whose canonical disk location is NOT under .papercusp/ —
   *  e.g. .mcp.json at project root, .claude/settings.json. The PG row is
   *  always keyed by the rel_path passed in, regardless of disk location. */
  customDiskPath?: string;
}

export async function saveTextArtifact(slug: string, relPath: string, content: string, opts: SaveTextArtifactOpts = {}): Promise<void> {
  const key = normalizeRelPath(relPath);
  assertMutableKey(key);
  const { db } = getOrgPg();
  const now = Date.now();
  await db
    .insert(t)
    .values({ harnessSlug: slug, relPath: key, content, updatedAt: now, workspaceId: activeWorkspaceId() })
    .onConflictDoUpdate({
      target: [t.harnessSlug, t.relPath],
      set: {
        content: sql`EXCLUDED.content`,
        updatedAt: sql`EXCLUDED.updated_at`,
        workspaceId: adoptBlankWorkspace,
      },
    });
  if (opts.customDiskPath) {
    try {
      await mkdir(dirname(opts.customDiskPath), { recursive: true });
      await writeFile(opts.customDiskPath, content, 'utf8');
    } catch { /* mirror best-effort */ }
  } else {
    await mirrorToDisk(slug, key, content);
  }
  await notifyTextArtifactChange(slug, key);
}

/** Conditional writes reuse the canonical artifact row; null means create-only.
 * Callers must read PG, never the best-effort disk mirror, before comparing.
 */
export async function compareAndSwapTextArtifact(slug: string, relPath: string,
  expectedContent: string | null, content: string): Promise<boolean> {
  const key = normalizeRelPath(relPath), workspaceId = activeWorkspaceId();
  assertMutableKey(key);
  const { db } = getOrgPg();
  const values = { content, updatedAt: Date.now(), workspaceId };
  const rows = expectedContent === null
    ? await db.insert(t).values({ harnessSlug: slug, relPath: key, ...values })
      .onConflictDoNothing().returning({ content: t.content })
    : await db.update(t).set(values).where(and(eq(t.harnessSlug, slug), eq(t.relPath, key),
      eq(t.content, expectedContent), or(eq(t.workspaceId, workspaceId), eq(t.workspaceId, ''))))
      .returning({ content: t.content });
  if (!rows.length) return false;
  await mirrorToDisk(slug, key, content);
  await notifyTextArtifactChange(slug, key);
  return true;
}

export async function appendTextArtifact(slug: string, relPath: string, suffix: string): Promise<void> {
  const key = normalizeRelPath(relPath);
  assertMutableKey(key);
  const { db } = getOrgPg();
  const now = Date.now();
  // PG-side `||` concat keeps the append atomic. Drizzle's `set` accepts
  // raw sql snippets for cases the query-builder can't express cleanly.
  // RETURNING comes back typed via .returning({ content }).
  const rows = await db
    .insert(t)
    .values({ harnessSlug: slug, relPath: key, content: suffix, updatedAt: now, workspaceId: activeWorkspaceId() })
    .onConflictDoUpdate({
      target: [t.harnessSlug, t.relPath],
      set: {
        content: sql`${t.content} || EXCLUDED.content`,
        updatedAt: sql`EXCLUDED.updated_at`,
        workspaceId: adoptBlankWorkspace,
      },
    })
    .returning({ content: t.content });
  const merged = rows[0]?.content ?? suffix;
  await mirrorToDisk(slug, key, merged);
  await notifyTextArtifactChange(slug, key);
}

export async function deleteTextArtifact(slug: string, relPath: string): Promise<void> {
  const key = normalizeRelPath(relPath);
  assertMutableKey(key);
  const { db } = getOrgPg();
  await db.delete(t).where(and(eq(t.harnessSlug, slug), eq(t.relPath, key)));
  // Don't unlink the file — the harness contract may have a different
  // process (orchestrator, harness-CLI) treating the file as primary. A
  // PG delete from the operator UI just stops mirroring; the file stays
  // until something else removes it.
  await notifyTextArtifactChange(slug, key);
}
