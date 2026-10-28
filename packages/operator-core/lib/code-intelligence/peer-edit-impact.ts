/** P018: peer evidence for the EXISTING interface push, never a second advisory. */
import { getOrgPg } from '@papercusp/db-org';
import { PRESENCE_STALE_MS } from '@papercusp/coordination/presence';
import { liveLockHoldingsStrict, type LiveLockHolding } from '../agent-tools/locks/live-lock-paths';
import { corroboratePushSources, safeSnapshotPath, type PushSnapshot } from './push-snapshot';
import type { PushInput } from './push-channel';
import { CODE_DEPENDENCY_EVIDENCE_ACTION } from '../coord/coupling-derivation';

export interface InterfacePeerContext {
  byPath: Record<string, { status: 'measured' | 'unknown';
    peers: { owner: string; path: string; via: 'lock' | 'working-set' }[]; reason?: string;
    /** The changed exported symbols (from `signature <name>`). Code-intel P-011 evidence. */
    symbols?: string[];
    /** Every matched peer (up to the 16-owner read cap), before the display slice, so the
     *  shadow coupling's fan-in cap counts real holders, not the first four. */
    holders?: { owner: string; path: string; via: 'lock' | 'working-set' }[];
    /** `stale` = the callers index did not match the pre-edit source or moved during
     *  the read; `unknown` = no usable measurement. */
    callers?: 'measured' | 'unknown' | 'stale';
  }>;
}

const STALE_CALLER_REASONS = new Set([
  'caller snapshot does not match the pre-edit source',
  'caller/source generation changed',
  'caller/source generation changed during peer read',
]);

export interface InterfacePeerDeps {
  locks(): Promise<LiveLockHolding[]>;
  sql: ReturnType<typeof getOrgPg>['sql'];
}

/** These are local signature-diff triggers, not body-only/behavioural edits. */
export function interfaceSignatureEdits(input: PushInput) {
  return input.calls.filter(call => /(?:^|_|:|\.)(?:Edit|Write|MultiEdit|edit|write|apply_patch)$/.test(call.tool ?? ''))
    .flatMap(call => call.interfaceEdits ?? (call.interfaceEdit ? [call.interfaceEdit] : []))
    .filter((edit): edit is { path: string; base: string; changes: string[]; sourceChange?: {
      root: string; path: string; base: string; at: number; beforeSha256: string; sha256: string;
    } } => !!edit && typeof edit === 'object' && safeSnapshotPath((edit as any).path)
      && Array.isArray((edit as any).changes) && (edit as any).changes.some((s: unknown) =>
        typeof s === 'string' && /^signature [A-Za-z_$][\w$]*$/.test(s)))
    .slice(0, 2);
}

/** Positive matches are source-correlated static caller candidates. No rows is
 * never a claim that nobody is affected: dynamic/unresolved reach stays unknown.
 * A strict lock read and a single bounded PG transaction retain failures as unknown.
 */
