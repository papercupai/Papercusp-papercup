/** P008: pure action attribution over an injected, consistent read-only snapshot.
 * No provider, credential, lifecycle, scheduler or P009 collector is opened here.
 * Adapters must enumerate the broader audit population, not filter it to known actors.
 */
import { z } from 'zod';
import {
  deferredSpendEvidenceIdentitySchema, deferredSpendFingerprint, evaluateDeferredSpendEvidence,
  type DeferredSpendEvidence, type DeferredSpendEvidenceIdentity, type DeferredSpendEvidenceResult,
  type DeferredSpendEvidenceSlice,
} from './deferred-spend-acceptance-contract';

export const DEFERRED_SPEND_ACTION_STREAMS = [
  'operations', 'events', 'resources', 'requests', 'admissions', 'credentials', 'invocations', 'native',
] as const;
export type DeferredSpendActionStream = typeof DEFERRED_SPEND_ACTION_STREAMS[number];
const text = z.string().trim().min(1);
const refs = z.array(text).min(1);
const timestamp = z.string().datetime({ offset: true });
const action = z.enum(['observe', 'provision', 'lifecycle-replay', 'credential-mint', 'destroy',
  'conversation-transition', 'readiness-transition', 'other']);
const target = z.object({ ref: text, generation: text }).strict();
const anchor = z.object({ actorId: text, startedAt: timestamp, evidenceRefs: refs }).strict();
const requestSchema = z.object({
  expectedIdentity: deferredSpendEvidenceIdentitySchema,
  implementation: z.array(anchor).min(1),
  acceptance: z.array(anchor).min(1),
  boundaries: z.object({ r7: target, g6: target, r31: target }).strict(),
}).strict();
export type DeferredSpendActionBoundaryRequest = z.input<typeof requestSchema>;

const actor = z.object({
  id: text, generation: text, principalId: text, sessionId: text, workItemId: text, evidenceRefs: refs,
}).strict();
const lineageSchema = z.object({
  snapshotRef: text, complete: z.boolean(), historyComplete: z.boolean(), evidenceRefs: refs,
  actors: z.array(actor),
  edges: z.array(z.object({ from: text, to: text,
    relation: z.enum(['successor', 'continuation', 'child']), evidenceRefs: refs }).strict()),
  aliases: z.array(z.object({ alias: text, actorId: text, generation: text,
    startAt: timestamp, endAt: timestamp, evidenceRefs: refs }).strict()),
}).strict();
export type DeferredSpendActionLineage = z.input<typeof lineageSchema>;

const authorization = z.object({
  id: text, actorId: text, workItemId: text, issuedAt: timestamp, action, target,
  independentOf: z.array(text).min(1), separateCausalRoot: z.literal(true),
  lineageRefs: refs, evidenceRefs: refs,
}).strict();
const recordSchema = z.object({
  id: text, workspaceId: text, occurredAt: timestamp, action, target,
  operationId: text.nullable(), invocationId: text.nullable(),
  writeTime: z.object({
    actorId: text, actorGeneration: text, principalId: text, sessionId: text,
    workItemId: text, sourceRef: text, processId: text, buildId: text,
  }).strict().nullable(),
  authorization: authorization.nullable(),
  audit: z.object({ complete: z.boolean(), evidenceRefs: refs }).strict(),
  evidenceRefs: refs,
}).strict();
export type DeferredSpendActionRecord = z.input<typeof recordSchema>;
const censusSchema = z.object({
  snapshotRef: text, complete: z.boolean(), retentionComplete: z.boolean(),
  window: z.object({ startAt: timestamp, endAt: timestamp }).strict(),
  count: z.number().int().nonnegative(), upperWatermark: text.nullable(), evidenceRefs: refs,
}).strict();
export type DeferredSpendActionCensus = z.input<typeof censusSchema>;
const pageSchema = z.object({
  snapshotRef: text, upperWatermark: text.nullable(), after: text.nullable(), nextAfter: text.nullable(),
  records: z.array(z.unknown()), evidenceRef: text,
}).strict();
export type DeferredSpendActionPage = z.input<typeof pageSchema>;

