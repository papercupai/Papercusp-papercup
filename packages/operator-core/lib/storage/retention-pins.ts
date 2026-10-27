/** Agent retention pins use the existing release-retention lease store.
 * The unchanged TSV schema protects pins in both shell and TypeScript deleters;
 * owner/reason metadata lives in the opaque tag, not a parallel pin database.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { Sql } from 'postgres';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { AGENT_MAX_AGE_HOURS } from './retention-policy';
import { withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';
import { defaultRetentionDir, readRetentionPins, RETENTION_SCHEMA, withRetentionPinProtection,
  type RetentionPin } from '../../../../scripts/lib/retention-pins.mjs';
export { readRetentionPins, readRetentionPinsAsync, withRetentionPinProtection,
  retentionPinProtectsPath as pinProtectsPath } from '../../../../scripts/lib/retention-pins.mjs';
export type { RetentionPin } from '../../../../scripts/lib/retention-pins.mjs';

/** The final protection read and deletion share storage:pin's cross-process mutex. */
export async function withUnpinnedPath(path: string, remove: () => boolean | Promise<boolean>): Promise<boolean> {
  return withRetentionPinProtection((isPinned) => isPinned(path) ? false : remove());
}

const TAG_PREFIX = 'agent-pin-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createRetentionPin(input: { path: string; owner: string; reason: string; expiresAt: string },
  options: { dir?: string; nowMs?: number; id?: string; dryRun?: boolean } = {}): RetentionPin {
  const nowMs = options.nowMs ?? Date.now();
  const expiry = Date.parse(input.expiresAt);
  if (!input.owner.trim() || !input.reason.trim()) throw new Error('pin requires an owner and reason');
  if (!Number.isFinite(expiry) || expiry <= nowMs) throw new Error('pin requires a finite future expiry');
  if (!isAbsolute(input.path) || /[\r\n\0]/.test(input.path)) throw new Error('pin requires an absolute path without line breaks');
  const logical = normalize(input.path);
  // A missing target is an error, never a silently ineffective pin.
  const paths = [...new Set([logical, realpathSync(logical)])];
  const dir = options.dir ?? defaultRetentionDir();
  if (options.id !== undefined && !UUID.test(options.id)) throw new Error('invalid pin id');
  const pin: RetentionPin = { id: options.id ?? randomUUID(), owner: input.owner.trim(), reason: input.reason.trim(),
    createdAt: new Date(nowMs).toISOString(), expiresAt: new Date(expiry).toISOString(), paths };
  if (options.dryRun) return pin;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tag = TAG_PREFIX + Buffer.from(JSON.stringify({ version: 1, id: pin.id, owner: pin.owner,
    reason: pin.reason, createdAt: pin.createdAt })).toString('base64url');
  const body = [`schema=${RETENTION_SCHEMA}`, `tag=${tag}`, `created_ns=${BigInt(Math.floor(nowMs)) * 1_000_000n}`,
    `expires_ns=${BigInt(expiry) * 1_000_000n}`, ...paths.map((p) => `path=${p}`), ''].join('\n');
  const file = join(dir, `lease-agent-pin-${pin.id}.tsv`);
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, body);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return pin;
}

export interface WorkItemEvidenceReference {
  work_item_id: string;
  harness_slug: string;
  evidence_ref: string;
}

/** Reuse immutable evidence bindings and the canonical work-item lifecycle.
 * Closed items stop renewing; their finite leases expire under normal policy. */
export async function readOpenWorkItemEvidenceReferences(sql: Sql, workspaceId: string): Promise<WorkItemEvidenceReference[]> {
  return sql<WorkItemEvidenceReference[]>`
    SELECT DISTINCT b.work_item_id, b.harness_slug, b.evidence_ref
      FROM harness_shared.spec_evidence_bindings b
     WHERE b.workspace_id = ${workspaceId}
       AND b.retracted_at IS NULL
       AND b.evidence_ref LIKE 'docs/evidence/%.json'
       AND EXISTS (
         SELECT 1 FROM harness_shared.work_items w
          WHERE w.workspace_id = ANY(${[...new Set([workspaceId, DEFAULT_COORD_WORKSPACE])]}::text[])
            AND w.harness_slug = b.harness_slug AND w.feature_id = b.work_item_id
            AND NOT (w.status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[])))`;
}

/** Called only while holding papercusp-disk-retention, before selecting effects.
 * Explicit retainedEvidence roots reuse the existing TSV pin store, so native
 * cleaners honour the same protection. No checkpoint/prose path guessing. */
