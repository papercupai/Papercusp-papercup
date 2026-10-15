/**
 * DAO HR contract-template registry and the binding gate (dao-hr-people-2026-10-11 P-001, R-5).
 *
 * A contract is generated ONLY from a registered template version — there is no API that
 * accepts free contract text (SPEC-P-001-A). A version's content hash covers its body and
 * declared merge fields, and is re-checked at generation time, so a version altered behind
 * the writer's back is refused rather than rendered.
 *
 * Counsel approval (D-006) is recorded per version and PINS the content hash it approved
 * (SPEC-P-001-F). It applies only while the version still has that hash: editing an
 * approved version silently drops it back to unapproved (SPEC-P-001-C).
 *
 * The binding gate: a generated contract is eligible to bind only when its template version
 * carries an applying counsel approval AND the DAO has a formed issuing entity. Anything else
 * is stamped "Non-binding sample" in the document itself and in the result (SPEC-P-001,
 * SPEC-P-001-B). Whether a signed contract actually binds is decided later by the hire
 * proposal (D-007, P-006/P-007) — this gate is the necessary floor, never sufficient.
 *
 * Admin actions — template edits, counsel approvals, the issuing-entity record — require the
 * actor to be on the DAO's HR admin roster (SPEC-P-001-E, D-012). The actor is a PER- person
 * id resolved by the calling surface from its authenticated principal.
 *
 * Sample templates ship with the product, are labelled as samples and can never be approved.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { PERSON_DATATYPE, getCanonicalEntity } from '../relationship-graph/resolver';
import { SAMPLE_CONTRACT_TEMPLATES } from './contract-template-samples';
import { ENGAGEMENT_TYPES, type EngagementType } from './work-profile';

export const DOCUMENT_KINDS = [
  'employment-agreement',
  'contractor-agreement',
  'ip-assignment',
  'equity-grant-agreement',
  'onboarding-forms-list',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** The stamp every non-bindable generated contract carries (D-006). */
export const NON_BINDING_STAMP = 'Non-binding sample';

export type NonBindingReason = 'template_unapproved' | 'template_is_sample' | 'no_formed_entity';

export type ContractTemplateErrorCode =
  | 'invalid_input'
  | 'not_admin'
  | 'person_missing'
  | 'template_missing'
  | 'template_exists'
  | 'template_tampered'
  | 'sample_not_approvable'
  | 'merge_value_missing'
  | 'merge_value_unexpected';

export class ContractTemplateError extends Error {
  readonly code: ContractTemplateErrorCode;
  constructor(code: ContractTemplateErrorCode, message: string) {
    super(message);
    this.name = 'ContractTemplateError';
    this.code = code;
  }
}

function fail(code: ContractTemplateErrorCode, message: string): never {
  throw new ContractTemplateError(code, message);
}

// ─── Pure core ───────────────────────────────────────────────────────────────

