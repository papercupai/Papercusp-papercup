/**
 * Shared source/live evidence contract for deferred-spend acceptance (P-006).
 * This validates evidence, not the product. Collectors supply independently
 * reviewed selectors; no provider, database, scheduler or lifecycle is opened here.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const DEFERRED_SPEND_EVIDENCE_VERSION = 'deferred-spend-evidence-v1' as const;

export type EvidenceVerdict = 'pass' | 'fail' | 'unknown';
export type CoverageState = 'complete' | 'partial' | 'unreadable';
export type DeferredSpendImmutable<T> = T extends readonly unknown[]
  ? { readonly [K in keyof T]: DeferredSpendImmutable<T[K]> }
  : T extends object
    ? { readonly [K in keyof T]: DeferredSpendImmutable<T[K]> }
    : T;

const text = z.string().trim().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const timestamp = z.string().datetime({ offset: true });
const refs = z.array(text).min(1);
const path = text.refine(
  (value) => !value.startsWith('/') && !value.includes('\\') &&
    !value.split('/').some((part) => part === '..' || part === '.' || part === ''),
  'expected a repository-relative POSIX path',
);

const provenanceSchema = z.object({
  method: text,
  selector: text,
  evidenceRefs: refs,
}).strict();

const contentSelectorSchema = z.object({
  path,
  contentHash: hash,
  provenance: provenanceSchema,
}).strict();

const revisionSelectorSchema = z.object({
  revision,
  treeHash: hash,
  provenance: provenanceSchema,
}).strict();

const fileIdentitySchema = z.object({ path, contentHash: hash }).strict();
const changedPathSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('added'), new: fileIdentitySchema }).strict(),
  z.object({ status: z.literal('deleted'), old: fileIdentitySchema }).strict(),
  z.object({ status: z.literal('modified'), old: fileIdentitySchema, new: fileIdentitySchema }).strict(),
  z.object({ status: z.literal('renamed'), old: fileIdentitySchema, new: fileIdentitySchema }).strict(),
]);

/** Hash validated JSON values; object-key ordering is not identity. Array order is. */
export function deferredSpendFingerprint(value: unknown): string {
  const canonical = (entry: unknown): string => {
    if (Array.isArray(entry)) return `[${entry.map(canonical).join(',')}]`;
    if (entry !== null && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
    }
    const encoded = JSON.stringify(entry);
    if (encoded === undefined) throw new TypeError('expected a validated JSON value');
    return encoded;
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/**
 * D-018: this is the independently derived input to a source census, never
 * reconstructed from that census's selected manifest. P-009 consumes it later;
 * P-008 receives typed census evidence without importing/calling P-009.
 */
export const deferredSpendCensusSelectorsSchema = z.object({
  base: revisionSelectorSchema,
  candidate: revisionSelectorSchema,
  roots: z.object({
    repositoryRoot: text,
    workspaceRoot: text,
    contentHash: hash,
    provenance: provenanceSchema,
  }).strict(),
  projectConfiguration: z.object({
    contentHash: hash,
    provenance: provenanceSchema,
    tsconfigs: z.array(contentSelectorSchema).min(1),
    projectReferences: z.array(contentSelectorSchema),
  }).strict(),
  migrationRegistry: z.object({
    revision,
    contentHash: hash,
    provenance: provenanceSchema,
    entries: z.array(contentSelectorSchema),
  }).strict(),
  productionRoots: z.array(contentSelectorSchema).min(1),
  changedPaths: z.object({
    method: z.literal('reviewed-base-to-candidate-diff'),
    baseRevision: revision,
    candidateRevision: revision,
    populationHash: hash,
    provenance: provenanceSchema,
    entries: z.array(changedPathSchema),
  }).strict(),
}).strict().superRefine((selectors, ctx) => {
  const issue = (at: (string | number)[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: at, message });
  if (selectors.changedPaths.baseRevision !== selectors.base.revision ||
      selectors.changedPaths.candidateRevision !== selectors.candidate.revision) {
    issue(['changedPaths'], 'reviewed population revisions do not match the base/candidate selectors');
  }
  if (selectors.changedPaths.populationHash !== deferredSpendFingerprint(selectors.changedPaths.entries)) {
    issue(['changedPaths', 'populationHash'], 'reviewed changed-path population hash mismatch');
  }
  for (const [name, entries] of [
    ['tsconfigs', selectors.projectConfiguration.tsconfigs],
    ['projectReferences', selectors.projectConfiguration.projectReferences],
    ['migrationRegistry', selectors.migrationRegistry.entries],
    ['productionRoots', selectors.productionRoots],
  ] as const) {
    if (!unique(entries.map((entry) => entry.path))) issue([name], 'duplicate selector path');
  }
  const oldPaths: string[] = [];
  const newPaths: string[] = [];
  for (const entry of selectors.changedPaths.entries) {
    if ('old' in entry) oldPaths.push(entry.old.path);
    if ('new' in entry) newPaths.push(entry.new.path);
    if (entry.status === 'modified' && entry.old.path !== entry.new.path) {
      issue(['changedPaths'], 'modified paths must retain their path identity');
    }
    if (entry.status === 'renamed' && entry.old.path === entry.new.path) {
      issue(['changedPaths'], 'renamed paths must identify both distinct names');
    }
  }
  if (!unique(oldPaths) || !unique(newPaths)) issue(['changedPaths'], 'duplicate changed-path identity');
});

export const deferredSpendEvidenceIdentitySchema = z.object({
  schemaVersion: z.literal(DEFERRED_SPEND_EVIDENCE_VERSION),
  scope: z.object({
    workspaceId: text,
    harness: text,
    planSlug: text,
    rubricRef: text,
    rubricRevision: z.number().int().positive(),
    criteriaHash: hash,
  }).strict(),
  subject: z.object({ kind: z.enum(['source', 'live']), ref: text }).strict(),
  observation: z.object({
    id: text,
    observedAt: timestamp,
    window: z.object({ startAt: timestamp, endAt: timestamp }).strict(),
    serving: z.object({ hostId: text, processId: text, buildId: text, runtimeGeneration: text }).strict(),
    snapshot: z.object({
      id: text,
      acquiredAt: timestamp,
      scopeHash: hash,
      consistency: z.literal('consistent-read-only'),
      evidenceRefs: refs,
    }).strict(),
  }).strict(),
  sourceManifestHash: hash,
  configurationHash: hash,
  censusSelectors: deferredSpendCensusSelectorsSchema,
}).strict().superRefine((identity, ctx) => {
  const { window, observedAt, snapshot } = identity.observation;
  if (Date.parse(window.startAt) >= Date.parse(window.endAt) ||
      Date.parse(window.endAt) > Date.parse(observedAt) ||
      Date.parse(snapshot.acquiredAt) > Date.parse(observedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['observation'], message: 'inconsistent observation interval' });
  }
  if (snapshot.scopeHash !== deferredSpendFingerprint(identity.scope)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['observation', 'snapshot'], message: 'snapshot scope mismatch' });
  }
});