export async function renewWorkItemEvidencePins(references: readonly WorkItemEvidenceReference[], options: {
  repositories: ReadonlyMap<string, string>; home?: string; dir?: string; nowMs?: number; dryRun?: boolean;
}): Promise<{ pins: RetentionPin[]; missing: Array<{ workItemId: string; evidenceRef: string; path: string }> }> {
  const nowMs = options.nowMs ?? Date.now();
  const pins: RetentionPin[] = [], missing: Array<{ workItemId: string; evidenceRef: string; path: string }> = [];
  const home = options.home ?? homedir();
  const inside = (base: string, path: string) => {
    const rel = relative(base, path);
    return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../');
  };
  for (const ref of references) {
    const repository = options.repositories.get(ref.harness_slug);
    if (!repository) throw new Error(`evidence retention: unregistered harness ${ref.harness_slug}`);
    if (!/^docs\/evidence\/.+\.json$/.test(ref.evidence_ref) || ref.evidence_ref.split('/').some(part => part === '..' || part === '.') || ref.evidence_ref.includes('\\')) {
      throw new Error(`evidence retention: unsafe receipt ${ref.evidence_ref}`);
    }
    const receipt = resolve(repository, ref.evidence_ref);
    let document: { retainedEvidence?: { root?: unknown; pathBase?: unknown } };
    try {
      if (!inside(await realpath(repository), await realpath(receipt))) throw new Error('receipt escapes repository');
      document = JSON.parse(await readFile(receipt, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        missing.push({ workItemId: ref.work_item_id, evidenceRef: ref.evidence_ref, path: receipt });
        continue;
      }
      throw error;
    }
    const retained = document.retainedEvidence;
    if (!retained || typeof retained.root !== 'string') continue;
    const base = typeof retained.pathBase === 'string' && retained.pathBase.startsWith('Operating account home directory')
      ? home : typeof retained.pathBase === 'string' && /^(Repository root|Staging checkout|Repository checkout)/i.test(retained.pathBase)
        ? repository : undefined;
    if (!isAbsolute(retained.root) && !base) throw new Error(`evidence retention: ambiguous root base in ${ref.evidence_ref}`);
    const path = resolve(base ?? repository, retained.root);
    if (![home, repository].some(root => ['evidence', 'test-evidence', 'artifacts', 'release-artifacts'].some(kind => inside(join(root, '.papercusp', kind), path)))) {
      throw new Error(`evidence retention: root outside agent evidence in ${ref.evidence_ref}`);
    }
    const digest = createHash('sha256').update(`${ref.harness_slug}\0${ref.work_item_id}\0${path}`).digest('hex');
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
    try {
      pins.push(createRetentionPin({ path, owner: `work-item:${ref.work_item_id}`, reason: `Open work-item evidence: ${ref.evidence_ref}`,
        expiresAt: new Date(nowMs + AGENT_MAX_AGE_HOURS * 3_600_000).toISOString() }, { dir: options.dir, nowMs, id, dryRun: options.dryRun }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing.push({ workItemId: ref.work_item_id, evidenceRef: ref.evidence_ref, path });
      else throw error;
    }
  }
  return { pins, missing };
}

/** Intake and reclaim use the same lock order: retention mutex, then database.
 * A retained root must still exist before the binding can be accepted. A pin
 * made for a refused binding is harmless and expires without renewal. */
export async function withWorkItemEvidenceRetention<T>(reference: WorkItemEvidenceReference,
  options: Parameters<typeof renewWorkItemEvidencePins>[1], accept: () => Promise<T>): Promise<T> {
  return withFsMutex('papercusp-disk-retention', async () => {
    const protection = await renewWorkItemEvidencePins([reference], options);
    if (protection.missing.length) throw new Error(`evidence retention: missing declared evidence ${protection.missing[0]!.path}`);
    return accept();
  });
}

/** Only the pin's authenticated owner can release it through the agent tool. */
export function removeRetentionPin(id: string, owner: string, options: { dir?: string } = {}): boolean {
  if (!UUID.test(id)) throw new Error('invalid pin id');
  const read = readRetentionPins({ ...options, includeExpired: true });
  if (read.errors.length) throw new Error(`retention pins unreadable: ${read.errors.join('; ')}`);
  const pin = read.pins.find((p) => p.id === id);
  if (!pin) return false;
  if (pin.owner !== owner) throw new Error('only the pin owner may release it');
  unlinkSync(join(options.dir ?? defaultRetentionDir(), `lease-agent-pin-${id}.tsv`));
  return true;
}
