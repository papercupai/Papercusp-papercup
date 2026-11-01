/**
 * Cleanup triage (plan code-cleanup-campaigns-2026-10-26 P-005, R-5): turn ranked
 * clone families into merge batches.
 *
 * Only REAL duplicates become merge batches. A family qualifies when its members'
 * files historically change together (90-day first-parent co-change, the same
 * measurement the sweep attaches to filed items). Coincidental look-alikes that
 * evolve independently are excluded: merging them would create the wrong
 * abstraction. A DIVERGED family — one copy carries a statement (typically a
 * guard) the other lacks — is a likely live bug, so it gets no merge batch until a
 * bug naming both locations is terminal; merging first would silently drop or
 * spread the fix.
 *
 * File-level co-change cannot see a family whose copies share one file, and it misses
 * copies that change together inside files that otherwise change apart. When a member
 * history lookup is supplied (D-022), those families are measured again per member
 * function (90-day first-parent `git log -L`): the same floor, the same connectivity
 * rule, over members instead of files. A batched family records which basis admitted it.
 *
 * Every family that is not batched is reported with a reason. Missing evidence
 * (incomplete history, a single-file family with no member history, an unmeasured
 * member, near copies without source) is an exclusion, never a batch: triage fails closed.
 *
 * Ranking is redundant mass × churn × package distance (each churn/distance term
 * offset by one so a zero does not erase the others). A batch is one area's
 * qualifying families, at most TRIAGE_BATCH_FAMILY_CAP per batch, so each batch
 * stays one reviewable change.
 */
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import * as ts from 'typescript';
import { buildCoChangeIndex, coChangeFromIndex, type CoChangeIndex, type HistoryCommit } from '../code-intelligence/change-history';
import { cloneMemberSymbol } from '../code-intelligence/clone-index';
import { cloneFamilyArea, type RankedCloneFamily } from '../code-intelligence/clone-sweep';

const DAY = 86_400_000;
/** Minimum Jaccard co-change for two member files to count as changing together. */
export const TRIAGE_CO_CHANGE_FLOOR = 0.25;
/** Families per merge batch: one batch must stay one reviewable change. */
export const TRIAGE_BATCH_FAMILY_CAP = 5;
/** coChangeFromCommits accepts at most 50 paths. */
const MAX_FAMILY_FILES = 50;

export interface TriageMember {
  id: string; path: string; line: number; symbol: string;
  /** The member's function text. Required for near/semantic families, whose copies
   * are not identical by construction and must be compared for divergence. */
  source?: string;
  /** Last line of the member function (1-based, inclusive). Member-level co-change needs it:
   * a member without it is unmeasured there. */
  endLine?: number;
}
/** In-window first-parent commits that changed one member function; null = unmeasured. */
export type MemberCommits = ReadonlySet<string> | null;
/** Commit sets for the given members over `window`, keyed by member id (D-022). A member missing
 * from the result, or null, is unmeasured and keeps its family excluded. */
export type MemberHistoryLookup = (members: readonly TriageMember[], window: { start: string; end: string })
  => Promise<ReadonlyMap<string, MemberCommits>>;
export interface TriageFamily {
  id: string;
  /** exact/renamed families are identical modulo renames by construction; near and
   * semantic families are not, so they are checked for divergence. */
  kind: 'exact' | 'renamed' | 'near' | 'semantic';
  members: readonly TriageMember[];
  redundantMass: number;
  packageDistance: number;
  /** An intentional-copy acceptance recorded for this exact membership. */
  accepted?: boolean;
}
export interface TriageHistory {
  commits: readonly HistoryCommit[]; end: string; commit: string | null; complete: boolean;
}
export type DivergenceBug = { status: 'missing' } | { status: 'open' | 'terminal'; id: string };
/** Finds the bug filed for a diverged pair by its condition key (P-010 files it). */
export type DivergenceBugLookup = (conditionKey: string) => Promise<DivergenceBug>;

export type TriageExclusionReason = 'accepted' | 'history-incomplete' | 'single-file' | 'too-many-files'
  | 'independent' | 'not-type-1-2' | 'divergence-unmeasured';