const MERGE_FIELD = /^[a-z][a-z0-9_]{0,63}$/;
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** The merge-field names a template body references, in first-use order. */
export function placeholdersOf(body: string): string[] {
  const seen: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    if (!MERGE_FIELD.test(name)) fail('invalid_input', `placeholder {{${name}}} is not a valid merge-field name`);
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** Validate a body against its declared merge fields; returns the sorted field list. */
export function validateTemplateContent(body: unknown, mergeFields: unknown): { body: string; mergeFields: string[] } {
  if (typeof body !== 'string' || body.trim().length === 0) fail('invalid_input', 'body is required');
  if (body.length > 200_000) fail('invalid_input', 'body exceeds 200000 characters');
  if (!Array.isArray(mergeFields) || mergeFields.some((f) => typeof f !== 'string' || !MERGE_FIELD.test(f))) {
    fail('invalid_input', 'mergeFields must be an array of lower_snake_case names');
  }
  const declared = [...new Set(mergeFields as string[])].sort();
  if (declared.length !== mergeFields.length) fail('invalid_input', 'mergeFields contains a duplicate');
  const used = placeholdersOf(body).sort();
  const undeclared = used.filter((f) => !declared.includes(f));
  const unused = declared.filter((f) => !used.includes(f));
  if (undeclared.length > 0) fail('invalid_input', `body uses undeclared merge field(s): ${undeclared.join(', ')}`);
  if (unused.length > 0) fail('invalid_input', `declared merge field(s) not used in body: ${unused.join(', ')}`);
  return { body, mergeFields: declared };
}

/** Content hash of a template version: body + sorted merge fields, canonically encoded. */
export function templateContentHash(body: string, mergeFields: readonly string[]): string {
  const canonical = JSON.stringify({ body, mergeFields: [...mergeFields].sort() });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** Fill every placeholder. Every declared field must be supplied and nothing else may be. */
export function renderTemplate(body: string, mergeFields: readonly string[], values: Record<string, unknown>): string {
  if (values === null || typeof values !== 'object' || Array.isArray(values)) fail('invalid_input', 'values must be an object');
  const unexpected = Object.keys(values).filter((k) => !mergeFields.includes(k));
  if (unexpected.length > 0) fail('merge_value_unexpected', `no merge field named ${unexpected.join(', ')}`);
  for (const field of mergeFields) {
    const value = values[field];
    if (typeof value !== 'string' || value.trim().length === 0) fail('merge_value_missing', `merge field ${field} needs a value`);
  }
  return body.replace(PLACEHOLDER, (_whole, name: string) => String(values[name]));
}

export interface CounselApprovalInput {
  approverRef: unknown;
  approvedOn: unknown;
  reference: unknown;
}

export interface CounselApprovalRecord {
  templateKey: string;
  version: number;
  /** The content hash of the exact version approved (SPEC-P-001-F). */
  contentHash: string;
  approverRef: string;
  approvedOn: string;
  reference: string;
}

function isoDate(field: string, value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('invalid_input', `${field} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('invalid_input', `${field} ${value} is not a calendar date`);
  }
  return value;
}

function text(field: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail('invalid_input', `${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) fail('invalid_input', `${field} exceeds ${max} characters`);
  return trimmed;
}

/**
 * The approval record for `version`. Refuses a missing approver, date or reference
 * (SPEC-P-001-D) and binds the record to the version's content hash (SPEC-P-001-F).
 */
export function buildCounselApprovalRecord(
  version: { templateKey: string; version: number; contentHash: string },
  input: CounselApprovalInput,
): CounselApprovalRecord {
  return {
    templateKey: version.templateKey,
    version: version.version,
    contentHash: version.contentHash,
    approverRef: text('approverRef', input.approverRef, 300),
    approvedOn: isoDate('approvedOn', input.approvedOn),
    reference: text('reference', input.reference, 300),
  };
}

/** An approval applies only to the exact content it approved (SPEC-P-001-C). */
export function approvalApplies(approval: { contentHash: string } | null, currentContentHash: string): boolean {
  return approval !== null && approval.contentHash === currentContentHash;
}

export interface BindingGateInput {
  isSample: boolean;
  /** True when an approval whose hash matches the version's CURRENT hash exists. */
  counselApproved: boolean;
  entityFormed: boolean;
}

export interface BindingGateResult {
  bindingEligible: boolean;
  stamp: typeof NON_BINDING_STAMP | null;
  reasons: NonBindingReason[];
}

/** The D-006 gate: bindable only from an approved, non-sample template issued by a formed entity. */
export function bindingGate(input: BindingGateInput): BindingGateResult {
  const reasons: NonBindingReason[] = [];
  if (input.isSample) reasons.push('template_is_sample');
  if (!input.counselApproved) reasons.push('template_unapproved');
  if (!input.entityFormed) reasons.push('no_formed_entity');
  const bindingEligible = reasons.length === 0;
  return { bindingEligible, stamp: bindingEligible ? null : NON_BINDING_STAMP, reasons };
}

const REASON_TEXT: Record<NonBindingReason, string> = {
  template_is_sample: 'generated from a sample template',
  template_unapproved: 'the template version has no counsel approval',
  no_formed_entity: 'no issuing entity has been formed',
};

/** Prefix a rendered document with the stamp when the gate says it cannot bind. */
export function stampDocument(rendered: string, gate: BindingGateResult): string {
  if (gate.bindingEligible) return rendered;
  const why = gate.reasons.map((r) => REASON_TEXT[r]).join('; ');
  return `${NON_BINDING_STAMP.toUpperCase()} — ${NON_BINDING_STAMP}: ${why}. This document is not a binding agreement.\n\n${rendered}`;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export interface ContractTemplateDeps {
  sql?: Sql;
  now?: () => Date;
}

function db(deps: ContractTemplateDeps): Sql {
  return deps.sql ?? getOrgPg().sql;
}

export interface DaoKey {
  workspaceId: string;
  daoSlug: string;
}

function validDao(key: DaoKey): DaoKey {
  return { workspaceId: text('workspaceId', key.workspaceId, 200), daoSlug: text('daoSlug', key.daoSlug, 200) };
}

async function isAdmin(sql: Sql, key: DaoKey, personId: string): Promise<boolean> {
  const [row] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM harness_shared.dao_hr_admins
     WHERE workspace_id = ${key.workspaceId} AND dao_slug = ${key.daoSlug} AND person_id = ${personId}`;
  return row!.n > 0;
}

/** Resolve `actorPersonId` to its canonical person and require it on the DAO's HR admin roster. */
async function requireAdmin(sql: Sql, key: DaoKey, actorPersonId: unknown): Promise<string> {
  const raw = text('actorPersonId', actorPersonId, 200);
  const person = await getCanonicalEntity(sql, key.workspaceId, PERSON_DATATYPE, raw);
  if (!person || !(await isAdmin(sql, key, person.id))) {
    fail('not_admin', `${raw} is not an HR admin of DAO ${key.daoSlug}`);
  }
  return person.id;
}

/** True when `personId` is on the DAO's HR admin roster. */
export async function isDaoHrAdmin(key: DaoKey & { personId: string }, deps: ContractTemplateDeps = {}): Promise<boolean> {
  const sql = db(deps);
  const dao = validDao(key);
  const person = await getCanonicalEntity(sql, dao.workspaceId, PERSON_DATATYPE, text('personId', key.personId, 200));
  return person !== null && (await isAdmin(sql, dao, person.id));
}

/**
 * Add a person to the DAO's HR admin roster. `grantedBy` must already be an admin, except
 * for the very first admin of a DAO, which only an operator surface may seed — it passes
 * `bootstrapOperator` (its own principal id), and the call is refused once a roster exists.
 */
export async function grantDaoHrAdmin(
  input: DaoKey & { personId: string; grantedBy?: string; bootstrapOperator?: string },
  deps: ContractTemplateDeps = {},
): Promise<{ personId: string; grantedBy: string }> {
  const sql = db(deps);
  const key = validDao(input);
  const person = await getCanonicalEntity(sql, key.workspaceId, PERSON_DATATYPE, text('personId', input.personId, 200));
  if (!person) fail('person_missing', `${input.personId} has no shared person record`);
  let grantedBy: string;
  if (input.bootstrapOperator !== undefined) {
    const operator = text('bootstrapOperator', input.bootstrapOperator, 200);
    const [row] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.dao_hr_admins
       WHERE workspace_id = ${key.workspaceId} AND dao_slug = ${key.daoSlug}`;
    if (row!.n > 0) fail('not_admin', `DAO ${key.daoSlug} already has HR admins; an existing admin must grant`);
    grantedBy = `operator:${operator}`;
  } else {
    grantedBy = await requireAdmin(sql, key, input.grantedBy);
  }
  await sql`
    INSERT INTO harness_shared.dao_hr_admins (workspace_id, dao_slug, person_id, granted_by)
    VALUES (${key.workspaceId}, ${key.daoSlug}, ${person.id}, ${grantedBy})
    ON CONFLICT DO NOTHING`;
  return { personId: person.id, grantedBy };
}

// ── Issuing entity ──

export interface IssuingEntity {
  registeredTitle: string;
  jurisdiction: string;
  registrationReference: string;
  formedOn: string;
  recordedBy: string;
}

/** Record the formed company this DAO issues binding contracts from (admin only). */
export async function recordIssuingEntity(
  input: DaoKey & {
    registeredTitle: unknown;
    jurisdiction: unknown;
    registrationReference: unknown;
    formedOn: unknown;
    actorPersonId: string;
  },
  deps: ContractTemplateDeps = {},
): Promise<IssuingEntity> {
  const sql = db(deps);
  const key = validDao(input);
  const recordedBy = await requireAdmin(sql, key, input.actorPersonId);
  const entity: IssuingEntity = {
    registeredTitle: text('registeredTitle', input.registeredTitle, 300),
    jurisdiction: text('jurisdiction', input.jurisdiction, 64),
    registrationReference: text('registrationReference', input.registrationReference, 300),
    formedOn: isoDate('formedOn', input.formedOn),
    recordedBy,
  };
  if (entity.jurisdiction.length < 2) fail('invalid_input', 'jurisdiction must be at least 2 characters');
  await sql`
    INSERT INTO harness_shared.dao_hr_issuing_entities
      (workspace_id, dao_slug, registered_title, jurisdiction, registration_reference, formed_on, recorded_by)
    VALUES (${key.workspaceId}, ${key.daoSlug}, ${entity.registeredTitle}, ${entity.jurisdiction},
            ${entity.registrationReference}, ${entity.formedOn}::date, ${recordedBy})
    ON CONFLICT (workspace_id, dao_slug) DO UPDATE SET
      registered_title = EXCLUDED.registered_title, jurisdiction = EXCLUDED.jurisdiction,
      registration_reference = EXCLUDED.registration_reference, formed_on = EXCLUDED.formed_on,
      recorded_by = EXCLUDED.recorded_by, recorded_at = now()`;
  return entity;
}

export async function getIssuingEntity(key: DaoKey, deps: ContractTemplateDeps = {}): Promise<IssuingEntity | null> {
  const sql = db(deps);
  const dao = validDao(key);
  const [row] = await sql<Array<{ registered_title: string; jurisdiction: string; registration_reference: string; formed_on: string; recorded_by: string }>>`
    SELECT registered_title, jurisdiction, registration_reference, to_char(formed_on, 'YYYY-MM-DD') AS formed_on, recorded_by
      FROM harness_shared.dao_hr_issuing_entities
     WHERE workspace_id = ${dao.workspaceId} AND dao_slug = ${dao.daoSlug}`;
  return row
    ? {
        registeredTitle: row.registered_title,
        jurisdiction: row.jurisdiction,
        registrationReference: row.registration_reference,
        formedOn: row.formed_on,
        recordedBy: row.recorded_by,
      }
    : null;
}

// ── Templates and versions ──

export interface ContractTemplate {
  templateKey: string;
  documentKind: DocumentKind;
  engagementType: EngagementType;
  jurisdiction: string;
  title: string;
  isSample: boolean;
}

export interface TemplateVersion {
  templateKey: string;
  version: number;
  body: string;
  mergeFields: string[];
  contentHash: string;
}

const KIND_ENGAGEMENT: Partial<Record<DocumentKind, EngagementType>> = {
  'employment-agreement': 'employee',
  'contractor-agreement': 'contractor',
};

function validTemplateShape(input: {
  templateKey: unknown;
  documentKind: unknown;
  engagementType: unknown;
  jurisdiction: unknown;
  title: unknown;
}): Omit<ContractTemplate, 'isSample'> {
  const templateKey = text('templateKey', input.templateKey, 120);
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(templateKey)) fail('invalid_input', 'templateKey must be lower-kebab-case');
  if (!DOCUMENT_KINDS.includes(input.documentKind as DocumentKind)) {
    fail('invalid_input', `documentKind must be one of ${DOCUMENT_KINDS.join(', ')}`);
  }
  if (!ENGAGEMENT_TYPES.includes(input.engagementType as EngagementType)) {
    fail('invalid_input', `engagementType must be one of ${ENGAGEMENT_TYPES.join(', ')}`);
  }
  const documentKind = input.documentKind as DocumentKind;
  const engagementType = input.engagementType as EngagementType;
  const only = KIND_ENGAGEMENT[documentKind];
  if (only && only !== engagementType) fail('invalid_input', `${documentKind} applies only to ${only} engagements`);
  const jurisdiction = text('jurisdiction', input.jurisdiction, 64);
  if (jurisdiction.length < 2) fail('invalid_input', 'jurisdiction must be at least 2 characters');
  return { templateKey, documentKind, engagementType, jurisdiction, title: text('title', input.title, 200) };
}

async function insertTemplate(sql: Sql, key: DaoKey, template: ContractTemplate, createdBy: string): Promise<boolean> {
  const rows = await sql`
    INSERT INTO harness_shared.dao_hr_contract_templates
      (workspace_id, dao_slug, template_key, document_kind, engagement_type, jurisdiction, title, is_sample, created_by)
    VALUES (${key.workspaceId}, ${key.daoSlug}, ${template.templateKey}, ${template.documentKind},
            ${template.engagementType}, ${template.jurisdiction}, ${template.title}, ${template.isSample}, ${createdBy})
    ON CONFLICT DO NOTHING
    RETURNING template_key`;
  return rows.length > 0;
}

async function insertVersion(sql: Sql, key: DaoKey, templateKey: string, version: number, content: { body: string; mergeFields: string[] }, createdBy: string): Promise<TemplateVersion> {
  const contentHash = templateContentHash(content.body, content.mergeFields);
  await sql`
    INSERT INTO harness_shared.dao_hr_contract_template_versions
      (workspace_id, dao_slug, template_key, version, body, merge_fields, content_hash, created_by)
    VALUES (${key.workspaceId}, ${key.daoSlug}, ${templateKey}, ${version}, ${content.body},
            ${sql.json(content.mergeFields)}, ${contentHash}, ${createdBy})`;
  return { templateKey, version, body: content.body, mergeFields: content.mergeFields, contentHash };
}

/** Register a template and its first version (admin only). Version 1 is returned. */
export async function createContractTemplate(
  input: DaoKey & {
    templateKey: unknown;
    documentKind: unknown;
    engagementType: unknown;
    jurisdiction: unknown;
    title: unknown;
    body: unknown;
    mergeFields: unknown;
    actorPersonId: string;
  },
  deps: ContractTemplateDeps = {},
): Promise<{ template: ContractTemplate; version: TemplateVersion }> {
  const sql = db(deps);
  const key = validDao(input);
  const actor = await requireAdmin(sql, key, input.actorPersonId);
  const template: ContractTemplate = { ...validTemplateShape(input), isSample: false };
  const content = validateTemplateContent(input.body, input.mergeFields);
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    if (!(await insertTemplate(t, key, template, actor))) {
      fail('template_exists', `template ${template.templateKey} or its document slot already exists in DAO ${key.daoSlug}`);
    }
    return { template, version: await insertVersion(t, key, template.templateKey, 1, content, actor) };
  }) as Promise<{ template: ContractTemplate; version: TemplateVersion }>;
}

