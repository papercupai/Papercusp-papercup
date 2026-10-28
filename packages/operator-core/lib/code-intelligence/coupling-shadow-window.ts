/**
 * R-12 shadow-window instrument — code-intel-delivery-and-outcomes-2026-10-26 P-012
 * (D-006, D-008, D-009, D-013, D-014, D-020, D-029).
 *
 * Code-dependency coupling edges (P-011) run in SHADOW: `logCodeDependencyShadow`
 * (agent-tools/coordination/coupling-sources.ts) writes would-be edges and non-edge
 * outcomes to audit_log. This instrument scores the bounded real-fleet window over
 * those rows and records an enable / keep-shadow disposition. Nothing here surfaces
 * an edge; enabling stays a separate, recorded decision.
 *
 * The check fingerprint (D-013, widened by D-020) is a hash of the normalized source
 * of the exported `derive*` functions in coord/coupling-derivation.ts plus every
 * same-file declaration they reach transitively, printed without comments. A comment
 * or whitespace edit leaves it unchanged; a change to any reached helper changes it.
 * The writer stamps the fingerprint of the code it actually loaded on every row, so a
 * window is the rows of exactly one fingerprint and can never span two.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';

export const COUPLING_SHADOW_WINDOW_INSTRUMENT_KEY = 'code-intel:coupling-shadow-window';
/** Written by logCodeDependencyShadow; mirrored here to keep this module import-light. */
export const COUPLING_SHADOW_ROW_ACTION = 'coord.coupling.code-dependency.shadow';
/** One row per scoring run and window fingerprint: the window state and disposition. */
export const COUPLING_SHADOW_WINDOW_ACTION = 'coord.coupling.code-dependency.window';
/** A relevance judgment of one shadow edge: details { edgeKey, relevant, judgeOwnerId }. */
export const COUPLING_EDGE_JUDGMENT_ACTION = 'coord.coupling.code-dependency.judgment';
export const COUPLING_SHADOW_SUBJECT_PLAN = 'code-intel-delivery-and-outcomes-2026-10-26';
/**
 * The serving plane whose shadow rows the window counts (plan D-036): this workspace's
 * deployed operator. The writer stamps `servingHost` from serving-host-identity, so the
 * value is that module's `port-<n>` label. Staging (:3170) serves the same workspace from a
 * different build, so its rows can carry a different derivation fingerprint on the same
 * clock; counting both alternates the fingerprint and inflates restarts. Rows with no plane
 * stamp are excluded too, so the window opens once the stamping build reaches :3070 (D-029).
 * The instrument runs on bg-host, so it cannot use its own serving identity here.
 */
export const SHADOW_WINDOW_PLANE = 'port-3070';

const DAY_MS = 86_400_000;
export const SHADOW_WINDOW_BOUNDS = Object.freeze({
  minDays: 7,
  maxDays: 28,
  minSample: 30,
  minLiveAgents: 3,
  minLineages: 3,
  precision: 0.6,
  recall: 0.5,
  tokenMeanChars: 500,
  restartCap: 3,
  reviewByDays: 14,
  deadMinEligible: 30,
  deadMinLineages: 3,
  deadUnknownShare: 0.5,
});

// ── Fingerprint ────────────────────────────────────────────────────────────────

type TsApi = typeof import('typescript');
type TsNode = import('typescript').Node;

export interface DerivationFingerprint {
  fingerprint: string;
  /** Exported `derive*` functions the walk started from. */
  roots: string[];
  /** Every declaration the fingerprint covers, sorted. */
  covered: string[];
}

function isExported(tsApi: TsApi, node: TsNode): boolean {
  const mods = tsApi.canHaveModifiers(node) ? tsApi.getModifiers(node) : undefined;
  return Boolean(mods?.some(m => m.kind === tsApi.SyntaxKind.ExportKeyword));
}

/** Pure: the D-013/D-020 fingerprint of one coupling-derivation source text. */
export function derivationFingerprint(tsApi: TsApi, source: string, fileName = 'coupling-derivation.ts'): DerivationFingerprint {
  const sf = tsApi.createSourceFile(fileName, source, tsApi.ScriptTarget.Latest, true, tsApi.ScriptKind.TS);
  const decls = new Map<string, TsNode[]>();
  const roots: string[] = [];
  const add = (name: string, node: TsNode) => {
    const list = decls.get(name) ?? [];
    if (!list.includes(node)) list.push(node);
    decls.set(name, list);
  };
  for (const st of sf.statements) {
    if (tsApi.isFunctionDeclaration(st) && st.name) {
      add(st.name.text, st);
      if (isExported(tsApi, st) && /^derive/.test(st.name.text) && !roots.includes(st.name.text)) roots.push(st.name.text);
    } else if (tsApi.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (tsApi.isIdentifier(d.name)) add(d.name.text, st);
    }
  }
  const covered = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.shift() as string;
    if (covered.has(name)) continue;
    covered.add(name);
    const visit = (node: TsNode): void => {
      if (tsApi.isIdentifier(node)) {
        const parent = node.parent;
        const isMemberName = parent && ((tsApi.isPropertyAccessExpression(parent) && parent.name === node)
          || (tsApi.isPropertyAssignment(parent) && parent.name === node));
        if (!isMemberName && decls.has(node.text) && !covered.has(node.text)) queue.push(node.text);
      }
      tsApi.forEachChild(node, visit);
    };
    for (const node of decls.get(name) ?? []) visit(node);
  }
  // Hash the leaf-token stream, not printer output: the printer keeps a block's
  // original single-/multi-line layout, so a whitespace-only edit changed the hash.
  // Tokens carry no trivia (comments, whitespace); JSDoc nodes are skipped.
  const tokensOf = (node: TsNode, out: string[]): string[] => {
    if (node.kind >= tsApi.SyntaxKind.FirstJSDocNode && node.kind <= tsApi.SyntaxKind.LastJSDocNode) return out;
    const kids = node.getChildren(sf);
    if (!kids.length) out.push(node.getText(sf));
    for (const k of kids) tokensOf(k, out);
    return out;
  };
  const sorted = [...covered].sort();
  const printed = new Set<TsNode>();
  const hash = createHash('sha256');
  for (const name of sorted) {
    for (const node of decls.get(name) ?? []) {
      if (printed.has(node)) continue;
      printed.add(node);
      hash.update(`${name}\n${tokensOf(node, []).join('\u0000')}\n`);
    }
  }
  return { fingerprint: hash.digest('hex').slice(0, 16), roots: [...roots].sort(), covered: sorted };
}