export interface DeferredSpendActionSnapshot {
  readonly identity: DeferredSpendEvidenceIdentity;
  readonly readLineage: () => Promise<unknown>;
  readonly readCensus: (stream: DeferredSpendActionStream) => Promise<unknown>;
  readonly readPage: (stream: DeferredSpendActionStream, after: string | null, upperWatermark: string | null) => Promise<unknown>;
}
export interface DeferredSpendActionDependencies {
  readonly withSnapshot: <T>(identity: DeferredSpendEvidenceIdentity,
    read: (snapshot: DeferredSpendActionSnapshot) => Promise<T>) => Promise<T>;
}

/** Input is the P006 evidence shape, not a dependency on the P009 implementation. */
export async function collectDeferredSpendActionBoundary(
  request: DeferredSpendActionBoundaryRequest,
  sourceCensus: DeferredSpendEvidence | null,
  dependencies: DeferredSpendActionDependencies,
): Promise<DeferredSpendEvidenceResult> {
  const parsed = requestSchema.safeParse(request);
  const unknown = (reason: string): DeferredSpendEvidenceResult => Object.freeze({
    verdict: 'unknown', reasons: Object.freeze([reason]), slices: Object.freeze([]),
  });
  if (!parsed.success) return unknown(`invalid action-boundary request: ${parsed.error.message}`);
  const wanted = parsed.data;
  const identity = wanted.expectedIdentity;
  const window = identity.observation.window;
  const roots = [...wanted.implementation, ...wanted.acceptance];
  if (new Set(roots.map((entry) => entry.actorId)).size !== roots.length ||
      Math.min(...roots.map((entry) => Date.parse(entry.startedAt))) !== Date.parse(window.startAt) ||
      roots.some((entry) => Date.parse(entry.startedAt) >= Date.parse(window.endAt))) {
    return unknown('observation interval must cover original implementation and acceptance continuation anchors');
  }
  // Freeze an independently parsed copy before handing identity to an adapter.
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  };
  freeze(wanted);
  try {
    return await dependencies.withSnapshot(identity, async (snapshot) => {
      const actual = deferredSpendEvidenceIdentitySchema.safeParse(snapshot.identity);
      if (!actual.success || deferredSpendFingerprint(actual.data) !== deferredSpendFingerprint(identity)) {
        return unknown('action snapshot identity mismatch');
      }
      const population = new Set<string>();
      const checked = new Set<string>();
      const gaps: string[] = [];
      const pageRefs: string[] = [...identity.observation.snapshot.evidenceRefs];
      const violations: { member: string; reason: string; evidenceRefs: string[] }[] = [];
      const member = (id: string) => { population.add(id); return id; };
      const gap = (reason: string) => { gaps.push(reason); };
      const read = async (fn: () => Promise<unknown>): Promise<unknown> => {
        try { return await fn(); } catch { return undefined; }
      };
      const lineageMember = member('lineage:census');
      const lineage = lineageSchema.safeParse(await read(() => snapshot.readLineage()));
      const actors = new Map<string, z.infer<typeof actor>>();
      const scoped = new Set(roots.map((entry) => entry.actorId));
      let lineageValid = false;
      if (lineage.success && lineage.data.snapshotRef === identity.observation.snapshot.id) {
        const graph = lineage.data;
        graph.actors.forEach((entry) => actors.set(entry.id, entry));
        lineageValid = graph.snapshotRef === identity.observation.snapshot.id && graph.complete && graph.historyComplete &&
          actors.size === graph.actors.length && roots.every((root) => actors.has(root.actorId)) &&
          graph.edges.every((edge) => actors.has(edge.from) && actors.has(edge.to)) &&
          graph.aliases.every((alias) => actors.has(alias.actorId) && Date.parse(alias.startAt) < Date.parse(alias.endAt));
        // Even a partial census may contain a measured, proven continuation edge.
        let changed = true;
        while (changed) {
          changed = false;
          for (const edge of graph.edges) if (scoped.has(edge.from) && actors.has(edge.to) && !scoped.has(edge.to)) {
            scoped.add(edge.to); changed = true;
          }
        }
        pageRefs.push(...graph.evidenceRefs);
        if (lineageValid) checked.add(lineageMember);
      }
      if (!lineageValid) gap('lineage census, original anchors, aliases or retained history are incomplete');

      const rows: { stream: DeferredSpendActionStream; record: z.infer<typeof recordSchema>; member: string }[] = [];
      for (const stream of DEFERRED_SPEND_ACTION_STREAMS) {
        const censusMember = member(`${stream}:census`);
        const census = censusSchema.safeParse(await read(() => snapshot.readCensus(stream)));
        if (!census.success || census.data.snapshotRef !== identity.observation.snapshot.id ||
            deferredSpendFingerprint(census.data.window) !== deferredSpendFingerprint(window)) {
          gap(`${stream}: missing census or mismatched fixed interval/snapshot`); continue;
        }
        const c = census.data;
        pageRefs.push(...c.evidenceRefs);
        let valid = c.complete && c.retentionComplete && ((c.count === 0) === (c.upperWatermark === null));
        let after: string | null = null;
        let seen = 0;
        const ids = new Set<string>();
        const cursors = new Set<string>();
        for (;;) {
          const page = pageSchema.safeParse(await read(() => snapshot.readPage(stream, after, c.upperWatermark)));
          if (!page.success || page.data.snapshotRef !== c.snapshotRef || page.data.after !== after ||
              page.data.upperWatermark !== c.upperWatermark) { valid = false; break; }
          const p = page.data;
          pageRefs.push(p.evidenceRef);
          let last: string | null = after;
          for (const raw of p.records) {
            seen++;
            const record = recordSchema.safeParse(raw);
            if (!record.success) { valid = false; gap(`${stream}: malformed audit record`); continue; }
            const row = record.data;
            const id = member(`${stream}:${row.id}`);
            if (ids.has(row.id) || (last !== null && row.id <= last) ||
                c.upperWatermark === null || row.id > c.upperWatermark ||
                row.workspaceId !== identity.scope.workspaceId ||
                Date.parse(row.occurredAt) < Date.parse(window.startAt) ||
                Date.parse(row.occurredAt) > Date.parse(window.endAt)) {
              valid = false; gap(`${id}: duplicate, out-of-order, foreign or out-of-window row`); continue;
            }
            ids.add(row.id); last = row.id;
            rows.push({ stream, record: row, member: id });
          }
          if (p.nextAfter === null) break;
          if (!p.records.length || p.nextAfter !== last || cursors.has(p.nextAfter) ||
              seen >= c.count || (after !== null && p.nextAfter <= after)) { valid = false; break; }
          cursors.add(p.nextAfter); after = p.nextAfter;
        }
        if (seen !== c.count || ids.size !== c.count) valid = false;
        if (valid) checked.add(censusMember);
        else gap(`${stream}: incomplete pages, count/watermark, retention or cursor coverage`);
      }
      const operations = new Map(rows.filter((row) => row.stream === 'operations').map((row) => [row.record.id, row.record]));
      const invocations = new Map(rows.filter((row) => row.stream === 'invocations').map((row) => [row.record.id, row.record]));
      const sameTarget = (a: z.infer<typeof target>, b: z.infer<typeof target>) => a.ref === b.ref && a.generation === b.generation;
      const risky = (row: z.infer<typeof recordSchema>) =>
        ['provision', 'lifecycle-replay', 'credential-mint'].includes(row.action) ||
        (row.action === 'destroy' && sameTarget(row.target, wanted.boundaries.r7)) ||
        (row.action === 'conversation-transition' && sameTarget(row.target, wanted.boundaries.g6)) ||
        (row.action === 'readiness-transition' && sameTarget(row.target, wanted.boundaries.r31));
      for (const { stream, record: row, member: id } of rows) {
        const w = row.writeTime;
        if (!w || !row.audit.complete ||
            (row.operationId !== null && !operations.has(row.operationId)) ||
            (['events', 'resources', 'requests', 'admissions'].includes(stream) && row.operationId === null) ||
            (stream === 'native' && (row.invocationId === null || !invocations.has(row.invocationId)))) {
          gap(`${id}: missing write-time principal/source/operation join or complete native audit`); continue;
        }
        let actorId = w.actorId;
        const aliases = lineage.success ? lineage.data.aliases.filter((entry) => entry.alias === w.actorId &&
          entry.generation === w.actorGeneration && Date.parse(entry.startAt) <= Date.parse(row.occurredAt) &&
          Date.parse(entry.endAt) >= Date.parse(row.occurredAt)) : [];
        if (aliases.length > 1 || (actors.has(actorId) && aliases.length && aliases[0].actorId !== actorId)) {
          gap(`${id}: ambiguous canonical actor binding`); continue;
        }
        if (!actors.has(actorId) && aliases.length === 1) actorId = aliases[0].actorId;
        const who = actors.get(actorId);
        if (!who || (aliases.length === 0 && who.generation !== w.actorGeneration) || who.principalId !== w.principalId || who.sessionId !== w.sessionId || who.workItemId !== w.workItemId || row.action === 'other') {
          gap(`${id}: unresolved actor, work-item, session, principal or effect`); continue;
        }
        const joined = [row.operationId === null ? undefined : operations.get(row.operationId),
          row.invocationId === null ? undefined : invocations.get(row.invocationId)];
        if (joined.some((other) => other && (!other.audit.complete || !other.writeTime ||
            other.writeTime.principalId !== w.principalId || other.writeTime.workItemId !== w.workItemId ||
            other.writeTime.sessionId !== w.sessionId || !sameTarget(other.target, row.target)))) {
          gap(`${id}: canonical operation/invocation attribution join disagrees`); continue;
        }
        const boundary = Object.values(wanted.boundaries).find((entry) => entry.ref === row.target.ref);
        if (boundary && boundary.generation !== row.target.generation) {
          gap(`${id}: ambiguous boundary generation`); continue;
        }
        if (scoped.has(actorId)) {
          checked.add(id);
          if (risky(row)) violations.push({ member: id, reason: `attributable prohibited ${row.action}`,
            evidenceRefs: [...row.evidenceRefs, ...row.audit.evidenceRefs, ...who.evidenceRefs] });
          continue;
        }
        const auth = row.authorization;
        const independent = lineageValid && auth !== null && auth.actorId === actorId &&
          auth.workItemId === w.workItemId && auth.action === row.action && sameTarget(auth.target, row.target) &&
          Date.parse(auth.issuedAt) >= Date.parse(window.startAt) && Date.parse(auth.issuedAt) <= Date.parse(row.occurredAt) &&
          roots.every((root) => auth.independentOf.includes(root.actorId));
        // A benign observation is a positive control; a lifecycle effect needs causal authorization.
        if (row.action === 'observe' || independent) checked.add(id);
        else gap(`${id}: unrelated label/same host is not proof of independent authorization`);
      }
      // A vacuous empty audit cannot demonstrate that attribution filters actually work.
      if (!rows.some(({ record }) => record.action === 'observe') || !rows.some(({ record }) => record.action !== 'observe')) {
        gap('broader audit population lacks nonzero observation and lifecycle positive controls');
      }
      const slice: DeferredSpendEvidenceSlice = {
        id: 'action-boundary', verdict: violations.length ? 'fail' : gaps.length ? 'unknown' : 'pass',
        reason: gaps.length ? gaps.join('; ') : undefined, evidenceRefs: [...new Set(pageRefs)], violations,
        coverage: { state: gaps.length ? 'partial' : 'complete', population: [...population], checked: [...checked],
          notChecked: [...population].filter((entry) => !checked.has(entry)), notApplicable: [], residue: [], gaps,
          snapshotRef: identity.observation.snapshot.id, pageRefs: [...new Set(pageRefs)], emptyPopulationEvidenceRefs: [] },
      };
      const source = evaluateDeferredSpendEvidence({ expectedIdentity: identity, requiredSlices: ['source-census'] }, sourceCensus);
      return evaluateDeferredSpendEvidence({ expectedIdentity: identity, requiredSlices: ['source-census', 'action-boundary'] },
        { identity, slices: [...source.slices, slice] });
    });
  } catch {
    return unknown('consistent read-only action snapshot could not be read');
  }
}