export interface TriageExclusion { familyId: string; reason: TriageExclusionReason; detail: string }
export interface DivergedHold {
  familyId: string; conditionKey: string;
  /** The copy carrying the extra statements, then the copy lacking them. */
  locations: [TriageLocation, TriageLocation];
  extra: string[]; guard: boolean;
  bug: 'missing' | 'open'; bugId: string | null;
}
export interface TriageLocation { path: string; line: number; symbol: string; endLine?: number }
export interface TriagedFamily {
  id: string; score: number; churn: number; redundantMass: number; packageDistance: number;
  /** The weakest co-change link that still connects every member file ('file') or, when file
   * history could not connect them, every member function ('member', D-022). */
  coChange: { minLinkScore: number; files: number; basis: 'file' | 'member' };
  /** Set when the family diverged and the bug naming both copies is terminal. */
  divergenceResolvedBy?: string;
  members: readonly TriageLocation[];
}
export interface TriageBatch { area: string; index: number; score: number; redundantMass: number; families: TriagedFamily[] }
export interface TriageResult { batches: TriageBatch[]; excluded: TriageExclusion[]; diverged: DivergedHold[] }

const location = (m: TriageMember): TriageLocation => ({ path: m.path, line: m.line, symbol: m.symbol,
  ...(m.endLine !== undefined ? { endLine: m.endLine } : {}) });
const locKey = (m: TriageLocation) => `${m.path}#${m.symbol}`;

/** Condition key of the bug filed for a diverged pair: order-independent, so the
 * filer and every later triage run name the same bug. */
export function divergedCopyConditionKey(a: TriageLocation, b: TriageLocation): string {
  return `clone-diverged:${[locKey(a), locKey(b)].sort().join('|')}`;
}

// ── divergence ──────────────────────────────────────────────────────────────

/** A normalized token string: identifiers and literal values are abstracted, so
 * renamed copies compare equal and only structure decides. */
function normalize(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const out: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.Identifier || kind === ts.SyntaxKind.PrivateIdentifier) out.push('$id');
    else if (kind === ts.SyntaxKind.StringLiteral || kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) out.push('$s');
    else if (kind === ts.SyntaxKind.NumericLiteral || kind === ts.SyntaxKind.BigIntLiteral) out.push('$n');
    else out.push(scanner.getTokenText());
  }
  return out.join(' ');
}

interface FlatStatement { norm: string; text: string; guard: boolean }

/** Pre-order statements of a function body. Each statement is rendered with its
 * nested blocks cut out (and visited in turn), so a guard added inside a loop shows
 * up as one EXTRA statement instead of one changed loop. */
function flattenBody(source: string): FlatStatement[] | null {
  const file = ts.createSourceFile('member.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let body: ts.Node | undefined;
  const find = (node: ts.Node): void => {
    if (body) return;
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessor(node)
      || ts.isSetAccessor(node)) && node.body) { body = node.body; return; }
    ts.forEachChild(node, find);
  };
  find(file);
  if (!body) return null;
  const out: FlatStatement[] = [];
  const visit = (statements: readonly ts.Statement[]) => {
    for (const statement of statements) {
      const blocks: ts.Block[] = [];
      const collect = (node: ts.Node): void => {
        if (ts.isBlock(node)) { blocks.push(node); return; }
        if (ts.isFunctionLike(node)) return;
        ts.forEachChild(node, collect);
      };
      ts.forEachChild(statement, collect);
      const start = statement.getStart(file);
      let text = '', at = start;
      for (const block of blocks) { text += source.slice(at, block.getStart(file)) + '{}'; at = block.getEnd(); }
      text += source.slice(at, statement.getEnd());
      out.push({ norm: normalize(text), text: text.replace(/\s+/g, ' ').trim(), guard: ts.isIfStatement(statement) });
      for (const block of blocks) visit(block.statements);
    }
  };
  if (ts.isBlock(body)) visit(body.statements);
  else out.push({ norm: normalize(body.getText(file)), text: body.getText(file), guard: false });
  return out;
}

export type PairDivergence = { status: 'identical' }
  | { status: 'diverged'; richer: 0 | 1; extra: string[]; guard: boolean }
  | { status: 'differs' } | { status: 'unmeasured'; reason: string };

/** Compare two copies statement by statement. One copy being the other plus extra
 * statements is DIVERGED (a fix one copy lacks); any other difference means the
 * pair is not a Type-1/2 duplicate at all. */