let loadedFingerprint: Promise<string | null> | null = null;

/** The fingerprint of the coupling-derivation source this process loaded (memoized at
 *  first use; the operator has no hot reload). Null when the source is not on disk,
 *  e.g. a bundled build — such rows are excluded from every window. */
export function loadedDerivationFingerprint(): Promise<string | null> {
  loadedFingerprint ??= (async () => {
    try {
      const [{ readFile }, { fileURLToPath }, mod] = await Promise.all([
        import('node:fs/promises'), import('node:url'), import('typescript'),
      ]);
      const tsApi = ((mod as { default?: TsApi }).default ?? mod) as TsApi;
      const path = fileURLToPath(new URL('../coord/coupling-derivation.ts', import.meta.url));
      return derivationFingerprint(tsApi, await readFile(path, 'utf8')).fingerprint;
    } catch {
      return null;
    }
  })();
  return loadedFingerprint;
}

// ── Window scoring (pure) ──────────────────────────────────────────────────────

export interface ShadowRow {
  ts: number;
  kind: string;
  mode: string;
  a?: string;
  b?: string;
  editorOwnerId?: string;
  symbol: string;
  path: string;
  reason?: string;
}

export interface FingerprintEpoch { fingerprint: string; firstTs: number }

export interface EdgeJudgment { ts: number; edgeKey: string; relevant: boolean; judgeOwnerId: string }

/** An observed cross-agent breakage, read from the gate and lint ledgers (D-014). */
export interface CrossAgentBreakage { ts: number; editorOwnerId: string; holderOwnerId: string }

export interface ShadowWindowInput {
  now: number;
  /** Distinct stamped fingerprints in order of first appearance. */
  epochs: FingerprintEpoch[];
  /** Rows of the latest epoch only. */
  windowRows: ShadowRow[];
  /** Rows with no fingerprint stamp (pre-stamp builds, bundled builds). */
  unstampedRows: number;
  /** Fingerprint-stamped rows from another serving plane, or with no plane stamp (D-036). */
  offPlaneRows?: number;
  judgments: EdgeJudgment[];
  /** Null when no breakage reader is available: recall is then unmeasured. */
  breakages: CrossAgentBreakage[] | null;
  /**
   * R-1's interface leg over the same window, counted PER EDIT from edit_attribution_ledger
   * (one row per dispatch call and file); null when unmeasured. `unknown` is the D-020
   * numerator: outside edits whose interface verdict was unknown.
   */
  interfaceLeg: { eligible: number | null; eligibleLineages?: number | null; unknown?: number | null } | null;
  /** ownerId → spawn-lineage key. */
  lineageOf: ReadonlyMap<string, string>;
  implementerOwners: ReadonlySet<string>;
  implementerLineages: ReadonlySet<string>;
  /** A prior recorded enable disposition for this fingerprint. */
  enabled?: boolean;
}

export type WindowStatus = 'not-open' | 'open' | 'closed';
export type WindowGrade = 'pending' | 'healthy' | 'broken' | 'unknown' | 'insufficient-data';
export type RecallState = 'measured' | 'insufficient-data' | 'reader-unavailable';

export interface ShadowWindowScore {
  status: WindowStatus;
  disposition: 'enable' | 'keep-shadow' | null;
  grade: WindowGrade;
  verdict: 'pass' | 'fail' | 'unknown';
  fingerprint: string | null;
  fingerprints: string[];
  restarts: number;
  windowStart: number | null;
  days: number;
  sample: number;
  liveAgents: number;
  lineages: number;
  judged: number;
  precision: number | null;
  recall: number | null;
  recallState: RecallState;
  breakages: number | null;
  tokenMeanChars: number | null;
  /** D-020 numerator (per edit, outside the implementer); null when unmeasured. */
  unknownOutcomes: number | null;
  interfaceEligible: number | null;
  unstampedRows: number;
  offPlaneRows: number;
  reviewBy: number | null;
  reasons: string[];
}

export function shadowEdgeKey(a: string, b: string, path: string, symbol: string): string {
  const [x, y] = a < b ? [a, b] : [b, a];
  return `${x}|${y}|${path}#${symbol}`;
}

export interface WindowEdge { a: string; b: string; path: string; symbol: string; firstTs: number; reason: string }
export type WindowLineage = Pick<ShadowWindowInput, 'lineageOf' | 'implementerOwners' | 'implementerLineages'>;

