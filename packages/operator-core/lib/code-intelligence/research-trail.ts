/** Optional caller-session research; never counted as a delivered push. */
import { withWorkspace } from '@papercusp/db-org';
import { loadHarnessRegistry } from '../harness-registry';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { activeWorkspaceId } from '../workspace-registry';
import { firstTouchPaths, grepLookupSubject, normalizePushCall, type PushInput } from './push-channel';
import { corroboratePushSources, peekPushSnapshot, type PushSnapshot } from './push-snapshot';

export const RESEARCH_TRAIL_LIMIT = 200;
export const RESEARCH_TRAIL_RETENTION_MS = 7 * 86_400_000;
export interface ResearchSubject {
  kind: 'path' | 'symbol';
  requested: string;
  path: string;
  symbolId?: string;
  seenAt: number;
}
export interface ResearchTrail {
  subjects: ResearchSubject[];
  reason?: 'trail not captured for this client' | 'nothing recorded';
}

/** Use the push channel's literal path and identifier parsers, excluding edits. */
export async function researchSubjects(input: PushInput, snapshot: PushSnapshot | null, now = Date.now()): Promise<ResearchSubject[]> {
  const calls = input.calls.slice(-12).map(normalizePushCall);
  const reads = calls.filter(call => /(?:^|_|:)(?:Read|read|Bash|bash)$|^exec_command$/.test(call.tool ?? ''));
  const subjects: ResearchSubject[] = firstTouchPaths({ ...input, calls: reads })
    .map(path => ({ kind: 'path', requested: path, path, seenAt: now }));
  if (!snapshot || !input.root) return subjects;
  for (const call of calls) {
    const name = grepLookupSubject(call);
    const candidates = name ? snapshot.symbols?.get(name) : undefined;
    if (!name || candidates?.length !== 1) continue;
    const symbol = candidates[0]!;
    if (!await corroboratePushSources(input.root,
      [...(symbol.sources ?? []), { path: symbol.path, sha256: symbol.sha256 }], AbortSignal.timeout(50))) continue;
    subjects.push({ kind: 'symbol', requested: name, path: symbol.path, symbolId: symbol.id, seenAt: now });
  }
  return subjects;
}

export function mergeResearchSubjects(previous: ResearchSubject[], incoming: ResearchSubject[], now = Date.now()): ResearchSubject[] {
  const merged = new Map<string, ResearchSubject>();
  for (const subject of [...previous, ...incoming]) {
    if (!Number.isFinite(subject.seenAt) || subject.seenAt > now || now - subject.seenAt >= RESEARCH_TRAIL_RETENTION_MS) continue;
    merged.set(`${subject.kind}:${subject.requested}`, subject);
  }
  return [...merged.values()].sort((a, b) => b.seenAt - a.seenAt || a.requested.localeCompare(b.requested))
    .slice(0, RESEARCH_TRAIL_LIMIT);
}

/** A capture marker distinguishes an empty trail from an unsupported/unseen client. */
export async function recordResearchBatch(input: PushInput): Promise<void> {
  if (!input.owner || !input.workspace || !input.harness || !input.calls.length) return;
  const project = (await loadHarnessRegistry(input.workspace)).projects.find(p => p.slug === input.harness);
  if (!project?.path) return;
  const snapshot = input.workspace === activeWorkspaceId() && input.harness === operatorHomeHarnessSlug()
    ? peekPushSnapshot('papercusp') : null;
  const scoped = { ...input, root: project.path };
  await persistResearchBatch(scoped, await researchSubjects(scoped, snapshot));
}

/** Shared by the real hook and isolated PG replay tests. Stable owner survives carry. */
export async function persistResearchBatch(input: PushInput, incoming: ResearchSubject[]): Promise<void> {
  const harness = input.harness;
  if (!input.owner || !input.workspace || !harness) return;
  await withWorkspace(input.workspace, async tx => {
    await tx`SELECT set_config('statement_timeout', '100ms', true)`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`research:${input.workspace}:${input.owner}:${harness}`}, 0))`;
    const rows = await tx<{ subjects: ResearchSubject[] }[]>`SELECT subjects FROM harness_shared.code_intel_research_trails
      WHERE workspace_id=${input.workspace} AND owner_id=${input.owner} AND harness_slug=${harness}`;
    // A queued capture can read a newer batch after taking the lock. Use the
    // merge-time clock so that batch is not discarded as a future timestamp.
    const subjects = mergeResearchSubjects(rows[0]?.subjects ?? [], incoming, Date.now());
    await tx`INSERT INTO harness_shared.code_intel_research_trails (workspace_id,owner_id,harness_slug,client,subjects,captured_at)
      VALUES (${input.workspace},${input.owner},${harness},${input.client ?? null},${JSON.stringify(subjects)}::jsonb,now())
      ON CONFLICT (workspace_id,owner_id,harness_slug) DO UPDATE
      SET client=EXCLUDED.client, subjects=EXCLUDED.subjects, captured_at=EXCLUDED.captured_at`;
  });
}

export async function readResearchTrail(workspace: string, owner: string, harness: string): Promise<ResearchTrail> {
  return withWorkspace(workspace, async tx => {
    const rows = await tx<{ subjects: ResearchSubject[] }[]>`SELECT subjects FROM harness_shared.code_intel_research_trails
      WHERE workspace_id=${workspace} AND owner_id=${owner} AND harness_slug=${harness}
        AND captured_at > now() - interval '7 days'`;
    if (!rows.length) return { subjects: [], reason: 'trail not captured for this client' };
    const subjects = mergeResearchSubjects(rows[0]!.subjects, []);
    return subjects.length ? { subjects } : { subjects, reason: 'nothing recorded' };
  });
}