export function compareCopies(a: string | undefined, b: string | undefined): PairDivergence {
  if (a === undefined || b === undefined) return { status: 'unmeasured', reason: 'member source not provided' };
  const x = flattenBody(a), y = flattenBody(b);
  if (!x || !y) return { status: 'unmeasured', reason: 'no function body found in member source' };
  // Longest common subsequence over normalized statements.
  const table = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) {
    table[i]![j] = x[i]!.norm === y[j]!.norm ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  }
  const common = table[0]![0]!;
  if (common === x.length && common === y.length) return { status: 'identical' };
  if (common !== Math.min(x.length, y.length)) return { status: 'differs' };
  const richer: 0 | 1 = x.length > y.length ? 0 : 1;
  const [long, short] = richer === 0 ? [x, y] : [y, x];
  const extra: FlatStatement[] = [];
  let j = 0;
  for (const statement of long) {
    if (j < short.length && statement.norm === short[j]!.norm) j++;
    else extra.push(statement);
  }
  return { status: 'diverged', richer, extra: extra.map(s => s.text), guard: extra.some(s => s.guard) };
}

// ── co-change and churn ─────────────────────────────────────────────────────

function windowCommits(history: TriageHistory): HistoryCommit[] {
  const end = Date.parse(history.end), start = end - 90 * DAY;
  return history.commits.filter(c => c.parents.length <= 1 && Date.parse(c.at) >= start && Date.parse(c.at) < end);
}

/** Distinct in-window commits touching any member file (renames count for both names). */
export function familyChurn(paths: readonly string[], history: TriageHistory): number {
  const wanted = new Set(paths);
  return new Set(windowCommits(history).filter(c => c.files.some(f => wanted.has(f.path) || (f.from && wanted.has(f.from))))
    .map(c => c.sha)).size;
}

/** The weakest link of the maximum spanning tree over `nodes`, using only links at or above
 * `floor`; null when those links do not connect every node. */
function weakestSpanningLink(nodes: readonly string[], links: readonly { a: string; b: string; score: number }[],
  floor: number): number | null {
  const parent = new Map(nodes.map(n => [n, n] as const));
  const root = (n: string): string => { while (parent.get(n) !== n) n = parent.get(n)!; return n; };
  let weakest = Infinity, joined = 1;
  for (const link of [...links].filter(l => l.score >= floor && parent.has(l.a) && parent.has(l.b)).sort((x, y) => y.score - x.score)) {
    const a = root(link.a), b = root(link.b);
    if (a === b) continue;
    parent.set(a, b); joined++; weakest = Math.min(weakest, link.score);
  }
  return joined === nodes.length ? weakest : null;
}

/** Members co-change when the files are CONNECTED by links at or above the floor:
 * every file shares a history with the rest, not just one lucky pair. Returns the
 * weakest link of the maximum spanning tree, or null when the files are not connected. */
function coChangeLink(paths: readonly string[], index: CoChangeIndex, floor: number): number | null {
  // Only in-family links matter. Unrestricted, the global top-100 cut could drop them in favour of
  // a member file's stronger outside partners and misreport the family as independent.
  const report = coChangeFromIndex(index, paths, { partners: paths, limit: paths.length * paths.length });
  return weakestSpanningLink(paths, report.pairs.map(p => ({ a: p.path, b: p.partner, score: p.score })), floor);
}

/** The same rule over member functions (D-022): Jaccard of their in-window commit sets. */
export function memberCoChangeLink(sets: readonly ReadonlySet<string>[], floor: number): number | null {
  const links: { a: string; b: string; score: number }[] = [];
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
    let shared = 0;
    for (const sha of sets[i]!) if (sets[j]!.has(sha)) shared++;
    const union = sets[i]!.size + sets[j]!.size - shared;
    links.push({ a: String(i), b: String(j), score: union ? shared / union : 0 });
  }
  return weakestSpanningLink(sets.map((_, i) => String(i)), links, floor);
}

export const triageScore = (row: { redundantMass: number; churn: number; packageDistance: number }) =>
  row.redundantMass * (1 + row.churn) * (1 + row.packageDistance);

// ── triage ──────────────────────────────────────────────────────────────────