interface TemplateRow {
  template_key: string;
  document_kind: DocumentKind;
  engagement_type: EngagementType;
  jurisdiction: string;
  title: string;
  is_sample: boolean;
}

function toTemplate(row: TemplateRow): ContractTemplate {
  return {
    templateKey: row.template_key,
    documentKind: row.document_kind,
    engagementType: row.engagement_type,
    jurisdiction: row.jurisdiction,
    title: row.title,
    isSample: row.is_sample,
  };
}

async function readTemplate(sql: Sql, key: DaoKey, templateKey: string): Promise<ContractTemplate | null> {
  const [row] = await sql<TemplateRow[]>`
    SELECT template_key, document_kind, engagement_type, jurisdiction, title, is_sample
      FROM harness_shared.dao_hr_contract_templates
     WHERE workspace_id = ${key.workspaceId} AND dao_slug = ${key.daoSlug} AND template_key = ${templateKey}`;
  return row ? toTemplate(row) : null;
}

interface VersionRow {
  template_key: string;
  version: number;
  body: string;
  merge_fields: string[];
  content_hash: string;
}

async function readVersion(sql: Sql, key: DaoKey, templateKey: string, version: number): Promise<TemplateVersion | null> {
  const [row] = await sql<VersionRow[]>`
    SELECT template_key, version, body, merge_fields, content_hash
      FROM harness_shared.dao_hr_contract_template_versions
     WHERE workspace_id = ${key.workspaceId} AND dao_slug = ${key.daoSlug}
       AND template_key = ${templateKey} AND version = ${version}`;
  return row
    ? { templateKey: row.template_key, version: row.version, body: row.body, mergeFields: row.merge_fields, contentHash: row.content_hash }
    : null;
}

function validVersionNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) fail('invalid_input', 'version must be a positive integer');
  return value;
}

/**
 * Save template content (admin only). Without `version` a new version is added; with one,
 * that version's content is replaced and its hash recomputed — which is exactly what makes a
 * prior counsel approval stop applying (SPEC-P-001-C). Sample templates are not editable.
 */
export async function saveTemplateVersion(
  input: DaoKey & { templateKey: string; version?: number; body: unknown; mergeFields: unknown; actorPersonId: string },
  deps: ContractTemplateDeps = {},
): Promise<TemplateVersion> {
  const sql = db(deps);
  const key = validDao(input);
  const actor = await requireAdmin(sql, key, input.actorPersonId);
  const templateKey = text('templateKey', input.templateKey, 120);
  const template = await readTemplate(sql, key, templateKey);
  if (!template) fail('template_missing', `no template ${templateKey} in DAO ${key.daoSlug}`);
  if (template.isSample) fail('invalid_input', `${templateKey} is a shipped sample template and is not editable`);
  const content = validateTemplateContent(input.body, input.mergeFields);
  const now = (deps.now ?? (() => new Date()))();
  if (input.version === undefined) {
    const [row] = await sql<Array<{ next: number }>>`
      SELECT coalesce(max(version), 0) + 1 AS next FROM harness_shared.dao_hr_contract_template_versions
       WHERE workspace_id = ${key.workspaceId} AND dao_slug = ${key.daoSlug} AND template_key = ${templateKey}`;
    return insertVersion(sql, key, templateKey, row!.next, content, actor);
  }
  const version = validVersionNumber(input.version);
  const contentHash = templateContentHash(content.body, content.mergeFields);
  const rows = await sql`
    UPDATE harness_shared.dao_hr_contract_template_versions
       SET body = ${content.body}, merge_fields = ${sql.json(content.mergeFields)},
           content_hash = ${contentHash}, updated_at = ${now}
     WHERE workspace_id = ${key.workspaceId} AND dao_slug = ${key.daoSlug}
       AND template_key = ${templateKey} AND version = ${version}
    RETURNING version`;
  if (rows.length === 0) fail('template_missing', `${templateKey} has no version ${version}`);
  return { templateKey, version, body: content.body, mergeFields: content.mergeFields, contentHash };
}