/** True when an owner is a plan implementer by owner OR by spawn lineage. */
export function isImplementerIdentity(id: string, l: WindowLineage): boolean {
  return l.implementerOwners.has(id) || l.implementerLineages.has(l.lineageOf.get(id) ?? id);
}

/**
 * The window's edges and their counted judgments. One rule for the scorer, the judge list
 * and the judge write, so a judgment the write accepts is one the scorer counts.
 *
 * EI-27217222854087146: R-12 measures edges from work items outside this plan. An edge
 * with an implementer endpoint is excluded from the sample, the judgments, precision,
 * note length, the minimum-sample checks and the dead-derivation rule. An endpoint is an
 * implementer by owner OR by lineage, so a respawned implementer session is excluded too.
 * The implementer set comes from resolvePlanImplementerIdentities, which returns every
 * past holder of any of this plan's work items (taken_by, terminal_owner,
 * last_released_by, worked_by_history), the plan's auditors and its code editors, so an
 * edge with no such endpoint is outside the plan. Recall still searches every edge
 * (`allEdges`): a breakage caught by any edge was caught. The latest outside-lineage
 * judgment per edge wins; an implementer-lineage judgment never counts.
 */
export function windowEdges(
  input: Pick<ShadowWindowInput, 'windowRows' | 'judgments'> & WindowLineage, windowStart: number,
): { allEdges: Map<string, WindowEdge>; edges: Map<string, WindowEdge>; latestJudgment: Map<string, EdgeJudgment>; surfaced: number } {
  const allEdges = new Map<string, WindowEdge>();
  let surfaced = 0;
  for (const r of input.windowRows) {
    if (r.kind === 'edge' && r.a && r.b) {
      if (r.mode !== 'shadow') surfaced += 1;
      const key = shadowEdgeKey(r.a, r.b, r.path, r.symbol);
      const prior = allEdges.get(key);
      if (!prior || r.ts < prior.firstTs) {
        allEdges.set(key, { a: r.a, b: r.b, path: r.path, symbol: r.symbol, firstTs: r.ts, reason: r.reason ?? prior?.reason ?? '' });
      }
    }
  }
  const edges = new Map([...allEdges].filter(([, e]) => !isImplementerIdentity(e.a, input) && !isImplementerIdentity(e.b, input)));
  const latestJudgment = new Map<string, EdgeJudgment>();
  for (const j of [...input.judgments].sort((x, y) => x.ts - y.ts)) {
    if (!edges.has(j.edgeKey) || j.ts < windowStart || isImplementerIdentity(j.judgeOwnerId, input)) continue;
    latestJudgment.set(j.edgeKey, j);
  }
  return { allEdges, edges, latestJudgment, surfaced };
}

/**
 * The ts-ordered sequence of fingerprint CHANGES. Every change opens a new epoch and
 * counts as a restart, including a change back to an earlier value: A→B→A (a revert or
 * eject of a helper edit) is three epochs and two restarts, and the window scores only
 * the rows since the last change. Grouping by distinct value instead would keep scoring
 * B's frozen rows while A is the live derivation again. Unstamped rows are skipped.
 */
export function fingerprintEpochs(rows: readonly { ts: number; fingerprint: string | null }[]): FingerprintEpoch[] {
  const out: FingerprintEpoch[] = [];
  for (const r of [...rows].sort((x, y) => x.ts - y.ts)) {
    if (!r.fingerprint) continue;
    if (out[out.length - 1]?.fingerprint !== r.fingerprint) out.push({ fingerprint: r.fingerprint, firstTs: r.ts });
  }
  return out;
}

const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