export async function triageCloneFamilies(input: {
  families: readonly TriageFamily[];
  history: TriageHistory;
  divergenceBug: DivergenceBugLookup;
  coChangeFloor?: number;
  batchFamilyCap?: number;
  /** Member-level co-change (D-022) for families file history cannot connect. Absent, those
   * families are excluded as before. */
  memberHistory?: MemberHistoryLookup;
}): Promise<TriageResult> {
  const floor = input.coChangeFloor ?? TRIAGE_CO_CHANGE_FLOOR;
  const cap = input.batchFamilyCap ?? TRIAGE_BATCH_FAMILY_CAP;
  if (!(floor > 0 && floor <= 1)) throw new Error('Triage co-change floor must be in (0, 1]');
  if (!Number.isInteger(cap) || cap < 1) throw new Error('Triage batch cap must be a positive integer');
  if (!Number.isFinite(Date.parse(input.history.end))) throw new Error('Triage history needs a valid window end');

  const excluded: TriageExclusion[] = [];
  const diverged: DivergedHold[] = [];
  const eligible: (TriagedFamily & { area: string })[] = [];
  let coChange: CoChangeIndex | null = null;
  const exclude = (family: TriageFamily, reason: TriageExclusionReason, detail: string) =>
    excluded.push({ familyId: family.id, reason, detail });
  /** Families file history could not connect, awaiting the member-level measurement. */
  const pending: { family: TriageFamily; paths: string[]; reason: 'single-file' | 'independent'; detail: string;
    resolvedBy?: string }[] = [];
  const admit = (family: TriageFamily, paths: readonly string[], churn: number,
    coChangeEvidence: TriagedFamily['coChange'], resolvedBy: string | undefined) =>
    eligible.push({ id: family.id, area: cloneFamilyArea(family.members), churn, redundantMass: family.redundantMass,
      packageDistance: family.packageDistance, score: triageScore({ ...family, churn }),
      coChange: coChangeEvidence, members: family.members.map(location),
      ...(resolvedBy ? { divergenceResolvedBy: resolvedBy } : {}) });
  const fileUnconnected = (family: TriageFamily, paths: string[], reason: 'single-file' | 'independent', detail: string,
    resolvedBy: string | undefined) => {
    if (input.memberHistory) pending.push({ family, paths, reason, detail, ...(resolvedBy ? { resolvedBy } : {}) });
    else exclude(family, reason, detail);
  };

  for (const family of [...input.families].sort((a, b) => a.id.localeCompare(b.id))) {
    if (family.members.length < 2) continue;
    if (family.accepted) { exclude(family, 'accepted', 'an intentional-copy acceptance covers this membership'); continue; }

    // Divergence comes first: a diverged family is a bug report, whatever its history.
    let resolvedBy: string | undefined;
    if (family.kind === 'near' || family.kind === 'semantic') {
      const base = family.members[0]!;
      let verdict: { kind: 'ok' } | { kind: 'exclude'; reason: TriageExclusionReason; detail: string }
        | { kind: 'diverged'; richer: TriageMember; poorer: TriageMember; extra: string[]; guard: boolean } = { kind: 'ok' };
      for (const other of family.members.slice(1)) {
        const pair = compareCopies(base.source, other.source);
        if (pair.status === 'unmeasured') { verdict = { kind: 'exclude', reason: 'divergence-unmeasured', detail: pair.reason }; break; }
        if (pair.status === 'differs') {
          verdict = { kind: 'exclude', reason: 'not-type-1-2', detail: `${locKey(base)} and ${locKey(other)} differ beyond added statements` };
          break;
        }
        if (pair.status === 'diverged' && verdict.kind === 'ok') {
          const [richer, poorer] = pair.richer === 0 ? [base, other] : [other, base];
          verdict = { kind: 'diverged', richer, poorer, extra: pair.extra, guard: pair.guard };
        }
      }
      if (verdict.kind === 'exclude') { exclude(family, verdict.reason, verdict.detail); continue; }
      if (verdict.kind === 'diverged') {
        const locations: [TriageLocation, TriageLocation] = [location(verdict.richer), location(verdict.poorer)];
        const conditionKey = divergedCopyConditionKey(...locations);
        const bug = await input.divergenceBug(conditionKey);
        if (bug.status !== 'terminal') {
          diverged.push({ familyId: family.id, conditionKey, locations, extra: verdict.extra, guard: verdict.guard,
            bug: bug.status, bugId: bug.status === 'open' ? bug.id : null });
          continue;
        }
        resolvedBy = bug.id;
      }
    }

    if (!input.history.complete) { exclude(family, 'history-incomplete', 'change history is truncated or unavailable'); continue; }
    const paths = [...new Set(family.members.map(m => m.path))].sort();
    if (paths.length < 2) {
      fileUnconnected(family, paths, 'single-file', 'all copies are in one file; file history cannot show whether they change together', resolvedBy);
      continue;
    }
    if (paths.length > MAX_FAMILY_FILES) { exclude(family, 'too-many-files', `${paths.length} files exceeds the ${MAX_FAMILY_FILES}-file co-change scope`); continue; }
    // The window is prepared once per triage run: each family only queries it.
    coChange ??= buildCoChangeIndex({ commits: input.history.commits, end: input.history.end,
      commit: input.history.commit, complete: input.history.complete });
    const link = coChangeLink(paths, coChange, floor);
    if (link === null) {
      fileUnconnected(family, paths, 'independent', `member files are not connected by co-change >= ${floor} in the 90-day window`, resolvedBy);
      continue;
    }
    admit(family, paths, familyChurn(paths, input.history), { minLinkScore: link, files: paths.length, basis: 'file' }, resolvedBy);
  }

  // Member-level co-change (D-022): one lookup for every pending family's members.
  if (pending.length && input.memberHistory) {
    const end = input.history.end;
    const sets = await input.memberHistory(pending.flatMap(p => p.family.members),
      { start: new Date(Date.parse(end) - 90 * DAY).toISOString(), end });
    for (const { family, paths, reason, detail, resolvedBy } of pending) {
      const measured = family.members.map(m => sets.get(m.id) ?? null);
      const unmeasured = family.members.filter((_, i) => measured[i] === null);
      if (unmeasured.length) {
        exclude(family, reason, `${detail}; member history unmeasured for ${unmeasured.map(locKey).join(', ')}`);
        continue;
      }
      const memberSets = measured as ReadonlySet<string>[];
      const link = memberCoChangeLink(memberSets, floor);
      if (link === null) {
        exclude(family, reason, `${detail}; the member functions are not connected by co-change >= ${floor} either`);
        continue;
      }
      // Churn on this basis is the member functions' own: their distinct in-window commits.
      const churn = new Set(memberSets.flatMap(s => [...s])).size;
      admit(family, paths, churn, { minLinkScore: link, files: paths.length, basis: 'member' }, resolvedBy);
    }
  }
  excluded.sort((a, b) => a.familyId.localeCompare(b.familyId));

  const byArea = new Map<string, (TriagedFamily & { area: string })[]>();
  for (const row of eligible) byArea.set(row.area, [...(byArea.get(row.area) ?? []), row]);
  const batches: TriageBatch[] = [];
  for (const [area, rows] of byArea) {
    rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    for (let i = 0; i * cap < rows.length; i++) {
      const families = rows.slice(i * cap, (i + 1) * cap).map(({ area: _area, ...row }) => row);
      batches.push({ area, index: i, families, score: families.reduce((n, f) => n + f.score, 0),
        redundantMass: families.reduce((n, f) => n + f.redundantMass, 0) });
    }
  }
  batches.sort((a, b) => b.score - a.score || a.area.localeCompare(b.area) || a.index - b.index);
  return { batches, excluded, diverged };
}