export interface StoredCounselApproval extends CounselApprovalRecord {
  recordedBy: string;
  recordedAt: string;
}

/**
 * Record counsel's approval of one template version (admin only). Refuses a missing
 * approver, date or reference (SPEC-P-001-D), a non-admin actor (SPEC-P-001-E) and a sample
 * template; the stored record carries the version's current content hash (SPEC-P-001-F).
 */
export async function recordCounselApproval(
  input: DaoKey & { templateKey: string; version: number; actorPersonId: string } & CounselApprovalInput,
  deps: ContractTemplateDeps = {},
): Promise<StoredCounselApproval> {
  const sql = db(deps);
  const key = validDao(input);
  const recordedBy = await requireAdmin(sql, key, input.actorPersonId);
  const templateKey = text('templateKey', input.templateKey, 120);
  const template = await readTemplate(sql, key, templateKey);
  if (!template) fail('template_missing', `no template ${templateKey} in DAO ${key.daoSlug}`);
  if (template.isSample) fail('sample_not_approvable', `${templateKey} is a shipped sample and can never be counsel-approved`);
  const version = await readVersion(sql, key, templateKey, validVersionNumber(input.version));
  if (!version) fail('template_missing', `${templateKey} has no version ${input.version}`);
  const record = buildCounselApprovalRecord(version, input);
  const [row] = await sql<Array<{ recorded_at: Date }>>`
    INSERT INTO harness_shared.dao_hr_counsel_approvals
      (workspace_id, dao_slug, template_key, version, content_hash, approver_ref, approved_on, reference, recorded_by)
    VALUES (${key.workspaceId}, ${key.daoSlug}, ${record.templateKey}, ${record.version}, ${record.contentHash},
            ${record.approverRef}, ${record.approvedOn}::date, ${record.reference}, ${recordedBy})
    RETURNING recorded_at`;
  return { ...record, recordedBy, recordedAt: row!.recorded_at.toISOString() };
}

