/** D300/D303: compare normal proof-verified cores to independently resolved custody. */
import { basename } from 'node:path';
import type { AuthorityRpcAuth } from '../../../../packages/operator-core/lib/authority/authority-rpc-envelope';
import { verifyAuthorityRpc } from '../../../../packages/operator-core/lib/authority/authority-rpc-envelope';
import type { PhysicalDrillHostIdentity } from '../../../../packages/operator-core/lib/sync/pot-git/physical-drill-host-receipt';
import {
  signedSeedSource, sourceSpanRecorder, seedSnapshotValueTransform, SEED_EXCLUDED_TABLES,
  type exportSeedUuidIdempotencySource, type SeedFrozenExecution, type SeedSourceInput, type SeedUuidIdempotencyDropPlan,
} from '../../../../packages/operator-core/lib/sync/hyperbee/seed-provider-corestore';
import { SEED_EXECUTION_PATHS } from '../../../../packages/operator-core/lib/sync/hyperbee/seed-frozen-execution';
import { foldFilteredSnapshotRows, governorReceiptSnapshotValueTransform, isSnapshotOp, DROP_SNAPSHOT_ROW, type SnapshotRow } from '../../../../packages/operator-core/lib/sync/hyperbee/log-snapshot';
import { readCoreProjectedFrom } from '../../../../packages/operator-core/lib/sync/hyperbee/seed-projection-meta';
import { composeEngineerIssueKey } from '../../../../packages/operator-core/lib/sync/hyperbee/feature-issue-op-keys';
import { judgeSeedPayloadIntegrity } from './seed-payload-integrity-guard';
import {
  P521_PLAN, bindOriginal, evidenceObject, originalSha256, requireEvidence, sameEvidence,
  validateP521Subject, withoutEvidenceField,
  type P521Subject, type EndgameRawOriginal, type OriginalPin, type P521QualificationReport,
} from './p521-qualification-evidence';

type Core = Parameters<typeof signedSeedSource>[0];
type SourceExport = Awaited<ReturnType<typeof exportSeedUuidIdempotencySource>>;
type Payload = Pick<Parameters<typeof judgeSeedPayloadIntegrity>[0], 'manifest' | 'dir' | 'origin'>;
export interface P521SeedPrivacy { literals: readonly string[]; uuidDropPlan?: SeedUuidIdempotencyDropPlan }
export interface P521PgCensus {
  workspaceId: string; harnessSlug: string; snapshotId: string; capturedAtMs: number;
  maxSourceIndexExclusive: number; liveWorkItemKeys: readonly string[]; liveGovernorQualifiedKeys: readonly string[];
  raw: EndgameRawOriginal; auth: AuthorityRpcAuth;
}
export interface P521SeedCustody {
  subject: P521Subject; workspaceId: string; harnessSlug: string; planSlug: string;
  sourceHost: PhysicalDrillHostIdentity; cutWindow: { startMs: number; endMs: number };
  executionBinding: SeedFrozenExecution; privacy: P521SeedPrivacy; sourceHead: SeedSourceInput['sourceHead'];
  originalInventory: readonly OriginalPin[];
}
export interface P521SeedPopulationDeps {
  resolveCustody(subject: P521Subject): P521SeedCustody | null;
  resolveOriginal(ref: string): EndgameRawOriginal | null;
}
export interface P521SeedPopulationInput {
  subject: P521Subject; source: SourceExport; sourceCore: Core; restoredCore: Core; restoredKeyHex: string;
  payload: Payload; manifestBytes: EndgameRawOriginal; pg: P521PgCensus; privacy: P521SeedPrivacy; custody: EndgameRawOriginal;
}
const key = (row: SnapshotRow) => JSON.stringify([row.table, row.hbKey]);
function population(rows: readonly SnapshotRow[]): readonly SnapshotRow[] {
  requireEvidence(new Set(rows.map(key)).size === rows.length, 'duplicate table/key in seed population');
  return [...rows].sort((a, b) => key(a).localeCompare(key(b)));
}
/** Folding deliberately coalesces repeated keys and tolerates old torn sets.
 * A freshly restored acceptance population must prove its raw snapshot census
 * before that lossy normalization, using the same proof-verified log handle. */