// ── production adapters ─────────────────────────────────────────────────────

/** A sweep-ranked family as a triage input. Each member file is read once (via `readFile`,
 * relative to the scanned root) for the member's last line, which member-level co-change needs.
 * Semantic families are not identical by construction, so their members also carry their
 * function text for the divergence check. A member whose file cannot be read carries neither:
 * triage reports it as divergence-unmeasured or member-history-unmeasured. */
export async function triageFamilyFromRanked(row: RankedCloneFamily,
  readFile: (path: string) => Promise<string>): Promise<TriageFamily> {
  const needsSource = row.family.kind === 'semantic';
  const texts = new Map<string, string | null>();
  const members: TriageMember[] = [];
  for (const fn of row.family.members) {
    if (!texts.has(fn.path)) texts.set(fn.path, await readFile(fn.path).catch(() => null));
    const text = texts.get(fn.path);
    const source = needsSource && text != null ? text.slice(fn.start, fn.end) : undefined;
    const endLine = text == null ? undefined : text.slice(0, fn.end).split('\n').length;
    members.push({ id: fn.id, path: fn.path, line: fn.line, symbol: cloneMemberSymbol(fn), ...(source ? { source } : {}),
      ...(endLine !== undefined && endLine >= fn.line ? { endLine } : {}) });
  }
  return { id: row.family.id, kind: row.family.kind, members, redundantMass: row.redundantMass,
    packageDistance: row.packageDistance, accepted: row.accepted };
}

