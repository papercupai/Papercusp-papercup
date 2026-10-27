import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CloneFamily, CloneIndex } from './clone-index';
import { adoptConditionIncumbent, upsertConditionWorkItem, withConditionReplayLock } from '../coord/condition-upsert';
import { activeWorkspaceId } from '../workspace-registry';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { cloneBlobSha, cloneMemberSymbol } from './clone-index';
import { extractSemanticFunctions } from './semantic-code';
import { isVerifiedSemanticPair, semanticDigest, type SemanticJudgment, type SemanticPair } from './semantic-code-judge';

const reviewedFamily = z.object({ familyId: z.string().min(1), membersDigest: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(1) }).strict();
export const cloneSweepInputSchema = z.object({
  root: z.string().min(1),
  acceptances: z.array(reviewedFamily.extend({ expiresAt: z.string().datetime({ offset: true }) })).max(10000).default([]),
  // Cross-package distance is not proof of domain independence. This review is
  // bound to the exact membership, just like an intentional-copy acceptance.
  genericEvidence: z.array(reviewedFamily).max(10000).default([]),
  // Opt-in off-hook leg. The existing managed task owns its time/memory budget.
  semantic: z.object({ model: z.string().trim().min(1), maxPairs: z.number().int().min(1).max(100).default(20),
    maxFiles: z.number().int().min(1).max(10000).default(1000) }).strict().optional(),
}).strict();
export type CloneSweepInput = z.infer<typeof cloneSweepInputSchema>;
export interface RankedCloneFamily {
  family: Omit<CloneFamily, 'kind'> & { kind: CloneFamily['kind'] | 'semantic' };
  semantic?: { pair: SemanticPair; judgment: SemanticJudgment };
  membersDigest: string;
  redundantMass: number;
  copies: number;
  packageDistance: number;
  disposition: 'consolidate' | 'derive-and-sync';
  generic: boolean;
  accepted: boolean;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const packageOf = (path: string) => path.split('/').slice(0, path.startsWith('libs/generic/') ? 3 : 2).join('/');
const distance = (a: string, b: string) => {
  const x = a.split('/'), y = b.split('/');
  let common = 0;
  while (common < x.length && common < y.length && x[common] === y[common]) common++;
  return x.length + y.length - 2 * common;
};

/** One normalized bucket also represents its exact Type-1 subfamilies. Including
 * them again would file the same copies twice. Tests/retired code are excluded;
 * vendor copies remain visible so they can receive a derive-and-sync disposition.
 */
export function rankCloneSweep(index: CloneIndex, input: Pick<CloneSweepInput, 'acceptances' | 'genericEvidence'>,
  now = new Date()): RankedCloneFamily[] {
  const versionPrefix = index.version.replace(/:revision-\d+$/, '');
  const version = versionPrefix.slice(0, versionPrefix.lastIndexOf(':floor-'));
  const buckets = new Map<string, CloneFamily['members'][number][]>();
  for (const file of index.getFiles()) for (const fn of file.functions) {
    if (fn.classification.test || fn.classification.retired) continue;
    const group = buckets.get(fn.renamed) ?? [];
    group.push(fn); buckets.set(fn.renamed, group);
  }
  const ranked: RankedCloneFamily[] = [];
  for (const [fingerprint, group] of buckets) {
    if (group.length < 2) continue;
    const members = group.sort((a, b) => a.id.localeCompare(b.id));
    const family: CloneFamily = { id: `${versionPrefix}:renamed:${fingerprint}`, version,
      kind: 'renamed', fingerprint, members };
    // Blob identity prevents a source edit from silently retaining acceptance.
    const membersDigest = digest(members.map(({ id, blobSha }) => ({ id, blobSha })));
    const packages = [...new Set(members.map(member => packageOf(member.path)))];
    const accepted = input.acceptances.some(a => a.familyId === family.id && a.membersDigest === membersDigest
      && a.reason.trim() && Date.parse(a.expiresAt) > now.getTime());
    const reviewedGeneric = input.genericEvidence.some(a => a.familyId === family.id && a.membersDigest === membersDigest
      && a.reason.trim());
    ranked.push({ family, membersDigest, copies: members.length,
      redundantMass: members.reduce((sum, fn) => sum + fn.mass, 0) - Math.max(...members.map(fn => fn.mass)),
      packageDistance: Math.max(...packages.flatMap(a => packages.map(b => distance(a, b)))),
      disposition: members.some(fn => fn.classification.vendored) ? 'derive-and-sync' : 'consolidate',
      generic: packages.length > 1 && (reviewedGeneric || members.every(fn => fn.path.startsWith('libs/generic/'))),
      accepted: !!accepted });
  }
  return ranked.sort((a, b) => b.redundantMass - a.redundantMass || b.copies - a.copies
    || b.packageDistance - a.packageDistance || a.family.id.localeCompare(b.family.id));
}

export const cloneFamilyConditionKey = (family: Pick<CloneFamily, 'id'>) => `clone-family:${family.id}`;

/** Promote verified pairs into the SAME filing population. Do not infer a
 * transitive family: A~B and B~C do not establish A~C's contract. */
export function rankSemanticSweep(index: CloneIndex, candidates: readonly {
  pair: SemanticPair; judgment: SemanticJudgment;
}[], input: Pick<CloneSweepInput, 'acceptances' | 'genericEvidence'>, now = new Date()): RankedCloneFamily[] {
  const functions = new Map(index.getFiles().flatMap(file => file.functions.map(fn => [fn.id, fn] as const)));
  const structuralPairs = new Set(rankCloneSweep(index, input, now).flatMap(row => row.family.members.flatMap(a =>
    row.family.members.filter(b => a.id < b.id).map(b => semanticDigest([a.id, b.id])))));
  const rows = new Map<string, RankedCloneFamily>();
  for (const candidate of candidates) {
    if (!isVerifiedSemanticPair(candidate.pair, candidate.judgment)) continue;
    const members = candidate.pair.map(fn => functions.get(fn.id));
    if (members.some((fn, n) => !fn || fn.blobSha !== candidate.pair[n].blobSha || Object.values(fn.classification).some(Boolean))) continue;
    const sorted = members.map(fn => fn!).sort((a, b) => a.id.localeCompare(b.id));
    if (structuralPairs.has(semanticDigest(sorted.map(fn => fn.id)))) continue;
    const fingerprint = semanticDigest(sorted.map(fn => ({ id: fn.id, blobSha: fn.blobSha })));
    const id = `semantic-code-v1:semantic:${fingerprint}`;
    const membersDigest = digest(sorted.map(({ id, blobSha }) => ({ id, blobSha })));
    rows.set(id, { family: { id, version: 'semantic-code-v1', kind: 'semantic', fingerprint, members: sorted },
      membersDigest, semantic: candidate, redundantMass: Math.min(...sorted.map(fn => fn.mass)), copies: 2,
      packageDistance: distance(packageOf(sorted[0].path), packageOf(sorted[1].path)), disposition: 'consolidate', generic: false,
      accepted: input.acceptances.some(a => a.familyId === id && a.membersDigest === membersDigest && a.reason.trim()
        && Date.parse(a.expiresAt) > now.getTime()) });
  }
  return [...rows.values()].sort((a, b) => b.redundantMass - a.redundantMass || a.family.id.localeCompare(b.family.id));
}

async function semanticSourcesCurrent(root: string | undefined, row: RankedCloneFamily) {
  if (!root || !row.semantic || !isVerifiedSemanticPair(row.semantic.pair, row.semantic.judgment)) return false;
  const identities = row.family.members.map(({ id, blobSha }) => ({ id, blobSha })).sort((a,b) => a.id.localeCompare(b.id));
  const pairIdentities = row.semantic.pair.map(({ id, blobSha }) => ({ id, blobSha })).sort((a,b) => a.id.localeCompare(b.id));
  const fingerprint = semanticDigest(identities);
  if (semanticDigest(pairIdentities) !== fingerprint || row.membersDigest !== fingerprint
    || row.family.fingerprint !== fingerprint || row.family.id !== `semantic-code-v1:semantic:${fingerprint}`) return false;
  const canonical = await realpath(root);
  for (const fn of row.family.members) {
    if (isAbsolute(fn.path)) return false;
    const absolute = await realpath(join(canonical, fn.path)), rel = relative(canonical, absolute);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return false;
    const source = await readFile(absolute, 'utf8');
    if (cloneBlobSha(source) !== fn.blobSha) return false;
    const actual = extractSemanticFunctions({ path: fn.path, source }).find(row => row.id === fn.id);
    const judged = row.semantic.pair.find(row => row.id === fn.id);
    // Behavioral summary is generated off-hook; source identity, signature and
    // normalized body are independently derived from the current blob.
    if (!actual || !judged || !judged.summary.startsWith(actual.summary)
      || semanticDigest({ ...actual, summary: '' }) !== semanticDigest({ ...judged, summary: '' })) return false;
  }
  return true;
}

/** At most this many area items are filed (created or refreshed) per sweep run.
 * The rest wait: an area's families resurface on a later run once higher-ranked
 * areas are fixed or accept-listed (code-cleanup-campaigns-2026-10-26 R-2). */
export const CLONE_SWEEP_AREA_CAP = 20;
const AREA_MAX_SEGMENTS = 4;

/** Where a shared extraction of this family would live: the deepest directory all
 * members share (at most four segments). Members that share no package-level
 * directory get the sorted set of their packages instead of a meaningless root. */
export function cloneFamilyArea(members: readonly Pick<CloneFamily['members'][number], 'path'>[]): string {
  const dirs = members.map(fn => fn.path.split('/').slice(0, -1));
  let common = dirs[0] ?? [];
  for (const dir of dirs.slice(1)) {
    let n = 0;
    while (n < common.length && n < dir.length && common[n] === dir[n]) n++;
    common = common.slice(0, n);
  }
  const packageDepth = members[0] && members[0].path.startsWith('libs/generic/') ? 3 : 2;
  if (common.length >= Math.min(packageDepth, Math.max(...dirs.map(d => d.length)))) {
    return common.slice(0, AREA_MAX_SEGMENTS).join('/') || '.';
  }
  return [...new Set(members.map(fn => packageOf(fn.path)))].sort().join(' + ');
}
export const cloneAreaConditionKey = (area: string) => `clone-area:${area}`;

export type MemberCoverage = { status: 'covered'; tests: number } | { status: 'uncovered' }
  | { status: 'unknown'; reason: string };
export type FamilyCoChange = { status: 'measured'; score: number; shared: number; union: number }
  | { status: 'unknown'; reason: string };
/** Evidence the filed item carries so a reader can judge safety (coverage) and
 * whether the copies are one concept (co-change). Absent evidence is stated as
 * `unknown` with a reason, never omitted. */
export interface CloneFilingSignals {
  coverage(members: readonly CloneFamily['members'][number][]): Promise<ReadonlyMap<string, MemberCoverage>>;
  coChange(paths: readonly string[]): Promise<FamilyCoChange>;
}
/** Production signals for the nightly runner: the source-bound test-coverage map
 * (P016) and 90-day first-parent co-change (P013). Every failure degrades to an
 * `unknown` with its reason — a sweep never fails, or claims coverage, on missing data. */
export function nativeCloneFilingSignals(input: { root: string; workspaceId: string; harness: string }): CloneFilingSignals {
  return {
    async coverage(members) {
      const unknown = (reason: string) => new Map<string, MemberCoverage>(members.map(fn => [fn.id, { status: 'unknown', reason }]));
      try {
        const [{ getOrgPg }, { readTestCoverage }, { coverageHash }, { queryTestCoverage }] = await Promise.all([
          import('@papercusp/db-org'), import('@papercusp/test-config/test-coverage-store'),
          import('@papercusp/test-config/test-coverage-map'), import('./test-coverage-map')]);
        const paths = [...new Set(members.map(fn => fn.path))];
        const snapshots = await readTestCoverage(getOrgPg().sql, input.workspaceId, input.harness, input.root, paths);
        if (!snapshots.length) return unknown('no coverage map recorded for these files');
        const all = [...new Set([...paths, ...snapshots.flatMap(s => [s.testFile, ...s.sources.map(f => f.path),
          ...s.population.map(f => f.path)])])];
        if (all.length > 400) return unknown('coverage scope too large to verify');
        const bytes = new Map<string, Buffer>();
        for (const path of all) { try { bytes.set(path, await readFile(join(input.root, path))); } catch { /* deleted test: hash mismatch below */ } }
        const hashes = new Map([...bytes].map(([path, data]) => [path, coverageHash(data)] as const));
        return new Map(members.map(fn => {
          const text = bytes.get(fn.path)?.toString('utf8');
          const endLine1 = text ? text.slice(0, fn.end).split('\n').length : fn.line;
          const answer = queryTestCoverage({ root: input.root, question: { path: fn.path, line1: fn.line, endLine1 },
            snapshots, currentHashes: hashes, currentPopulation: null });
          const verdict: MemberCoverage = answer.basis === 'execution' && answer.tests.length
            ? { status: 'covered', tests: answer.tests.length }
            : answer.noTestExecutes === true ? { status: 'uncovered' } : { status: 'unknown', reason: answer.reason };
          return [fn.id, verdict] as const;
        }));
      } catch (error) { return unknown(error instanceof Error ? error.message : 'coverage unavailable'); }
    },
    async coChange(paths) {
      if (paths.length < 2) return { status: 'unknown', reason: 'all copies are in one file' };
      try {
        const { readCoChange } = await import('./change-history');
        const report = await readCoChange(input.root, paths.slice(0, 50));
        if (report.status !== 'measured' || !report.complete) return { status: 'unknown', reason: report.error ?? 'history incomplete' };
        const inFamily = new Set(paths);
        const best = report.pairs.filter(p => inFamily.has(p.path) && inFamily.has(p.partner))
          .sort((a, b) => b.score - a.score)[0];
        return best ? { status: 'measured', score: best.score, shared: best.shared, union: best.union }
          : { status: 'measured', score: 0, shared: 0, union: 0 };
      } catch (error) { return { status: 'unknown', reason: error instanceof Error ? error.message : 'history unavailable' }; }
    },
  };
}
const unwiredSignals: CloneFilingSignals = {
  coverage: async members => new Map(members.map(fn => [fn.id, { status: 'unknown', reason: 'coverage map not consulted' }])),
  coChange: async () => ({ status: 'unknown', reason: 'change history not consulted' }),
};
const coverageText = (c: MemberCoverage | undefined) => !c ? 'coverage unknown (not measured)'
  : c.status === 'covered' ? `covered by ${c.tests} test file${c.tests === 1 ? '' : 's'}`
    : c.status === 'uncovered' ? 'no test executes it' : `coverage unknown (${c.reason})`;
const coChangeText = (c: FamilyCoChange) => c.status === 'measured'
  ? `co-change ${c.score.toFixed(2)} (changed together in ${c.shared} of ${c.union} commits touching them)`
  : `co-change unknown (${c.reason})`;

/** Terminal authority recorded when a clean re-scan resolves a filed cleanup area. */
export const CLONE_SWEEP_CLOSE_ACTOR = 'system:clone-sweep';

/**
 * Close every open cleanup clone-area item in this harness whose area the re-scan
 * no longer reports. An area with a stored member under an unscanned path stays
 * open: an unparsed file is not evidence the finding is gone. Uses the system
 * state write (terminal authority + reason naming the fire), not the agent
 * completion tool, so no change-kind proof is demanded of a system close.
 */
export async function closeResolvedCloneAreas(scope: { workspaceId: string; harness: string; fireId: string },
  reportedAreas: ReadonlySet<string>, unscanned: readonly string[] = []): Promise<string[]> {
  const [{ getOrgPg }, { setWorkItemState }, { ANY_FAMILY_TERMINAL_STATES }] = await Promise.all([
    import('@papercusp/db-org'), import('../work-items'), import('../work-item-dispatch-states')]);
  const open = await getOrgPg().sql<{ feature_id: string; clone_area: { area?: string; families?: { members?: { path?: string }[] }[] } | null }[]>`
    SELECT feature_id, payload -> 'cloneArea' AS clone_area FROM harness_shared.work_items
     WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harness}
       AND COALESCE(item_kind, kind) = 'cleanup' AND payload ? 'cloneArea'
       AND NOT (status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
     ORDER BY feature_id`;
  const skip = new Set(unscanned), closed: string[] = [];
  for (const row of open) {
    const area = row.clone_area?.area;
    if (!area || reportedAreas.has(area)) continue;
    if ((row.clone_area?.families ?? []).some(f => (f.members ?? []).some(m => m.path && skip.has(m.path)))) continue;
    await setWorkItemState(row.feature_id, 'done', { harness: scope.harness, by: CLONE_SWEEP_CLOSE_ACTOR,
      completionRef: `clone sweep fire ${scope.fireId}: re-scan reports none of this area's findings` });
    closed.push(row.feature_id);
  }
  return closed;
}

type FiledRow = { familyId: string; itemId: string | null; area?: string;
  disposition: 'accepted' | 'created' | 'reused' | 'unverified' | 'deferred' };

/** Families are grouped by extraction area; one work-item per area, keyed by the
 * area so re-runs refresh rather than refile. Lookup + mint is serialized using
 * the existing condition replay mutex, and the persisted marker outlives closure,
 * so a restart never creates a second item for the same area. */
export async function fileCloneSweep(families: readonly RankedCloneFamily[], scope: {
  workspaceId: string; harness: string; fireId: string; root?: string;
}, options: { cap?: number; signals?: CloneFilingSignals; closeResolved?: { unscanned?: readonly string[] } } = {}) {
  if (!scope.workspaceId.trim() || !scope.harness.trim() || !scope.fireId.trim()) throw new Error('Clone sweep scope required');
  // Issue-family creates use the established ambient workspace. The standalone
  // managed runner pins it; refuse a misbound caller before minting any row.
  if (activeWorkspaceId() !== scope.workspaceId) throw new Error('Clone sweep ambient workspace mismatch');
  const cap = options.cap ?? CLONE_SWEEP_AREA_CAP, signals = options.signals ?? unwiredSignals;
  if (!Number.isInteger(cap) || cap < 1) throw new Error('Clone sweep cap must be a positive integer');
  const rows: FiledRow[] = [];
  const areas = new Map<string, RankedCloneFamily[]>();
  for (const row of families) {
    if (row.family.kind === 'semantic') {
      let current = false;
      try { current = await semanticSourcesCurrent(scope.root, row); } catch { /* Missing source is unverified, never fileable. */ }
      if (!current) { rows.push({ familyId: row.family.id, itemId: null, disposition: 'unverified' }); continue; }
    }
    if (row.accepted) { rows.push({ familyId: row.family.id, itemId: null, disposition: 'accepted' }); continue; }
    const area = cloneFamilyArea(row.family.members);
    areas.set(area, [...(areas.get(area) ?? []), row]);
  }
  const mass = (group: readonly RankedCloneFamily[]) => group.reduce((n, row) => n + row.redundantMass, 0);
  const ranked = [...areas].sort(([a, x], [b, y]) => mass(y) - mass(x) || y.length - x.length || a.localeCompare(b));
  for (const [n, [area, group]] of ranked.entries()) {
    if (n >= cap) { for (const row of group) rows.push({ familyId: row.family.id, itemId: null, area, disposition: 'deferred' }); continue; }
    const key = cloneAreaConditionKey(area);
    const detail = [];
    for (const row of group) {
      const coverage = await signals.coverage(row.family.members);
      const coChange = await signals.coChange([...new Set(row.family.members.map(fn => fn.path))]);
      detail.push({ row, coverage, coChange });
    }
    const total = mass(group);
    const title = `Clone area: ${area} — ${group.length} famil${group.length === 1 ? 'y' : 'ies'}, ${total} redundant AST nodes`;
    const summary = [`${group.length} clone famil${group.length === 1 ? 'y' : 'ies'} whose shared extraction would live in ${area}.`,
      ...detail.flatMap(({ row, coverage, coChange }) => [
        `\n${row.disposition} ${row.copies} copies (${row.redundantMass} redundant AST nodes; package distance ${row.packageDistance}); ${coChangeText(coChange)}`,
        `family ${row.family.id}; membership ${row.membersDigest}`,
        ...(row.generic ? ['Domain-free cross-package candidate: consolidate in libs/generic (review-bound evidence).'] : []),
        ...row.family.members.map(fn => `- ${fn.path}:${fn.line} ${cloneMemberSymbol(fn)} — ${coverageText(coverage.get(fn.id))}`)])].join('\n');
    const payload = { cloneArea: { area, fireId: scope.fireId, redundantMass: total,
      families: detail.map(({ row, coverage, coChange }) => ({ id: row.family.id, membersDigest: row.membersDigest,
        disposition: row.disposition, generic: row.generic, coChange,
        rank: { redundantMass: row.redundantMass, copies: row.copies, packageDistance: row.packageDistance },
        members: row.family.members.map(fn => ({ id: fn.id, path: fn.path, line: fn.line, symbol: cloneMemberSymbol(fn),
          coverage: coverage.get(fn.id) ?? { status: 'unknown', reason: 'not measured' } })),
        ...(row.semantic ? { semantic: row.semantic } : {}) })) },
      tags: ['clone-area', ...new Set(group.map(row => row.disposition)), ...(group.some(row => row.generic) ? ['libs/generic'] : [])] };
    const result = await withConditionReplayLock(scope.workspaceId, key, async () => {
      for (const row of group) {
        if (row.family.kind === 'semantic' && !await semanticSourcesCurrent(scope.root, row)) return { id: null, created: false, unverified: true };
      }
      // A row this sweep auto-closed on a clean re-scan is not a disposition: when the
      // area is reported again it is re-filed rather than left closed (R-3).
      const incumbent = await adoptConditionIncumbent(key, { title, summary, workspaceId: scope.workspaceId,
        includeTerminal: true, skipTerminalOwners: [CLONE_SWEEP_CLOSE_ACTOR] });
      if (incumbent) return { id: incumbent, created: false };
      return upsertConditionWorkItem(key, { kind: 'cleanup', title, summary, harness: scope.harness,
        workspaceId: scope.workspaceId, createdBy: 'system:clone-family-sweep', payload });
    });
    if ('unverified' in result) {
      for (const row of group) rows.push({ familyId: row.family.id, itemId: null, area, disposition: 'unverified' });
      continue;
    }
    if ('duplicateLeftOpen' in result && result.duplicateLeftOpen) {
      throw new Error(`Clone area duplicate remains open: ${result.duplicateLeftOpen}`);
    }
    if (!result.id) throw new Error(`Clone area filing returned no identity: ${area}`);
    for (const row of group) rows.push({ familyId: row.family.id, itemId: result.id, area, disposition: result.created ? 'created' : 'reused' });
  }
  // R-3: a re-scan that no longer reports an area resolves its cleanup item. Every
  // non-accepted family counts as reported, so deferred and unverified areas stay open.
  const resolved = options.closeResolved
    ? await closeResolvedCloneAreas(scope, new Set(families.filter(row => !row.accepted)
      .map(row => cloneFamilyArea(row.family.members))), options.closeResolved.unscanned ?? [])
    : [];
  const items = new Set(rows.filter(row => row.disposition === 'created').map(row => row.itemId));
  return { families: families.length, created: items.size, resolved,
    filedAreas: Math.min(cap, ranked.length), deferredAreas: Math.max(0, ranked.length - cap),
    accepted: rows.filter(row => row.disposition === 'accepted').length, rows };
}