/** The newest approval of `version` whose hash still matches its current content, if any. */
async function applyingApproval(sql: Sql, key: DaoKey, version: TemplateVersion): Promise<StoredCounselApproval | null> {
  const [row] = await sql<Array<{ approver_ref: string; approved_on: string; reference: string; content_hash: string; recorded_by: string; recorded_at: Date }>>`
    SELECT approver_ref, to_char(approved_on, 'YYYY-MM-DD') AS approved_on, reference, content_hash, recorded_by, recorded_at
      FROM harness_shared.dao_hr_counsel_approvals
     WHERE workspace_id = ${key.workspaceId} AND dao_slug = ${key.daoSlug}
       AND template_key = ${version.templateKey} AND version = ${version.version}
     ORDER BY recorded_at DESC, id DESC`
    .then((rows) => rows.filter((r) => approvalApplies({ contentHash: r.content_hash }, version.contentHash)));
  return row
    ? {
        templateKey: version.templateKey,
        version: version.version,
        contentHash: row.content_hash,
        approverRef: row.approver_ref,
        approvedOn: row.approved_on,
        reference: row.reference,
        recordedBy: row.recorded_by,
        recordedAt: row.recorded_at.toISOString(),
      }
    : null;
}

export interface TemplateVersionStatus {
  template: ContractTemplate;
  version: TemplateVersion;
  /** The approval that applies to the version's CURRENT content, or null. */
  approval: StoredCounselApproval | null;
  counselApproved: boolean;
}