/** Why a sweep-ranked family was not chosen for a campaign round. */
export type RoundSelectionSkip = 'accepted' | 'derive-and-sync' | 'path-budget';
export interface RoundFamilySelection {
  chosen: RankedCloneFamily[];
  memberPaths: string[];
  skipped: Record<RoundSelectionSkip, number>;
}

/** The families one campaign round triages: in ranked order, consolidation candidates only,
 * while their member files fit `pathLimit` (a bound on triage cost; coverage is bounded after
 * triage by `boundCoveragePaths`, since only surviving families need it).
 * An accepted family is an intentional copy. A derive-and-sync family has a vendored member
 * (templates/, template-kit/, env-sidecars/) that a sync script derives from one canonical
 * source: its fix is that derivation, never an extraction, and a round that took it would
 * spend the path budget on files no batch may edit. */
export function selectRoundFamilies(ranked: readonly RankedCloneFamily[], pathLimit: number): RoundFamilySelection {
  if (!Number.isInteger(pathLimit) || pathLimit < 1) throw new Error('Round path limit must be a positive integer');
  const chosen: RankedCloneFamily[] = [];
  const paths = new Set<string>();
  const skipped: Record<RoundSelectionSkip, number> = { accepted: 0, 'derive-and-sync': 0, 'path-budget': 0 };
  for (const row of ranked) {
    if (row.accepted) { skipped.accepted++; continue; }
    if (row.disposition === 'derive-and-sync') { skipped['derive-and-sync']++; continue; }
    const own = row.family.members.map(m => m.path);
    if (new Set([...paths, ...own]).size > pathLimit) { skipped['path-budget']++; continue; }
    chosen.push(row);
    for (const path of own) paths.add(path);
  }
  return { chosen, memberPaths: [...paths].sort(), skipped };
}

/** The member paths a round reads coverage for, and the eligible families that did not fit.
 * Only families that survive triage reach the aggressiveness selection, so only their members
 * need coverage. Families are taken in batch order (highest score first, then each batch's own
 * order) while their files fit `pathLimit` (readTestCoverage answers for at most 50 paths). A
 * family left out is dropped from the round rather than read as uncovered. */
export function boundCoveragePaths(batches: readonly TriageBatch[], pathLimit: number): { paths: string[]; dropped: string[] } {
  if (!Number.isInteger(pathLimit) || pathLimit < 1) throw new Error('Coverage path limit must be a positive integer');
  const paths = new Set<string>();
  const dropped: string[] = [];
  for (const batch of batches) for (const family of batch.families) {
    const own = family.members.map(m => m.path);
    if (new Set([...paths, ...own]).size > pathLimit) { dropped.push(family.id); continue; }
    for (const path of own) paths.add(path);
  }
  return { paths: [...paths].sort(), dropped };
}

// Promisified lazily on first call, never at module scope (EI-10161): an eager
// promisify(execFile) throws at import time under a narrow node:child_process test mock.
let cachedExecGit: typeof execFile.__promisify__ | undefined;
const execGit = ((...args: Parameters<typeof execFile.__promisify__>) =>
  (cachedExecGit ??= promisify(execFile))(...args)) as typeof execFile.__promisify__;
/** Concurrent `git log -L` reads; each walks the window's first-parent history. */
const MEMBER_HISTORY_CONCURRENCY = 8;