export const deferredSpendCoverageSchema = z.object({
  state: z.enum(['complete', 'partial', 'unreadable']),
  population: z.array(text),
  checked: z.array(text),
  notChecked: z.array(text),
  notApplicable: z.array(z.object({ member: text, reason: text, evidenceRefs: refs }).strict()),
  residue: z.array(text),
  gaps: z.array(text),
  snapshotRef: text,
  pageRefs: refs,
  emptyPopulationEvidenceRefs: z.array(text),
}).strict().superRefine((coverage, ctx) => {
  const partition = [...coverage.checked, ...coverage.notChecked, ...coverage.notApplicable.map((entry) => entry.member)];
  if (!unique(coverage.population) || !unique(partition) ||
      partition.length !== coverage.population.length ||
      partition.some((member) => !coverage.population.includes(member))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'coverage must uniquely and exhaustively partition its population' });
  }
  if (coverage.state === 'complete' &&
      (coverage.notChecked.length || coverage.gaps.length || coverage.residue.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'complete coverage has unchecked members, gaps or residue' });
  }
  if (coverage.population.length === 0 && coverage.emptyPopulationEvidenceRefs.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'empty population requires explicit census evidence' });
  }
});

export const deferredSpendEvidenceSliceSchema = z.object({
  id: text,
  verdict: z.enum(['pass', 'fail', 'unknown']),
  coverage: deferredSpendCoverageSchema,
  evidenceRefs: refs,
  reason: text.optional(),
  violations: z.array(z.object({ member: text, reason: text, evidenceRefs: refs }).strict()),
}).strict().superRefine((slice, ctx) => {
  if ((slice.verdict === 'fail' && slice.violations.length === 0) ||
      (slice.verdict !== 'fail' && slice.violations.length !== 0) ||
      slice.violations.some((violation) => !slice.coverage.checked.includes(violation.member)) ||
      (slice.verdict === 'unknown' && !slice.reason)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'verdict lacks a checked violation or an explicit unknown reason' });
  }
});

export type DeferredSpendCensusSelectors = DeferredSpendImmutable<z.infer<typeof deferredSpendCensusSelectorsSchema>>;
export type DeferredSpendEvidenceIdentity = DeferredSpendImmutable<z.infer<typeof deferredSpendEvidenceIdentitySchema>>;
export type DeferredSpendCoverage = DeferredSpendImmutable<z.infer<typeof deferredSpendCoverageSchema>>;
export type DeferredSpendEvidenceSlice = DeferredSpendImmutable<z.infer<typeof deferredSpendEvidenceSliceSchema>>;
export interface DeferredSpendEvidence {
  readonly identity: DeferredSpendEvidenceIdentity;
  readonly slices: readonly DeferredSpendEvidenceSlice[];
}

export interface DeferredSpendEvidenceRequest {
  /** Independently derived expected identity, never copied from the returned census. */
  readonly expectedIdentity: DeferredSpendEvidenceIdentity;
  readonly requiredSlices: readonly string[];
}