/** A version with its counsel-approval status. */
export async function getTemplateVersionStatus(
  input: DaoKey & { templateKey: string; version: number },
  deps: ContractTemplateDeps = {},
): Promise<TemplateVersionStatus> {
  const sql = db(deps);
  const key = validDao(input);
  const templateKey = text('templateKey', input.templateKey, 120);
  const template = await readTemplate(sql, key, templateKey);
  if (!template) fail('template_missing', `no template ${templateKey} in DAO ${key.daoSlug}`);
  const version = await readVersion(sql, key, templateKey, validVersionNumber(input.version));
  if (!version) fail('template_missing', `${templateKey} has no version ${input.version}`);
  const approval = await applyingApproval(sql, key, version);
  return { template, version, approval, counselApproved: approval !== null };
}

/** Every template registered for a DAO, newest version number included. */
export async function listContractTemplates(key: DaoKey, deps: ContractTemplateDeps = {}): Promise<Array<ContractTemplate & { latestVersion: number }>> {
  const sql = db(deps);
  const dao = validDao(key);
  const rows = await sql<Array<TemplateRow & { latest_version: number }>>`
    SELECT t.template_key, t.document_kind, t.engagement_type, t.jurisdiction, t.title, t.is_sample,
           max(v.version)::int AS latest_version
      FROM harness_shared.dao_hr_contract_templates t
      JOIN harness_shared.dao_hr_contract_template_versions v USING (workspace_id, dao_slug, template_key)
     WHERE t.workspace_id = ${dao.workspaceId} AND t.dao_slug = ${dao.daoSlug}
     GROUP BY t.template_key, t.document_kind, t.engagement_type, t.jurisdiction, t.title, t.is_sample
     ORDER BY t.document_kind, t.engagement_type, t.jurisdiction, t.is_sample`;
  return rows.map((row) => ({ ...toTemplate(row), latestVersion: row.latest_version }));
}