/**
 * Production member history (D-022): for each member, the first-parent commits in the window
 * that changed its line range, read with `git log -L` in the repository that holds the file (a
 * member under a submodule is read in the submodule, whose commits are its own). Line ranges are
 * the working tree's, so a file that differs from HEAD is unmeasured rather than misread; so is a
 * member with no last line, a path outside `root`, and any git failure. Results are cached per
 * range, so a second triage over the same members runs no git.
 */
export function nativeMemberHistory(root: string): MemberHistoryLookup {
  const base = resolve(root);
  const toplevels = new Map<string, Promise<string | null>>();
  const clean = new Map<string, Promise<boolean>>();
  const ranges = new Map<string, Promise<MemberCommits>>();
  const toplevel = (dir: string) => {
    if (!toplevels.has(dir)) toplevels.set(dir, execGit('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeout: 30_000 })
      .then(r => r.stdout.trim() || null, () => null));
    return toplevels.get(dir)!;
  };
  const isClean = (top: string, rel: string) => {
    const key = `${top}\0${rel}`;
    // `diff --quiet` exits 1 on a difference; any failure also reads as not clean.
    if (!clean.has(key)) clean.set(key, execGit('git', ['-C', top, 'diff', '--quiet', 'HEAD', '--', rel], { timeout: 30_000 })
      .then(() => true, () => false));
    return clean.get(key)!;
  };
  const read = async (m: TriageMember, window: { start: string; end: string }): Promise<MemberCommits> => {
    if (m.endLine === undefined || !Number.isInteger(m.line) || !Number.isInteger(m.endLine) || m.line < 1
      || m.endLine < m.line || isAbsolute(m.path)) return null;
    const abs = resolve(base, m.path);
    const inRoot = relative(base, abs);
    if (!inRoot || inRoot.startsWith('..') || isAbsolute(inRoot)) return null;
    // git reports a resolved toplevel, so the path it is relative to must be resolved too.
    const real = await realpath(abs).catch(() => null);
    if (!real) return null;
    const top = await toplevel(dirname(real));
    if (!top) return null;
    const rel = relative(top, real);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !(await isClean(top, rel))) return null;
    try {
      const { stdout } = await execGit('git', ['-C', top, 'log', '--first-parent', `--since=${window.start}`,
        `--until=${window.end}`, '--format=%H', '-s', `-L${m.line},${m.endLine}:${rel}`],
      { timeout: 60_000, maxBuffer: 16 << 20 });
      return new Set(stdout.split('\n').filter(l => /^[0-9a-f]{40}$/.test(l)));
    } catch { return null; }
  };
  return async (members, window) => {
    const keyOf = (m: TriageMember) => `${m.path}:${m.line}:${m.endLine ?? ''}:${window.start}:${window.end}`;
    const queue = [...new Map(members.map(m => [keyOf(m), m] as const)).entries()].filter(([key]) => !ranges.has(key));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(MEMBER_HISTORY_CONCURRENCY, queue.length) }, async () => {
      while (next < queue.length) {
        const [key, m] = queue[next++]!;
        const pending = read(m, window);
        ranges.set(key, pending);
        await pending;
      }
    }));
    const out = new Map<string, MemberCommits>();
    for (const m of members) out.set(m.id, await ranges.get(keyOf(m))!);
    return out;
  };
}

/** Production lookup: the issue-family row holding the diverged pair's condition key
 * in this harness. Terminal means any terminal state; a lookup failure throws, so a
 * triage run never reads a database error as "no bug, safe to merge". */
export function nativeDivergenceBugLookup(scope: { workspaceId: string; harness: string }): DivergenceBugLookup {
  return async (conditionKey) => {
    const [{ getOrgPg }, { ANY_FAMILY_TERMINAL_STATES }] = await Promise.all([
      import('@papercusp/db-org'), import('../work-item-dispatch-states')]);
    const rows = await getOrgPg().sql<{ feature_id: string; status: string }[]>`
      SELECT feature_id, status FROM harness_shared.work_items
       WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harness}
         AND condition_key = ${conditionKey}
       ORDER BY created_ts DESC LIMIT 1`;
    const row = rows[0];
    if (!row) return { status: 'missing' };
    return { status: ANY_FAMILY_TERMINAL_STATES.includes(row.status) ? 'terminal' : 'open', id: row.feature_id };
  };
}