export async function readInterfacePeerContext(input: PushInput, snapshot: PushSnapshot,
  deps: InterfacePeerDeps = { locks: liveLockHoldingsStrict, sql: getOrgPg().sql }): Promise<InterfacePeerContext> {
  const result: InterfacePeerContext = { byPath: {} };
  const harness = input.harness;
  if (!input.root || !harness) return result;
  for (const edit of interfaceSignatureEdits(input)) {
    const names = edit.changes.filter(s => /^signature [A-Za-z_$][\w$]*$/.test(s)).map(s => s.slice(10));
    const unknown = (reason: string) => {
      result.byPath[edit.path] = { status: 'unknown', peers: [], reason, symbols: names,
        callers: STALE_CALLER_REASONS.has(reason) ? 'stale' : 'unknown' };
    };
    const pin = edit.sourceChange;
    if (!pin || pin.root !== input.root || pin.path !== edit.path || pin.base !== edit.base
      || !/^[a-f0-9]{40,64}$/.test(edit.base) || !Number.isFinite(pin.at) || pin.at > Date.now()
      || Date.now() - pin.at > 60_000 || !/^[a-f0-9]{64}$/.test(pin.beforeSha256)
      || !/^[a-f0-9]{64}$/.test(pin.sha256) || pin.beforeSha256 === pin.sha256) {
      unknown('edit/source pin unavailable'); continue;
    }
    const symbols = names.flatMap(name => (snapshot.symbols?.get(name) ?? []).filter(s => s.path === edit.path));
    if (symbols.length !== names.length || symbols.some(s => s.sha256 !== pin.beforeSha256 || !s.sources?.length)) {
      unknown('caller snapshot does not match the pre-edit source'); continue;
    }
    const sources = [{ path: edit.path, sha256: pin.sha256 }, ...symbols.flatMap(s => s.sources!).filter(s => s.path !== edit.path)];
    if (!await corroboratePushSources(input.root, sources, AbortSignal.timeout(75))) {
      unknown('caller/source generation changed'); continue;
    }
    const paths = [...new Set(symbols.flatMap(s => s.callers.map(c => c.path)).filter(safeSnapshotPath))].slice(0, 64);
    if (!paths.length) {
      result.byPath[edit.path] = { status: 'measured', peers: [], symbols: names, holders: [], callers: 'measured' };
      continue;
    }
    try {
      const locks = (await deps.locks()).filter(l => l.owner !== input.owner
        && l.coordinationDomain === input.root && paths.includes(l.path));
      const rows = await deps.sql.begin(async tx => {
        await tx`SELECT set_config('statement_timeout', '75ms', true)`;
        return tx<{ owner_id: string; current_files: unknown }[]>`
          SELECT p.owner_id, p.current_files FROM harness_shared.coord_presence p
          JOIN LATERAL (SELECT a.ended_at FROM harness_shared.adv_sessions a
            WHERE a.workspace_id = p.workspace_id AND a.coord_owner_id = p.owner_id
            ORDER BY a.started_at DESC, a.session_id DESC LIMIT 1) a ON a.ended_at IS NULL
          WHERE p.workspace_id = ${input.workspace} AND p.pot_slug = ${harness}
            AND p.owner_id <> ${input.owner} AND p.heartbeat_at <= now()
            AND p.heartbeat_at >= now() - ${`${PRESENCE_STALE_MS} milliseconds`}::interval
            AND (p.owner_id = ANY(${locks.map(l => l.owner)}::text[]) OR p.current_files ?| ${paths}::text[])
          ORDER BY p.owner_id LIMIT 16`;
      });
      const peers: InterfacePeerContext['byPath'][string]['peers'] = [];
      for (const row of rows) {
        const held = locks.filter(l => l.owner === row.owner_id);
        for (const lock of held) peers.push({ owner: row.owner_id, path: lock.path, via: 'lock' });
        const files = typeof row.current_files === 'string' ? JSON.parse(row.current_files) : row.current_files;
        if (Array.isArray(files)) for (const path of files.filter(safeSnapshotPath)) {
          if (paths.includes(path) && !held.some(l => l.path === path)) peers.push({ owner: row.owner_id, path, via: 'working-set' });
        }
      }
      // A source may have changed DURING the cross-plane read. Re-check before naming anyone.
      if (!await corroboratePushSources(input.root, sources, AbortSignal.timeout(75))) {
        unknown('caller/source generation changed during peer read'); continue;
      }
      result.byPath[edit.path] = { status: 'measured', peers: peers.slice(0, 4), symbols: names,
        holders: peers, callers: 'measured' };
    } catch { unknown('live peer read unavailable'); }
  }
  return result;
}

const TERMINAL_WORK_ITEM_STATUSES = ['done', 'resolved', 'dropped', 'closed', 'deprecated', 'passed'];

/**
 * Code-intel P-011: persist what `readInterfacePeerContext` measured, so the coupling
 * derivation can re-read it later (coupling-sources.ts `fetchCodeDependencyEvidence`).
 * One audit_log row per changed symbol, carrying the editor's held non-terminal work
 * items at measurement time: the shadow edge ends when every one of them is terminal.
 * Fail-soft and bounded; the push never waits on it.
 */
export async function recordInterfaceDependencyEvidence(input: PushInput, context: InterfacePeerContext,
  deps: { sql: ReturnType<typeof getOrgPg>['sql'] } = { sql: getOrgPg().sql }): Promise<number> {
  const entries = Object.entries(context.byPath).filter(([, e]) => e.symbols?.length);
  if (!entries.length || !input.owner || !input.workspace) return 0;
  return deps.sql.begin(async tx => {
    await tx`SELECT set_config('statement_timeout', '250ms', true)`;
    const items = await tx<{ feature_id: string }[]>`
      SELECT feature_id FROM harness_shared.work_items
       WHERE workspace_id = ${input.workspace} AND assignee = ${input.owner}
         AND status <> ALL(${TERMINAL_WORK_ITEM_STATUSES}::text[])
       ORDER BY updated_at DESC LIMIT 8`;
    const workItemIds = items.map(r => r.feature_id);
    const now = Date.now();
    let written = 0;
    for (const [path, entry] of entries) {
      const holders = (entry.holders ?? []).map(h => ({ ownerId: h.owner, path: h.path, via: h.via }));
      for (const symbol of entry.symbols!) {
        const details = { editorOwnerId: input.owner, symbol, path, callers: entry.callers ?? 'unknown',
          reason: entry.reason ?? null, holders, holderOwners: [...new Set(holders.map(h => h.ownerId))],
          workItemIds, root: input.root ?? null, harness: input.harness ?? null };
        await tx`INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
          VALUES (${`ccd-ev-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`}, ${now}, ${input.owner},
            ${CODE_DEPENDENCY_EVIDENCE_ACTION}, ${`${path}#${symbol}`}, ${tx.json(details)}, ${input.workspace})`;
        written += 1;
      }
    }
    return written;
  });
}