/** Pure: score one shadow window against every R-12 bound. */
export function scoreShadowWindow(input: ShadowWindowInput): ShadowWindowScore {
  const B = SHADOW_WINDOW_BOUNDS;
  const fingerprints = input.epochs.map(e => e.fingerprint);
  const restarts = Math.max(0, fingerprints.length - 1);
  const latest = input.epochs[input.epochs.length - 1] ?? null;
  const base: ShadowWindowScore = {
    status: 'not-open', disposition: null, grade: 'pending', verdict: 'unknown',
    fingerprint: latest?.fingerprint ?? null, fingerprints, restarts,
    windowStart: latest?.firstTs ?? null, days: 0, sample: 0, liveAgents: 0, lineages: 0, judged: 0,
    precision: null, recall: null, recallState: 'reader-unavailable', breakages: null, tokenMeanChars: null,
    unknownOutcomes: input.interfaceLeg?.unknown ?? null, interfaceEligible: input.interfaceLeg?.eligible ?? null,
    unstampedRows: input.unstampedRows, offPlaneRows: input.offPlaneRows ?? 0, reviewBy: null, reasons: [],
  };
  if (!latest) {
    base.reasons.push(`no fingerprint-stamped shadow rows on ${SHADOW_WINDOW_PLANE}: the P-011 writer is not serving a stamping build there yet`);
    return base;
  }
  if (restarts > B.restartCap) {
    return { ...base, status: 'closed', disposition: 'keep-shadow', grade: 'unknown', verdict: 'unknown',
      reviewBy: input.now + B.reviewByDays * DAY_MS,
      reasons: [`fingerprint changed ${restarts} times (cap ${B.restartCap}): window closed keep-shadow as unknown`] };
  }

  const days = (input.now - latest.firstTs) / DAY_MS;
  // D-020 unknown share. The numerator comes from the SAME source, unit and population as the
  // eligible count: edit_attribution_ledger rows (one per dispatch call and file) whose
  // interface verdict is unknown, by owners outside the implementer lineages
  // (summarizeInterfaceEligibility). Shadow `unknown` rows are NOT counted: they are not one
  // per edit. The writer (coupling-sources.ts logCodeDependencyShadow) runs on coupling READS,
  // keys each row by an hour bucket and inserts ON CONFLICT DO NOTHING, so N same-hour
  // unknown edits leave one row, and one evidence row is re-emitted every hour it is read.
  const unknownEdits = input.interfaceLeg?.unknown ?? null;
  const { allEdges, edges, latestJudgment, surfaced } = windowEdges(input, latest.firstTs);
  const agents = new Set([...edges.values()].flatMap(e => [e.a, e.b]));
  const lineages = new Set([...agents].map(id => input.lineageOf.get(id) ?? id));
  const relevant = [...latestJudgment.values()].filter(j => j.relevant).length;

  let recallState: RecallState = 'reader-unavailable';
  let recall: number | null = null;
  if (input.breakages) {
    const inWindow = input.breakages.filter(x => x.ts >= latest.firstTs && x.ts <= input.now);
    if (!inWindow.length) recallState = 'insufficient-data';
    else {
      recallState = 'measured';
      const caught = inWindow.filter(x => [...allEdges.values()].some(e => e.firstTs <= x.ts
        && ((e.a === x.editorOwnerId && e.b === x.holderOwnerId) || (e.b === x.editorOwnerId && e.a === x.holderOwnerId)))).length;
      recall = caught / inWindow.length;
    }
  }
  const reasons: string[] = [];
  const scored: ShadowWindowScore = {
    ...base, days, sample: edges.size, liveAgents: agents.size, lineages: lineages.size, judged: latestJudgment.size,
    precision: ratio(relevant, edges.size), recall, recallState,
    breakages: input.breakages ? input.breakages.filter(x => x.ts >= latest.firstTs).length : null,
    tokenMeanChars: edges.size ? [...edges.values()].reduce((s, e) => s + e.reason.length, 0) / edges.size : null,
    unknownOutcomes: unknownEdits, reasons,
  };

  if (surfaced > 0 && !input.enabled) {
    reasons.push(`${surfaced} edge row(s) left shadow mode with no recorded enable disposition`);
    return { ...scored, status: days >= B.minDays ? 'closed' : 'open', grade: 'broken', verdict: 'fail' };
  }
  if (days < B.minDays) {
    reasons.push(`window open: ${days.toFixed(1)} of ${B.minDays} days, ${edges.size} edge(s)`);
    return { ...scored, status: 'open' };
  }
  const eligible = input.interfaceLeg?.eligible ?? null;
  const eligibleLineages = input.interfaceLeg?.eligibleLineages ?? null;
  // The D-020 dead-derivation rule needs BOTH counts, measured outside the implementer
  // lineages. A reader that omits either leaves the rule unevaluable — never satisfied.
  const deadMeasured = eligible !== null && eligibleLineages !== null && unknownEdits !== null;
  const deadEvidence = deadMeasured && (eligible as number) >= B.deadMinEligible
    && (eligibleLineages as number) >= B.deadMinLineages;
  if (deadEvidence && (edges.size === 0 || (unknownEdits as number) > B.deadUnknownShare * (eligible as number))) {
    reasons.push(`dead derivation: ${eligible} eligible interface edits, ${edges.size} edge(s), ${unknownEdits} unknown edit(s)`);
    return { ...scored, status: 'closed', disposition: 'keep-shadow', grade: 'broken', verdict: 'fail',
      reviewBy: input.now + B.reviewByDays * DAY_MS };
  }
  if (edges.size < B.minSample && days < B.maxDays) {
    reasons.push(`window open until ${B.minSample} edges or ${B.maxDays} days: ${edges.size} edge(s) at ${days.toFixed(1)} days`);
    return { ...scored, status: 'open' };
  }
  const reviewBy = input.now + B.reviewByDays * DAY_MS;
  if (edges.size < B.minSample) {
    if (!deadEvidence) {
      reasons.push(`insufficient-data at ${B.maxDays} days and the derivation is not shown alive (interface leg unmeasured or below ${B.deadMinEligible} eligible edits)`);
      return { ...scored, status: 'closed', disposition: 'keep-shadow', grade: 'unknown', verdict: 'unknown', reviewBy };
    }
    // Too few edges means neither precision nor recall reached the named sample, so this
    // close is not a measured R-12 outcome: it records the disposition but never passes.
    reasons.push(`insufficient-data at ${B.maxDays} days: ${edges.size} edge(s); derivation alive; unmeasured keep-shadow`);
    return { ...scored, status: 'closed', disposition: 'keep-shadow', grade: 'insufficient-data', verdict: 'unknown', reviewBy };
  }
  const misses: string[] = [];
  if ((scored.precision ?? 0) < B.precision) misses.push(`precision ${(scored.precision ?? 0).toFixed(2)} < ${B.precision}`);
  if (recallState !== 'measured') misses.push(`recall ${recallState}`);
  else if ((recall ?? 0) < B.recall) misses.push(`recall ${(recall ?? 0).toFixed(2)} < ${B.recall}`);
  if ((scored.tokenMeanChars ?? 0) > B.tokenMeanChars) misses.push(`mean note ${Math.round(scored.tokenMeanChars ?? 0)} chars > ${B.tokenMeanChars}`);
  if (agents.size < B.minLiveAgents) misses.push(`${agents.size} live agent(s) < ${B.minLiveAgents}`);
  if (lineages.size < B.minLineages) misses.push(`${lineages.size} outside lineage(s) < ${B.minLineages}`);
  // A close (enable OR keep-shadow) is only a measured R-12 outcome when every named measure
  // was actually taken: recall from the breakage ledger, precision from at least one
  // outside-lineage judgment, the D-006 real-fleet floors (the window itself spans >= 3 live
  // agents and >= 3 lineages outside the implementer's), and the D-020 dead-derivation inputs.
  // Otherwise the window closed without the P-012 measurement happening, so it grades unknown
  // instead of passing (the D-006 failure R-12 exists to stop).
  const unmeasured: string[] = [];
  if (recallState !== 'measured') unmeasured.push(`recall ${recallState}`);
  if (latestJudgment.size === 0) unmeasured.push('zero outside-lineage edge judgments');
  if (agents.size < B.minLiveAgents) unmeasured.push(`window spans ${agents.size} live agent(s) < ${B.minLiveAgents}`);
  if (lineages.size < B.minLineages) unmeasured.push(`window spans ${lineages.size} outside lineage(s) < ${B.minLineages}`);
  if (!deadMeasured) unmeasured.push('interface leg eligible edits or outside lineages unmeasured (D-020 rule not evaluable)');
  if (!misses.length && !unmeasured.length) {
    reasons.push('every R-12 bound met: enable');
    return { ...scored, status: 'closed', disposition: 'enable', grade: 'healthy', verdict: 'pass' };
  }
  if (misses.length) reasons.push(`keep-shadow: ${misses.join('; ')}`);
  if (unmeasured.length) {
    reasons.push(`unmeasured keep-shadow: ${unmeasured.join('; ')}`);
    return { ...scored, status: 'closed', disposition: 'keep-shadow', grade: 'unknown', verdict: 'unknown', reviewBy };
  }
  return { ...scored, status: 'closed', disposition: 'keep-shadow', grade: 'healthy', verdict: 'pass', reviewBy };
}