/** Install the shipped, clearly labelled sample templates for a DAO (admin only; idempotent). */
export async function installSampleTemplates(
  input: DaoKey & { actorPersonId: string },
  deps: ContractTemplateDeps = {},
): Promise<{ installed: string[] }> {
  const sql = db(deps);
  const key = validDao(input);
  const actor = await requireAdmin(sql, key, input.actorPersonId);
  const installed: string[] = [];
  for (const sample of SAMPLE_CONTRACT_TEMPLATES) {
    const template: ContractTemplate = { ...validTemplateShape(sample), isSample: true };
    const content = validateTemplateContent(sample.body, sample.mergeFields);
    await sql.begin(async (tx) => {
      const t = tx as unknown as Sql;
      if (await insertTemplate(t, key, template, actor)) {
        await insertVersion(t, key, template.templateKey, 1, content, actor);
        installed.push(template.templateKey);
      }
    });
  }
  return { installed };
}

// ── Generation ──

export interface GeneratedContract extends BindingGateResult {
  templateKey: string;
  version: number;
  contentHash: string;
  documentKind: DocumentKind;
  engagementType: EngagementType;
  jurisdiction: string;
  /** The rendered document, stamped when it cannot bind. */
  document: string;
  issuingEntity: IssuingEntity | null;
}

/**
 * Render a contract from a registered template version. There is no way to pass contract
 * text: an unregistered template or version is refused (SPEC-P-001-A), and so is a version
 * whose stored content no longer matches its recorded hash. The result carries the binding
 * gate's verdict and, when not bindable, the "Non-binding sample" stamp (SPEC-P-001/-B).
 */
export async function generateContract(
  input: DaoKey & { templateKey: string; version: number; values: Record<string, unknown> },
  deps: ContractTemplateDeps = {},
): Promise<GeneratedContract> {
  const sql = db(deps);
  const key = validDao(input);
  const status = await getTemplateVersionStatus(input, { ...deps, sql });
  const { template, version } = status;
  if (templateContentHash(version.body, version.mergeFields) !== version.contentHash) {
    fail('template_tampered', `${template.templateKey} v${version.version} no longer matches its recorded content hash`);
  }
  const entity = await getIssuingEntity(key, { ...deps, sql });
  const gate = bindingGate({ isSample: template.isSample, counselApproved: status.counselApproved, entityFormed: entity !== null });
  const rendered = renderTemplate(version.body, version.mergeFields, input.values);
  return {
    ...gate,
    templateKey: template.templateKey,
    version: version.version,
    contentHash: version.contentHash,
    documentKind: template.documentKind,
    engagementType: template.engagementType,
    jurisdiction: template.jurisdiction,
    document: stampDocument(rendered, gate),
    issuingEntity: entity,
  };
}