export interface DeferredSpendEvidenceResult {
  readonly verdict: EvidenceVerdict;
  readonly reasons: readonly string[];
  readonly identity?: DeferredSpendEvidenceIdentity;
  readonly slices: readonly DeferredSpendEvidenceSlice[];
}

function freeze<T>(value: T): DeferredSpendImmutable<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as DeferredSpendImmutable<T>;
}

function unknownResult(reason: string): DeferredSpendEvidenceResult {
  return freeze({ verdict: 'unknown' as const, reasons: [reason], slices: [] });
}

const requestSchema = z.object({
  expectedIdentity: deferredSpendEvidenceIdentitySchema,
  requiredSlices: z.array(text).min(1).refine(unique, 'duplicate required slice'),
}).strict();

/** Validate independently before reading; malformed identity can never prove a violation. */
export function evaluateDeferredSpendEvidence(request: unknown, evidence: unknown): DeferredSpendEvidenceResult {
  const wanted = requestSchema.safeParse(request);
  if (!wanted.success) return unknownResult(`invalid expected identity/request: ${wanted.error.message}`);
  const envelope = z.object({ identity: deferredSpendEvidenceIdentitySchema, slices: z.array(z.unknown()) }).strict().safeParse(evidence);
  if (!envelope.success) return unknownResult(`missing or invalid evidence identity: ${envelope.error.message}`);
  if (deferredSpendFingerprint(wanted.data.expectedIdentity) !== deferredSpendFingerprint(envelope.data.identity)) {
    return unknownResult('evidence identity differs from the independently selected subject, interval, runtime or source census selectors');
  }
  const reasons: string[] = [];
  const slices: DeferredSpendEvidenceSlice[] = [];
  for (const id of wanted.data.requiredSlices) {
    const matches = envelope.data.slices.filter((entry) =>
      entry !== null && typeof entry === 'object' && 'id' in entry && entry.id === id);
    if (matches.length !== 1) {
      reasons.push(`${id}: required slice missing or duplicated`);
      continue;
    }
    const parsed = deferredSpendEvidenceSliceSchema.safeParse(matches[0]);
    if (!parsed.success) {
      reasons.push(`${id}: invalid coverage/evidence: ${parsed.error.message}`);
      continue;
    }
    const slice = parsed.data;
    if (slice.coverage.snapshotRef !== envelope.data.identity.observation.snapshot.id) {
      reasons.push(`${id}: coverage belongs to a different snapshot`);
      continue;
    }
    slices.push(freeze(slice));
    if (slice.verdict === 'unknown' || slice.coverage.state !== 'complete') {
      reasons.push(`${id}: ${slice.reason ?? `coverage is ${slice.coverage.state}`}`);
    }
  }
  // A measured violation on this exact identity dominates gaps in other slices.
  const failures = slices.filter((slice) => slice.verdict === 'fail');
  const verdict: EvidenceVerdict = failures.length ? 'fail' : reasons.length ? 'unknown' : 'pass';
  return freeze({
    verdict,
    reasons: [...failures.flatMap((slice) => slice.violations.map((entry) => `${slice.id}: ${entry.reason}`)), ...reasons],
    identity: envelope.data.identity,
    slices,
  });
}

/** Opaque read view: intentionally exposes no SQL executor or mutation handles. */
export interface DeferredSpendReadOnlySnapshot {
  readonly identity: DeferredSpendEvidenceIdentity;
  readonly readSlice: (id: string) => Promise<unknown>;
}

export interface DeferredSpendReadOnlyDependencies {
  /** The adapter establishes one scoped consistent read-only snapshot before callback. */
  readonly withSnapshot: <T>(
    identity: DeferredSpendEvidenceIdentity,
    read: (snapshot: DeferredSpendReadOnlySnapshot) => Promise<T>,
  ) => Promise<T>;
}

/** No singleton/default collector. Every read stays inside the injected snapshot. */
export async function readDeferredSpendEvidence(
  request: DeferredSpendEvidenceRequest,
  dependencies: DeferredSpendReadOnlyDependencies,
): Promise<DeferredSpendEvidenceResult> {
  const wanted = requestSchema.safeParse(request);
  if (!wanted.success) return unknownResult(`invalid expected identity/request: ${wanted.error.message}`);
  const frozen = freeze(wanted.data);
  try {
    return await dependencies.withSnapshot(frozen.expectedIdentity, async (snapshot) => {
      const actual = deferredSpendEvidenceIdentitySchema.safeParse(snapshot.identity);
      if (!actual.success || deferredSpendFingerprint(actual.data) !== deferredSpendFingerprint(frozen.expectedIdentity)) {
        return unknownResult('read-only snapshot identity does not match the requested identity');
      }
      const slices: unknown[] = [];
      for (const id of frozen.requiredSlices) {
        try {
          slices.push(await snapshot.readSlice(id));
        } catch {
          // This slice is absent, not a fabricated empty/zero observation.
          slices.push(undefined);
        }
      }
      return evaluateDeferredSpendEvidence(frozen, { identity: actual.data, slices });
    });
  } catch {
    return unknownResult('consistent read-only snapshot could not be read');
  }
}