export function summarizeShadowWindow(s: ShadowWindowScore): string {
  const pct = (v: number | null) => (v === null ? 'n/a' : v.toFixed(2));
  return [
    `status=${s.status}`, `disposition=${s.disposition ?? 'none'}`, `grade=${s.grade}`,
    `fingerprint=${s.fingerprint ?? 'none'}`, `restarts=${s.restarts}`, `days=${s.days.toFixed(1)}`,
    `sample=${s.sample}`, `liveAgents=${s.liveAgents}`, `lineages=${s.lineages}`, `judged=${s.judged}`,
    `precision=${pct(s.precision)}`, `recall=${pct(s.recall)} (${s.recallState})`,
    `tokenMeanChars=${s.tokenMeanChars === null ? 'n/a' : Math.round(s.tokenMeanChars)}`,
    `unknown=${s.unknownOutcomes ?? 'n/a'}`, `interfaceEligible=${s.interfaceEligible ?? 'n/a'}`,
    `unstamped=${s.unstampedRows}`, `offPlane=${s.offPlaneRows}`,
    ...(s.reviewBy ? [`reviewBy=${new Date(s.reviewBy).toISOString().slice(0, 10)}`] : []),
    ...s.reasons,
  ].join('; ');
}

/** One ledger owner's interface-eligible edit count in the window (edit_attribution_ledger). */
/** One owner's edit_attribution_ledger counts; `unknown` = edits whose interface verdict was unknown. */
export interface InterfaceEligibilityRow { owner: string | null; eligible: number; observed: number; unknown?: number }

/**
 * The D-020 dead-derivation inputs, counted OUTSIDE the implementer: eligible interface edits by
 * non-implementer owners, and how many distinct outside lineages made them. Unattributed rows
 * cannot establish a lineage, so they are skipped. No observed interface row at all means the
 * edit-time detector is not writing: both counts are unmeasured (null), never zero. The shared
 * liveness reader (push-leg-liveness measureLeg('interface')) counts every owner and returns no
 * lineage count, so it cannot answer either question.
 */
export function summarizeInterfaceEligibility(
  rows: readonly InterfaceEligibilityRow[], lineageOf: ReadonlyMap<string, string>,
  implementerOwners: ReadonlySet<string>, implementerLineages: ReadonlySet<string>,
): { eligible: number | null; eligibleLineages: number | null; unknown: number | null } {
  if (!rows.some(r => r.observed > 0)) return { eligible: null, eligibleLineages: null, unknown: null };
  let eligible = 0;
  let unknown = 0;
  const outside = new Set<string>();
  for (const r of rows) {
    if (!r.owner) continue;
    const lineage = lineageOf.get(r.owner) ?? r.owner;
    if (implementerOwners.has(r.owner) || implementerLineages.has(lineage)) continue;
    unknown += r.unknown ?? 0;
    if (r.eligible <= 0) continue;
    eligible += r.eligible;
    outside.add(lineage);
  }
  return { eligible, eligibleLineages: outside.size, unknown };
}

// ── Live adapter ───────────────────────────────────────────────────────────────

