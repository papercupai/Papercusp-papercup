/**
 * code-intel-delivery-and-outcomes-2026-10-26 P-002 (D-018): journal edit-time
 * interface eligibility on the edit-attribution rows just written, so the
 * `interface` push leg has an independent denominator. push-leg-liveness.ts reads
 * `signal_eligibility->'interface'`; before this file nothing in production called
 * captureInterfaceEligibility / persistInterfaceEligibility, so that leg could only
 * ever read cannot-observe.
 *
 * Independence (D-018): this imports nothing from push-channel.ts, peer-edit-impact.ts
 * or the hook signature detector. Peer evidence is its own bounded read of the lock
 * plane and live presence, correlated to the edited file by path or relative import.
 *
 * HONEST LIMITS
 * 1. "before" is the committed HEAD blob (the same read as P-007's edited-symbols.ts),
 *    so uncommitted edits since the last git-sync sweep count as part of this edit.
 *    That can over-report changed exports; it never misses this edit's own.
 * 2. A peer is correlated only by holding/working on the edited path itself or a file
 *    that imports it by a RELATIVE specifier. Package-specifier and dynamic reach are
 *    not resolved, so 'measured' with no peers means "no observed peer", never
 *    "nobody is affected".
 * 3. Peers are read only when an exported signature changed. A body-only edit records
 *    peerEvidence 'unknown' because its 'ineligible' verdict does not depend on peers.
 * 4. A scan that could not see the whole candidate set (row/file caps, a lock domain
 *    that is a submodule or worktree whose presence paths cannot be placed) reports
 *    'unknown' unless it already found a peer.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { PRESENCE_STALE_MS } from '@papercusp/coordination/presence';
import { liveLockHoldingsStrict, type LiveLockHolding } from '../agent-tools/locks/live-lock-paths';
import { gitHeadText } from './edited-symbols';
import {
  captureInterfaceEligibility, type EditTimePeerEvidence, type InterfaceEligibility,
} from './interface-eligibility';
import { persistInterfaceEligibility, type EditEligibilityIdentity } from './edit-eligibility-journal';

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const MODULE_EXT = /\.(?:d\.)?(?:[cm]?[jt]sx?)$/;
/** import/export-from, side-effect import, dynamic import() and require(). */
const SPECIFIER = /(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\()\s*(['"])([^'"\r\n]+)\1/g;

/** Distinct candidate peer files read per edit. */
export const PEER_FILE_CAP = 50;
/** Live presence rows read per edit; hitting it means the scan may be partial. */
export const LIVE_PEER_ROW_CAP = 64;
/** Peers stored on the observation (the verdict only needs one). */
const STORED_PEER_CAP = 8;

type Peer = EditTimePeerEvidence['peers'][number];
const unmeasured = (): EditTimePeerEvidence => ({ status: 'unknown', peers: [] });

/** A repo-relative POSIX path that cannot escape the root. */
function safeRelative(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length < 1024 && !path.includes('\0')
    && !path.startsWith('/') && !path.split('/').some(segment => segment === '..' || segment === '');
}

/** The module an import resolves to: no extension and no trailing `/index`. */
export function moduleKey(path: string): string {
  let key = posix.normalize(path).replace(/\/+$/, '').replace(MODULE_EXT, '');
  if (key === 'index') return '.';
  key = key.replace(/\/index$/, '');
  return key || '.';
}

/** True when `importerText` (the file at `importerPath`) imports the module `targetKey`
 * through a relative specifier. Bare/package specifiers are deliberately not resolved. */
export function importsModule(importerPath: string, importerText: string, targetKey: string): boolean {
  const dir = posix.dirname(importerPath);
  for (const match of importerText.matchAll(SPECIFIER)) {
    const spec = match[2];
    if (spec !== '.' && spec !== '..' && !spec.startsWith('./') && !spec.startsWith('../')) continue;
    if (moduleKey(posix.join(dir, spec)) === targetKey) return true;
  }
  return false;
}

export interface LivePeerRow { owner_id: string; current_files: unknown }

export interface PeerEvidenceInput {
  repoRoot: string;
  file: string;
  workspaceId: string;
  /** Presence is scoped by harness (pot_slug); without one the working set cannot be placed. */
  harness: string | null;
  agentId: string;
}

export interface PeerEvidenceDeps {
  locks?: () => Promise<LiveLockHolding[]>;
  /** Live presence of OTHER owners in this workspace + harness: fresh heartbeat, session not ended. */
  livePeers?: (query: { workspaceId: string; harness: string; agentId: string; lockOwners: string[] }) => Promise<LivePeerRow[]>;
  readText?: (absPath: string) => Promise<string>;
  /** Whether presence paths (superproject-relative) can be placed under this lock domain. */
  workingSetPlaceable?: (repoRoot: string) => Promise<boolean>;
}

async function defaultLivePeers(query: { workspaceId: string; harness: string; agentId: string; lockOwners: string[] }) {
  const { sql } = getOrgPg();
  const rows = await sql.begin(async tx => {
    await tx`SELECT set_config('statement_timeout', '250ms', true)`;
    return tx<LivePeerRow[]>`
      SELECT p.owner_id, p.current_files FROM harness_shared.coord_presence p
      JOIN LATERAL (SELECT a.ended_at FROM harness_shared.adv_sessions a
        WHERE a.workspace_id = p.workspace_id AND a.coord_owner_id = p.owner_id
        ORDER BY a.started_at DESC, a.session_id DESC LIMIT 1) a ON a.ended_at IS NULL
      WHERE p.workspace_id = ${query.workspaceId} AND p.pot_slug = ${query.harness}
        AND p.owner_id <> ${query.agentId} AND p.heartbeat_at <= now()
        AND p.heartbeat_at >= now() - ${`${PRESENCE_STALE_MS} milliseconds`}::interval
        AND (p.owner_id = ANY(${query.lockOwners}::text[]) OR jsonb_array_length(p.current_files) > 0)
      ORDER BY p.owner_id LIMIT ${LIVE_PEER_ROW_CAP}`;
  });
  return rows as unknown as LivePeerRow[];
}

/** A checkout whose `.git` is a directory is a repository top, where presence paths live. */
async function defaultWorkingSetPlaceable(repoRoot: string): Promise<boolean> {
  try { return (await stat(join(repoRoot, '.git'))).isDirectory(); } catch { return false; }
}

/**
 * Live peers correlated to `input.file` at edit time. Any lock-plane, presence or
 * file-read failure gives 'unknown'; a partial scan gives 'unknown' unless it already
 * found a peer.
 */
export async function readEditTimePeers(input: PeerEvidenceInput, deps: PeerEvidenceDeps = {}): Promise<EditTimePeerEvidence> {
  if (!input.harness || !safeRelative(input.file)) return unmeasured();
  try {
    const locks = (await (deps.locks ?? liveLockHoldingsStrict)())
      .filter(l => l.owner !== input.agentId && l.coordinationDomain === input.repoRoot && safeRelative(l.path));
    const placeable = await (deps.workingSetPlaceable ?? defaultWorkingSetPlaceable)(input.repoRoot);
    const rows = await (deps.livePeers ?? defaultLivePeers)({
      workspaceId: input.workspaceId, harness: input.harness, agentId: input.agentId,
      lockOwners: [...new Set(locks.map(l => l.owner))],
    });
    let partial = !placeable || rows.length >= LIVE_PEER_ROW_CAP;
    const candidates: Peer[] = [];
    for (const row of rows) {
      if (row.owner_id === input.agentId) continue;
      const held = locks.filter(l => l.owner === row.owner_id);
      for (const lock of held) candidates.push({ owner: row.owner_id, path: lock.path, via: 'lock' });
      if (!placeable) continue;
      const files = typeof row.current_files === 'string' ? JSON.parse(row.current_files) : row.current_files;
      if (Array.isArray(files)) for (const path of files) {
        if (safeRelative(path) && !held.some(l => l.path === path)) candidates.push({ owner: row.owner_id, path, via: 'working-set' });
      }
    }
    const target = moduleKey(input.file);
    const read = deps.readText ?? (p => readFile(p, 'utf8'));
    const correlates = new Map<string, boolean>();
    const peers: Peer[] = [];
    for (const candidate of candidates) {
      let hit = correlates.get(candidate.path);
      if (hit === undefined) {
        if (correlates.size >= PEER_FILE_CAP) { partial = true; continue; }
        if (candidate.path === input.file) hit = true;
        else if (!CODE_FILE.test(candidate.path)) hit = false;
        else {
          try {
            hit = importsModule(candidate.path, await read(resolve(input.repoRoot, candidate.path)), target);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException | null)?.code;
            // A path that is not a readable file cannot import anything: a measured absence.
            if (code !== 'ENOENT' && code !== 'EISDIR' && code !== 'ENOTDIR') return unmeasured();
            hit = false;
          }
        }
        correlates.set(candidate.path, hit);
      }
      if (hit) peers.push({ ...candidate });
    }
    if (!peers.length && partial) return unmeasured();
    return { status: 'measured', peers: peers.slice(0, STORED_PEER_CAP) };
  } catch {
    return unmeasured();
  }
}

export interface InterfaceCaptureContext {
  repoRoot: string;
  workspaceId: string | null;
  /** The ledger rows' own stored harness_slug (may be NULL): part of the journal identity,
   * matched verbatim (IS NOT DISTINCT FROM). Deliberately NOT named `harnessSlug`: it is a
   * stored row value, not a tool ctx's scope, so it must never pass through the `'*'` resolver. */
  rowHarnessSlug: string | null;
  /** The harness peers are scoped by: the row's harness, else the editor's presence pot. */
  scopeHarness: string | null;
  agentId: string;
}

export interface InterfaceCaptureDeps extends PeerEvidenceDeps {
  /** The committed blob, '' for a path absent from HEAD, null when git cannot answer. */
  headText?: (absPath: string) => Promise<string | null>;
  peerEvidence?: (input: PeerEvidenceInput) => Promise<EditTimePeerEvidence>;
  persist?: (identity: EditEligibilityIdentity, observation: InterfaceEligibility) => Promise<boolean>;
  now?: () => Date;
}

/** The edit-time observation for one file, or null when the file is not TS/JS source. */
export async function captureEditInterface(ctx: InterfaceCaptureContext, file: string,
  deps: InterfaceCaptureDeps = {}): Promise<InterfaceEligibility | null> {
  if (!CODE_FILE.test(file) || !safeRelative(file) || /(^|\/)node_modules\//.test(file)) return null;
  const abs = resolve(ctx.repoRoot, file);
  const [afterText, beforeText] = await Promise.all([
    (deps.readText ?? (p => readFile(p, 'utf8')))(abs).catch(() => null),
    (deps.headText ?? gitHeadText)(abs).catch(() => null),
  ]);
  const capturedAt = (deps.now?.() ?? new Date()).toISOString();
  const first = captureInterfaceEligibility({ file, beforeText, afterText, capturedAt, peerEvidence: unmeasured() });
  if (!first.changedExports.length || !ctx.workspaceId) return first;
  const input: PeerEvidenceInput = {
    repoRoot: ctx.repoRoot, file, workspaceId: ctx.workspaceId, harness: ctx.scopeHarness, agentId: ctx.agentId,
  };
  const peerEvidence = await (deps.peerEvidence ?? (i => readEditTimePeers(i, deps)))(input).catch(unmeasured);
  return captureInterfaceEligibility({ file, beforeText, afterText, capturedAt, peerEvidence });
}

/** Journal interface eligibility on just-inserted ledger rows. First observation wins; never throws.
 * A row recorded by a build without this capture keeps signal_eligibility NULL, which the R-1
 * liveness probe reads as not observed rather than as a silent leg. A direct capability:edit
 * call is attributed by the lock grant path; an indirect one (tools:invoke, code:run) records here. */
export async function fillInterfaceEligibility(rows: readonly { id: string; file: string }[],
  ctx: InterfaceCaptureContext, sql: Sql, deps: InterfaceCaptureDeps = {}): Promise<number> {
  const workspace = ctx.workspaceId;
  if (!workspace || !ctx.agentId || !ctx.repoRoot) return 0;
  const persist = deps.persist ?? ((identity, observation) => persistInterfaceEligibility(identity, observation, sql));
  let filled = 0;
  for (const row of rows) {
    try {
      if (!/^[1-9][0-9]*$/.test(row.id)) continue;
      const observation = await captureEditInterface(ctx, row.file, deps);
      if (!observation) continue;
      if (await persist({ id: row.id, workspace, harness: ctx.rowHarnessSlug, owner: ctx.agentId,
        repoRoot: ctx.repoRoot, file: row.file }, observation)) filled++;
    } catch {
      // best-effort: an unmeasured row stays unobserved, never wrong.
    }
  }
  return filled;
}