async function restoredSnapshotCensus(log: Awaited<ReturnType<typeof signedSeedSource>>['log']): Promise<void> {
  for (let index = 0; index < log.length; index++) {
    const op = await log.get(index);
    if (!isSnapshotOp(op)) continue;
    const first = evidenceObject(op?.value);
    const count = Number(first.chunkCount ?? 1);
    requireEvidence(Number.isSafeInteger(count) && count > 0 && Number(first.chunkIdx ?? 0) === 0
      && first.coversUpTo === index && index + count <= log.length, 'restored snapshot set torn or misplaced');
    const keys = new Set<string>();
    for (let chunk = 0; chunk < count; chunk++) {
      const part = chunk === 0 ? op : await log.get(index + chunk);
      requireEvidence(isSnapshotOp(part), 'restored snapshot chunk missing');
      const value = evidenceObject(part?.value);
      requireEvidence(Number(value.chunkIdx ?? 0) === chunk && Number(value.chunkCount ?? 1) === count
        && value.coversUpTo === index && part?.ts === op?.ts && Array.isArray(value.rows), 'restored snapshot chunk binding differs');
      for (const raw of value.rows) {
        const row = evidenceObject(raw);
        const id = JSON.stringify([row.table, row.hbKey]);
        requireEvidence(typeof row.table === 'string' && typeof row.hbKey === 'string' && !keys.has(id), 'duplicate restored snapshot key');
        keys.add(id);
      }
    }
    index += count - 1;
  }
}
function execution(binding: SeedFrozenExecution, subject: P521Subject): void {
  requireEvidence(binding.gitDirty === false && binding.sourceCommit === subject.sourceSha
    && /^v\d+\-[0-9a-f]{64}$/.test(binding.dependencyGeneration) && binding.nodeVersion
    && ['dependencyInputSha256', 'installedPackagesSha256', 'dependencyGenerationSnapshotSha256', 'materializedTreesSha256']
      .every(k => /^[0-9a-f]{64}$/.test(String(Reflect.get(binding, k))))
    && binding.installedPackages.length > 0 && binding.loadedModulePaths.length > 0
    && binding.excludedEntryCount === binding.excludedEntries.length, 'complete clean execution binding missing');
  requireEvidence(sameEvidence(binding.directBlobs.map(b => b.path).sort(), [...SEED_EXECUTION_PATHS].sort())
    && binding.directBlobs.every(b => /^[0-9a-f]{64}$/.test(b.sha256))
    && originalSha256(JSON.stringify(binding.installedPackages)) === binding.installedPackagesSha256,
    'loaded direct-source/dependency census differs');
  for (const name of ['hypercore', 'hyperbee', 'hypercore-crypto', 'sodium-native', 'sodium-universal']) {
    requireEvidence(binding.securityPackages.some(p => p.name === name && p.files.length > 0
      && p.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256)) && p.integrity && p.resolved), 'complete security dependency census missing');
  }
}