async function readInterfaceEligibility(sql: Sql, workspaceId: string, start: number, end: number): Promise<InterfaceEligibilityRow[]> {
  const rows = await sql<{ owner: string | null; eligible: string; observed: string; unknown: string }[]>`
    SELECT agent_id AS owner,
           count(*) FILTER (WHERE signal_eligibility->'interface'->>'verdict' = 'unknown') AS unknown,
           count(*) FILTER (WHERE signal_eligibility->'interface'->>'verdict' = 'eligible'
             AND jsonb_array_length(coalesce(signal_eligibility->'interface'->'peerEvidence'->'peers', '[]'::jsonb)) > 0) AS eligible,
           count(*) FILTER (WHERE signal_eligibility ? 'interface') AS observed
      FROM harness_shared.edit_attribution_ledger
     WHERE workspace_id = ${workspaceId}
       AND ts >= ${new Date(start).toISOString()}::timestamptz AND ts < ${new Date(end).toISOString()}::timestamptz
     GROUP BY agent_id`;
  return rows.map(r => ({ owner: r.owner, eligible: Number(r.eligible ?? 0), observed: Number(r.observed ?? 0),
    unknown: Number(r.unknown ?? 0) }));
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/**
 * Read one plane's shadow window from audit_log. Exported for the reader test. Every
 * shadow-row query is restricted to `plane` (D-036): the change points, so epochs are per
 * plane, and the window rows. Rows from other planes are only counted (offPlaneRows).
 */
export async function readShadowWindowInput(
  sql: Sql, workspaceId: string, now: number, plane: string = SHADOW_WINDOW_PLANE,
): Promise<Omit<ShadowWindowInput, 'lineageOf' | 'implementerOwners' | 'implementerLineages' | 'interfaceLeg'>> {
  // Change points only: every row whose fingerprint differs from the previous stamped row
  // in ts order, so A→B→A yields three epochs (see fingerprintEpochs).
  const changeRows = await sql<{ fingerprint: string; first_ts: string }[]>`
    SELECT fingerprint, ts::text AS first_ts
      FROM (SELECT id, ts, details->>'fingerprint' AS fingerprint,
                   lag(details->>'fingerprint') OVER (ORDER BY ts, id) AS prev
              FROM harness_shared.audit_log
             WHERE workspace_id = ${workspaceId} AND action = ${COUPLING_SHADOW_ROW_ACTION}
               AND details->>'fingerprint' IS NOT NULL
               AND details->>'servingHost' = ${plane}) s
     WHERE prev IS DISTINCT FROM fingerprint
     ORDER BY ts, id`;
  const [counts] = await sql<{ unstamped: string; off_plane: string }[]>`
    SELECT count(*) FILTER (WHERE details->>'fingerprint' IS NULL)::text AS unstamped,
           count(*) FILTER (WHERE details->>'fingerprint' IS NOT NULL
                              AND details->>'servingHost' IS DISTINCT FROM ${plane})::text AS off_plane
      FROM harness_shared.audit_log
     WHERE workspace_id = ${workspaceId} AND action = ${COUPLING_SHADOW_ROW_ACTION}`;
  const epochs = fingerprintEpochs(changeRows.map(r => ({ ts: Number(r.first_ts), fingerprint: r.fingerprint })));
  const unstampedRows = Number(counts?.unstamped ?? 0);
  const offPlaneRows = Number(counts?.off_plane ?? 0);
  const latest = epochs[epochs.length - 1];
  if (!latest) return { now, epochs, windowRows: [], unstampedRows, offPlaneRows, judgments: [], breakages: null };
  const rows = await sql<{ ts: string; details: Json }[]>`
    SELECT ts::text AS ts, details FROM harness_shared.audit_log
     WHERE workspace_id = ${workspaceId} AND action = ${COUPLING_SHADOW_ROW_ACTION}
       AND details->>'servingHost' = ${plane}
       AND details->>'fingerprint' = ${latest.fingerprint} AND ts >= ${latest.firstTs}
     ORDER BY ts LIMIT 50000`;
  const windowRows: ShadowRow[] = rows.map(r => ({
    ts: Number(r.ts), kind: str(r.details.kind) ?? 'edge', mode: str(r.details.mode) ?? 'shadow',
    a: str(r.details.a), b: str(r.details.b), editorOwnerId: str(r.details.editorOwnerId),
    symbol: str(r.details.symbol) ?? '', path: str(r.details.path) ?? '', reason: str(r.details.reason),
  }));
  const judged = await sql<{ ts: string; details: Json }[]>`
    SELECT ts::text AS ts, details FROM harness_shared.audit_log
     WHERE workspace_id = ${workspaceId} AND action = ${COUPLING_EDGE_JUDGMENT_ACTION} AND ts >= ${latest.firstTs}
     ORDER BY ts LIMIT 5000`;
  const judgments: EdgeJudgment[] = judged.flatMap(r => {
    const edgeKey = str(r.details.edgeKey);
    const judgeOwnerId = str(r.details.judgeOwnerId);
    return edgeKey && judgeOwnerId && typeof r.details.relevant === 'boolean'
      ? [{ ts: Number(r.ts), edgeKey, judgeOwnerId, relevant: r.details.relevant }] : [];
  });
  // Breakages come from a separate reader (cross-agent-breakages.ts, D-037), joined in
  // codeIntelCouplingShadowRescore; this read alone leaves recall reader-unavailable.
  return { now, epochs, windowRows, unstampedRows, offPlaneRows, judgments, breakages: null };
}

/** The plan-implementer and spawn-lineage lookups R-12 excludes by. Injected in tests. */
export interface ImplementerLineageSource {
  implementers(workspaceId: string): Promise<string[]>;
  lineageOf(ownerIds: string[], workspaceId: string): Promise<ReadonlyMap<string, string>>;
}

async function defaultLineageSource(): Promise<ImplementerLineageSource> {
  const identity = await import('../acceptance-author-identity');
  return {
    implementers: workspaceId => identity.resolvePlanImplementerIdentities(COUPLING_SHADOW_SUBJECT_PLAN, { workspaceId }),
    lineageOf: (ownerIds, workspaceId) => identity.lineagePartyKeys(ownerIds, { workspaceId }),
  };
}

/** Resolve the implementer owners and lineages, keyed over the plan implementers plus `ids`. */
export async function resolveWindowLineage(
  source: ImplementerLineageSource, workspaceId: string, ids: Iterable<string>,
): Promise<WindowLineage> {
  const implementers = await source.implementers(workspaceId);
  const lineageOf = await source.lineageOf([...new Set([...implementers, ...ids])], workspaceId);
  return {
    lineageOf, implementerOwners: new Set(implementers),
    implementerLineages: new Set(implementers.map(id => lineageOf.get(id) ?? id)),
  };
}

function windowEndpointIds(read: Pick<ShadowWindowInput, 'windowRows' | 'judgments'>): string[] {
  const ids = new Set<string>();
  for (const r of read.windowRows) for (const id of [r.a, r.b, r.editorOwnerId]) if (id) ids.add(id);
  for (const j of read.judgments) ids.add(j.judgeOwnerId);
  return [...ids];
}

export type JudgeShadowEdgeError =
  'window_not_open' | 'edge_not_in_window' | 'edge_has_implementer_endpoint' | 'judge_in_implementer_lineage';
export type JudgeShadowEdgeResult =
  | { ok: true; edgeKey: string; fingerprint: string; relevant: boolean; judgeOwnerId: string }
  | { ok: false; error: JudgeShadowEdgeError; detail: string };

/**
 * Record one relevance judgment of a shadow edge (WI-6554700010030879 part b): the
 * precision input of R-12. It writes the audit_log row readShadowWindowInput reads, and
 * refuses every judgment the scorer would drop, so no write is silently uncounted: no
 * open window, an edge absent from the current window, an edge with an implementer
 * endpoint, or a judge inside the implementer lineage. One row per (fingerprint, edge,
 * judge): re-judging replaces that judge's verdict, and the latest judgment of any
 * outside-lineage judge is the one the scorer counts. Writing a judgment never surfaces
 * or couples anything; enabling stays a separate, recorded decision.
 */
export async function judgeShadowEdge(
  sql: Sql,
  args: { workspaceId: string; judgeOwnerId: string; a: string; b: string; path: string; symbol: string;
    relevant: boolean; note?: string | null; now: number },
  source?: ImplementerLineageSource,
): Promise<JudgeShadowEdgeResult> {
  const read = await readShadowWindowInput(sql, args.workspaceId, args.now);
  const latest = read.epochs[read.epochs.length - 1];
  if (!latest) {
    return { ok: false, error: 'window_not_open', detail: `no fingerprint-stamped shadow rows on ${SHADOW_WINDOW_PLANE}, so there is no window to judge` };
  }
  const edgeKey = shadowEdgeKey(args.a, args.b, args.path, args.symbol);
  const lineage = await resolveWindowLineage(source ?? await defaultLineageSource(), args.workspaceId,
    [args.a, args.b, args.judgeOwnerId]);
  if (isImplementerIdentity(args.judgeOwnerId, lineage)) {
    return { ok: false, error: 'judge_in_implementer_lineage',
      detail: `${args.judgeOwnerId} is in the implementer lineage of ${COUPLING_SHADOW_SUBJECT_PLAN}; the scorer drops its judgments, so R-12 needs a judge outside that lineage` };
  }
  const { allEdges, edges } = windowEdges({ ...read, ...lineage }, latest.firstTs);
  if (!allEdges.has(edgeKey)) {
    return { ok: false, error: 'edge_not_in_window',
      detail: `edge ${edgeKey} has no shadow row in the current window (fingerprint ${latest.fingerprint}); list the judgeable edges first` };
  }
  if (!edges.has(edgeKey)) {
    return { ok: false, error: 'edge_has_implementer_endpoint',
      detail: `edge ${edgeKey} has an implementer endpoint, so R-12 excludes it from the sample` };
  }
  const id = `ccd-judge-${createHash('sha256').update(`${args.workspaceId}\0${latest.fingerprint}\0${edgeKey}\0${args.judgeOwnerId}`).digest('hex').slice(0, 32)}`;
  const details = { edgeKey, relevant: args.relevant, judgeOwnerId: args.judgeOwnerId, fingerprint: latest.fingerprint,
    a: args.a, b: args.b, path: args.path, symbol: args.symbol, note: args.note ?? null };
  await sql`
    INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
    VALUES (${id}, ${args.now}, ${args.judgeOwnerId}, ${COUPLING_EDGE_JUDGMENT_ACTION},
            ${`coupling-shadow-edge#${edgeKey}`}, ${sql.json(details)}, ${args.workspaceId})
    ON CONFLICT (id) DO UPDATE SET ts = EXCLUDED.ts, details = EXCLUDED.details`;
  return { ok: true, edgeKey, fingerprint: latest.fingerprint, relevant: args.relevant, judgeOwnerId: args.judgeOwnerId };
}

/**
 * The current window's judgeable edges (outside the implementer lineage), unjudged first,
 * each with the judgment the scorer currently counts. Bounded by `limit`; `total` and
 * `unjudged` are over the whole window, never the returned page.
 */
export async function listJudgeableShadowEdges(
  sql: Sql, args: { workspaceId: string; now: number; limit: number }, source?: ImplementerLineageSource,
): Promise<{ fingerprint: string | null; windowStart: number | null; total: number; unjudged: number;
  edges: (WindowEdge & { edgeKey: string; judged: { relevant: boolean; judgeOwnerId: string; ts: number } | null })[] }> {
  const read = await readShadowWindowInput(sql, args.workspaceId, args.now);
  const latest = read.epochs[read.epochs.length - 1];
  if (!latest) return { fingerprint: null, windowStart: null, total: 0, unjudged: 0, edges: [] };
  const lineage = await resolveWindowLineage(source ?? await defaultLineageSource(), args.workspaceId, windowEndpointIds(read));
  const { edges, latestJudgment } = windowEdges({ ...read, ...lineage }, latest.firstTs);
  const all = [...edges].map(([edgeKey, e]) => {
    const j = latestJudgment.get(edgeKey);
    return { edgeKey, ...e, judged: j ? { relevant: j.relevant, judgeOwnerId: j.judgeOwnerId, ts: j.ts } : null };
  }).sort((x, y) => Number(x.judged !== null) - Number(y.judged !== null) || x.firstTs - y.firstTs);
  return { fingerprint: latest.fingerprint, windowStart: latest.firstTs, total: all.length,
    unjudged: all.filter(e => !e.judged).length, edges: all.slice(0, Math.max(0, args.limit)) };
}

async function recordWindow(sql: Sql, workspaceId: string, now: number, score: ShadowWindowScore): Promise<void> {
  const day = Math.floor(now / DAY_MS);
  const id = `ccd-win-${createHash('sha256').update(`${workspaceId}\0${score.fingerprint ?? 'none'}\0${day}`).digest('hex').slice(0, 32)}`;
  const details = JSON.parse(JSON.stringify({ ...score, plan: COUPLING_SHADOW_SUBJECT_PLAN, item: 'P-012', requirement: 'R-12' }));
  await sql`
    INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
    VALUES (${id}, ${now}, ${'system:code-intel-coupling-shadow-window'}, ${COUPLING_SHADOW_WINDOW_ACTION},
            ${`coupling-shadow-window#${score.fingerprint ?? 'none'}`}, ${sql.json(details)}, ${workspaceId})
    ON CONFLICT (id) DO UPDATE SET ts = EXCLUDED.ts, details = EXCLUDED.details`;
}

/**
 * Write the window's disposition row, then report the verdict. A failed write returns
 * unknown: with no disposition row the outcome is not on the ledger, which R-12 names as
 * drift ("window closes with no enable or keep-shadow disposition recorded").
 */
export async function recordAndReport(
  score: ShadowWindowScore,
  record: () => Promise<void>,
): Promise<{ verdict: ShadowWindowScore['verdict']; detail: string; value: number }> {
  try {
    await record();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { verdict: 'unknown', detail: `disposition write failed (${msg.slice(0, 200)}); ${summarizeShadowWindow(score)}`, value: score.sample };
  }
  return { verdict: score.verdict, detail: summarizeShadowWindow(score), value: score.sample };
}

/** Rubric-instrument rescore adapter for {@link COUPLING_SHADOW_WINDOW_INSTRUMENT_KEY}. */
export function codeIntelCouplingShadowRescore() {
  return {
    windowMs: SHADOW_WINDOW_BOUNDS.maxDays * DAY_MS,
    unit: 'count' as const,
    scope: 'workspace' as const,
    resolve: async (window: { workspaceId: string; windowStart: string; windowEnd: string }) => {
      if (!window.workspaceId.trim()) return { verdict: 'unknown' as const, detail: 'Exact workspace required.' };
      const [{ getOrgPg }, lineageSource, { readCrossAgentBreakages }] = await Promise.all([
        import('@papercusp/db-org'), defaultLineageSource(), import('./cross-agent-breakages'),
      ]);
      const sql = getOrgPg().sql as unknown as Sql;
      const now = Date.now();
      const read = await readShadowWindowInput(sql, window.workspaceId, now);
      const latest = read.epochs[read.epochs.length - 1];
      // A failed read is unmeasured (null interfaceLeg), which keeps any close at unknown.
      const ifaceRows = latest ? await readInterfaceEligibility(sql, window.workspaceId, latest.firstTs, now).catch(() => null) : null;
      // Recall input (D-037). The reader never throws; any error or truncating cap is
      // breakages: null, which keeps recall reader-unavailable and refuses enable.
      const breakageRead = latest ? await readCrossAgentBreakages(sql, window.workspaceId, latest.firstTs, now) : null;
      const endpoints = windowEndpointIds(read);
      for (const r of ifaceRows ?? []) if (r.owner) endpoints.push(r.owner);
      const { lineageOf, implementerOwners, implementerLineages } = await resolveWindowLineage(lineageSource, window.workspaceId, endpoints);
      const interfaceLeg = ifaceRows ? summarizeInterfaceEligibility(ifaceRows, lineageOf, implementerOwners, implementerLineages) : null;
      const score = scoreShadowWindow({ ...read, breakages: breakageRead?.breakages ?? null,
        interfaceLeg, lineageOf, implementerOwners, implementerLineages });
      if (breakageRead) score.reasons.push(`breakage reader: ${breakageRead.reason}`);
      return recordAndReport(score, () => recordWindow(sql, window.workspaceId, now, score));
    },
  };
}