export async function verifyP521SeedPopulation(input: P521SeedPopulationInput, deps: P521SeedPopulationDeps): Promise<P521QualificationReport> {
  try {
    validateP521Subject(input.subject);
    const custody = deps.resolveCustody(input.subject);
    requireEvidence(custody && custody.planSlug === P521_PLAN && custody.workspaceId && custody.harnessSlug
      && sameEvidence(input.subject, custody.subject) && sameEvidence(input.privacy, custody.privacy)
      && sameEvidence(input.source.sourceInput.sourceHead, custody.sourceHead), 'independent seed custody missing or mismatched');
    requireEvidence(new Set(custody.originalInventory.map(p => p.ref)).size === custody.originalInventory.length,
      'seed original inventory duplicated');
    const root = JSON.parse(bindOriginal(input.custody, deps.resolveOriginal).toString('utf8'));
    requireEvidence(sameEvidence(root, custody) && !custody.originalInventory.some(p => p.ref === input.custody.ref), 'seed custody root differs or is circular');
    const bytes = bindOriginal(input.manifestBytes, deps.resolveOriginal, custody.originalInventory);
    requireEvidence(originalSha256(bytes) === input.subject.seedSha256 && sameEvidence(JSON.parse(bytes.toString('utf8')), input.payload.manifest), 'exact candidate manifest bytes differ');
    const integrity = await judgeSeedPayloadIntegrity({ manifest: input.payload.manifest, dir: input.payload.dir, origin: input.payload.origin });
    requireEvidence(integrity.ok, 'normal provider payload verification failed');
    execution(custody.executionBinding, input.subject);
    requireEvidence(sameEvidence(input.source.sourceInput.executionBinding, custody.executionBinding), 'seed loaded execution differs from independent original');
    const pg = input.pg, pgBody = withoutEvidenceField(pg, 'auth');
    const pgOriginal = evidenceObject(JSON.parse(bindOriginal(pg.raw, deps.resolveOriginal, custody.originalInventory).toString('utf8')));
    const fields = withoutEvidenceField(pgBody, 'raw');
    requireEvidence(sameEvidence(fields, withoutEvidenceField(pgOriginal, 'transaction'))
      && pg.workspaceId === custody.workspaceId && pg.harnessSlug === custody.harnessSlug && pg.snapshotId
      && Number.isSafeInteger(pg.capturedAtMs) && Number.isSafeInteger(custody.cutWindow.startMs) && Number.isSafeInteger(custody.cutWindow.endMs)
      && custody.cutWindow.startMs <= pg.capturedAtMs && pg.capturedAtMs <= custody.cutWindow.endMs
      && Number.isSafeInteger(pg.maxSourceIndexExclusive) && pg.maxSourceIndexExclusive >= 0
      && pg.maxSourceIndexExclusive <= custody.sourceHead.sourceLength
      && pg.auth.device_pubkey === custody.sourceHost.deviceKey
      && verifyAuthorityRpc({ harnessSlug: custody.harnessSlug, kind: 'p521-seed-pg-census/v1', payload: pgBody }, pg.auth, { nowMs: pg.capturedAtMs }),
      'PG census signature/scope/boundary/window differs');
    const transaction = evidenceObject(pgOriginal.transaction);
    requireEvidence(transaction.isolation === 'repeatable read' && transaction.readOnly === true && transaction.exitCode === 0
      && transaction.query === 'SELECT harness_slug, feature_id, payload FROM harness_shared.work_items WHERE workspace_id = $1 ORDER BY harness_slug, feature_id'
      && sameEvidence(transaction.parameters, [custody.workspaceId]) && Array.isArray(transaction.rows), 'complete read-only PG census query missing');
    const pgRows = (transaction.rows as unknown[]).map(evidenceObject);
    const qualified = (r: Record<string, unknown>) => {
      requireEvidence(typeof r.harness_slug === 'string' && r.harness_slug.length > 0
        && typeof r.feature_id === 'string' && r.feature_id.length > 0, 'PG census key identity invalid');
      return composeEngineerIssueKey(r.harness_slug, r.feature_id);
    };
    const keys = pgRows.map(qualified);
    const governors = pgRows.filter(r => r.payload != null && typeof r.payload === 'object' && Reflect.has(r.payload, 'resource_governor')).map(qualified);
    requireEvidence(keys.length > 0 && new Set(keys).size === keys.length
      && new Set(pg.liveWorkItemKeys).size === pg.liveWorkItemKeys.length
      && new Set(pg.liveGovernorQualifiedKeys).size === pg.liveGovernorQualifiedKeys.length
      && sameEvidence([...keys].sort(), [...pg.liveWorkItemKeys].sort())
      && sameEvidence(governors.sort(), [...pg.liveGovernorQualifiedKeys].sort()), 'independent PG key population differs');
    requireEvidence(input.source.sourceKeyHex === custody.sourceHead.sourceKeyHex && input.source.sourceLength === custody.sourceHead.sourceLength,
      'original source key/length differs');
    const context = input.source.privacyProjectionContext;
    requireEvidence(context.schema === 'papercusp-seed-privacy-projection-v1'
      && context.literalsSha256 === originalSha256(JSON.stringify(custody.privacy.literals))
      && context.excludedTablesSha256 === originalSha256(JSON.stringify([...SEED_EXCLUDED_TABLES].sort())), 'privacy projection inputs differ');
    const source = await signedSeedSource(input.sourceCore, input.source.sourceKeyHex, input.source.sourceLength);
    requireEvidence(sameEvidence(source.sourceHead, custody.sourceHead), 'proof-verified source head differs');
    const recorder = sourceSpanRecorder(input.source.sourceLength);
    const foldNow = input.source.sourceInput.foldNow;
    requireEvidence(Number.isSafeInteger(foldNow) && custody.cutWindow.startMs <= foldNow && foldNow <= custody.cutWindow.endMs, 'source fold time differs');
    const options = { now: foldNow, excludeTables: SEED_EXCLUDED_TABLES, priorSnapshotHint: source.hint, requireComplete: true };
    const original = await foldFilteredSnapshotRows(source.log, { ...options, onSourceBlock: recorder.read });
    const span = recorder.finish(original);
    const privacy = seedSnapshotValueTransform(custody.privacy.literals);
    const normal = await foldFilteredSnapshotRows(source.log, { ...options, transformValue: privacy.transform });
    const projected = new Map(normal.rows.map(row => [key(row), row]));
    const winners = original.rows.map(row => ({ table: row.table, hbKey: row.hbKey,
      disposition: !projected.has(key(row)) ? 'drop' : sameEvidence(projected.get(key(row))!.value, row.value) ? 'carry' : 'redact' }));
    requireEvidence(sameEvidence(input.source.sourceInput, { ...span, sourceHead: source.sourceHead, foldNow, winners,
      executionBinding: custody.executionBinding }) && input.source.sourceBlocksRead === span.sourceBlocksRead
      && input.source.sourceBlocksJsonSha256 === span.sourceBlocksJsonSha256 && input.source.rowCount === original.rows.length,
      'source proof/span/coverage/winner census differs');
    const segment = basename(input.source.rowsPath);
    requireEvidence(/^segment-[0-9]{6}\.(?:blob|log)$/.test(segment), 'original row segment locator invalid');
    const rowText = original.rows.map((row, index) => {
      const p = projected.get(key(row));
      const privacyProjection = !p ? { disposition: 'drop' } : JSON.stringify(p.value) === JSON.stringify(row.value)
        ? { disposition: 'carry' } : { disposition: 'redact', value: p.value };
      return JSON.stringify({ ...row, segment, line: index + 1, storedValueJson: JSON.stringify(row.value), privacyProjection }) + '\n';
    }).join('');
    requireEvidence(originalSha256(rowText) === input.source.rowsSha256, 'source row byte digest differs');
    // The maintained transforms preserve unopened envelopes and concurrent appends.
    const governor = governorReceiptSnapshotValueTransform({ maxSourceIndexExclusive: pg.maxSourceIndexExclusive,
      liveQualifiedKeys: pg.liveGovernorQualifiedKeys });
    const finalPrivacy = seedSnapshotValueTransform(custody.privacy.literals, custody.privacy.uuidDropPlan ? {
      plan: custody.privacy.uuidDropPlan, ownerKeyHex: source.sourceHead.sourceKeyHex, sourceLength: source.sourceHead.sourceLength,
    } : undefined);
    const expected = await foldFilteredSnapshotRows(source.log, { ...options, transformValue: (value, address) => {
      const kept = governor.transform(value, address);
      return kept === DROP_SNAPSHOT_ROW ? kept : finalPrivacy.transform(kept, address);
    } });
    finalPrivacy.finishUuidRedaction?.();
    for (const live of keys) requireEvidence(expected.rows.some(row => row.table === 'engineer-issues' && row.hbKey === live && !row.deleted),
      'projection omits a live PG work item or observation');
    const stores = input.payload.manifest.stores.filter(s => s.kind === 'corestore');
    requireEvidence(stores.length === 1 && readCoreProjectedFrom(stores[0]!.meta)?.[input.restoredKeyHex] === source.sourceHead.sourceKeyHex,
      'restored projection source mapping differs');
    const restored = await signedSeedSource(input.restoredCore, input.restoredKeyHex, input.restoredCore.length);
    await restoredSnapshotCensus(restored.log);
    const restoredRows = await foldFilteredSnapshotRows(restored.log, { now: foldNow, priorSnapshotHint: restored.hint, requireComplete: true });
    requireEvidence(sameEvidence(population(expected.rows), population(restoredRows.rows)), 'restored full row population/metadata differs');
    source.assertHead(); restored.assertHead();
    return { ok: true, checks: [{ id: 'P-521:seed-population', status: 'pass', detail: 'signed source, PG census and exact restored population verified' }] };
  } catch {
    // Do not expose private census rows, literals, keys or locators in public diagnostics.
    return { ok: false, checks: [{ id: 'P-521:seed-population', status: 'fail', detail: 'independent source/PG/custody or exact restored population unavailable or invalid' }] };
  }
}
