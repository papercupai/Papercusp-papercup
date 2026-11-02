import { papercuspPath } from '@papercusp/host-platform/home';
/**
 * cold-boot-drill-live — P-020's opt-in chaos actuator + mechanical grader.
 *
 * This deliberately REUSES the P-018 carry-respawn host instead of introducing
 * another lifecycle mechanism. `startColdBootDrill` builds the same deterministic
 * carry, crosses the same flush/open-owner gates, and queues the same clean-boundary
 * `carry-respawn`; drill metadata merely lets the host record which fresh native
 * transcript belongs to the sample. `gradeColdBootDrill` then parses that native
 * transcript through the replay parser and extracts only explicit state-recovery
 * tool calls. No LLM judges its own carry.
 *
 * Destructive behavior is DEFAULT-OFF: nothing runs on a timer or watcher. A caller
 * must explicitly invoke `session:carry-drill { op:'start' }`, and the durable drill
 * ledger rate-limits one owner to one cut per 30 minutes.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { buildCarryBrief, type CarryBrief } from './carry-brief';
import { buildOwnerRespawnLaunchSpec, type RespawnLaunchSpec } from './carry-respawn';
import {
  DEFAULT_SUFFICIENCY_PARAMS,
  classifyRecoveryLookup,
  extractRecoveryLookups,
  gradeColdBootDrills,
  type CarrySufficiencyReport,
  type DrillSample,
  type RecoveryLookup,
} from './cold-boot-drill';
import { resolveModelSpecForOwner } from './compaction-usage';
import { tagTurnForInjection } from './turn-provenance/turn-provenance';
import { runFlushGate, type FlushGateOutcome } from './enforcement-gate-io';
import {
  PSU_PTY_DIR,
  findLiveHostAsync,
  hostSupports,
  injectIntoHost,
  sanitizeKey,
  sessionClassForHost,
  type PsuPtyHost,
} from './events/await/psu-pty-discovery';
import { modelWindowForSpec } from './agent-config-constants';
import { parseTranscriptJsonl } from './replay/transcript';
import type { ReplayTranscript } from './replay/types';
import { MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION } from './agent-tools/coordination/compaction-recovery';
import {
  resolveOwnerIsolatedSessionByPrefix,
  resolveSelfSession,
  type SelfSession,
} from './search/self-session';

export const DEFAULT_COLD_BOOT_DRILL_INTERVAL_MS = 30 * 60_000;
export const DEFAULT_COLD_BOOT_DRILL_WINDOW_TOKENS = 200_000;
const DRILL_LEDGER_MAX_BYTES = 1024 * 1024;
const DRILL_LEDGER_FILE = 'carry-drills.events.jsonl';
const CARRY_ROOT = papercuspPath('launch-context');

/**
 * EI-18133456688790756 (P-021 class-name mismatch): `startColdBootDrill` now
 * always DEFAULTS an omitted `sessionClass` from the canonical classifier
 * (`sessionClassForHost` — see the comment at its call site), but a handful of
 * historical ledger rows (2026-07-17) were requested with an EXPLICIT, hand-typed
 * `sessionClass: 'gateway-claude-headless'` that the classifier has never emitted
 * (confirmed: `git log -S'gateway-claude-headless'` on psu-pty-discovery.ts is
 * empty) — a caller-supplied override, not a classifier bug. Left unaliased those
 * graded drills silently orphan into a phantom class no live headless wake can
 * ever match, so the REAL 'claude-headless' class reads zero drills forever even
 * though a genuinely good drill already ran under a stale label. Alias at
 * READ-time (never mutate the append-only ledger) so old data folds back into
 * the class it was always actually testing. Extend this map only for a CONFIRMED
 * one-off caller-supplied label, never for a class the live classifier can emit.
 */
const LEGACY_SESSION_CLASS_ALIASES: Readonly<Record<string, string>> = {
  'gateway-claude-headless': 'claude-headless',
};

function normalizeSessionClass(sessionClass: string): string {
  return LEGACY_SESSION_CLASS_ALIASES[sessionClass] ?? sessionClass;
}

export type ColdBootDrillLedgerKind =
  | 'carry-drill-requested'
  | 'carry-drill-queued'
  | 'carry-drill-request-failed'
  | 'carry-drill-graded'
  // Host-side lifecycle kinds mirrored into the shared ledger by psu-pty-host's
  // appendSharedDrillLedgerEvent (EI-12655): previously these lived ONLY in the
  // per-owner host event log, so the shared-ledger report saw an eternally
  // pending requested/queued pair for every drill whose grade never landed.
  | 'carry-drill-respawned'
  | 'carry-drill-respawn-failed'
  | 'carry-drill-carry-delivered'
  | 'carry-drill-carry-dropped'
  // Busy-gate measurement rows are non-terminal drill diagnostics, correlated
  // with the drill ID so the later verifier can inspect the exact defer.
  | 'busy-gate-expired'
  // EI-12754: NON-terminal marker — a busy-gate-refused carry-respawn drill was
  // re-queued for exactly one deferred retry at the next settled turn. The
  // retry itself ends in a terminal delivered/dropped row; report/verify
  // deliberately ignore this kind (it is sequence context, not an outcome).
  | 'carry-drill-rearm-queued';

export interface ColdBootDrillLedgerEvent {
  ts: string;
  kind: ColdBootDrillLedgerKind;
  drillId: string;
  ownerId: string;
  sessionClass: string;
  /** Measured at admission; unlike sessionClass these are not caller labels. */
  sourceKind?: SelfSession['sourceKind'];
  bridgeTty?: boolean | null;
  detail?: string;
  lookups?: RecoveryLookup[];
  transcriptPath?: string;
  /** Caller that graded the sample; may differ from the host owner when the
   * injected drill marker delegates grading to a role-scoped successor. */
  gradedByOwnerId?: string;
  /** Host-mirrored terminal rows (EI-12655): why a carry was dropped / a respawn failed. */
  reason?: string;
  /** Busy-gate measurement context for a correlated drill defer. */
  mode?: string;
  capMs?: number | null;
  observedMaxQuietMs?: number | null;
  /** Host-mirrored respawn rows (EI-12655): the successor's fresh native session id. */
  nativeId?: string | null;
  /** EI-12754: set on a terminal drop from a bounded re-armed retry. */
  rearmed?: boolean;
  /** Effective retry cap, final prompt quiet threshold, and verifier support reason. */
  maxAttempts?: number | null;
  quietMs?: number | null;
  verifier?: string | null;
}

export interface ColdBootDrillHostEvent {
  ts?: string;
  kind?: string;
  drillId?: string;
  sessionClass?: string;
  nativeId?: string | null;
  mode?: string;
  launchContextPath?: string | null;
  reason?: string;
  /** The host may retry this respawn attempt; a later lifecycle row settles it. */
  retryable?: boolean;
  /** Wait budget the host stamped on a busy-gate / re-arm row, ms. Read by
   *  carry-respawn-outcome to decide when a `pending` attempt is past the window
   *  in which it could still fire (see isOrphanedPendingRespawn). */
  capMs?: number | null;
  /** Longest observed quiet window before the busy gate deferred this event. */
  observedMaxQuietMs?: number | null;
  /** Effective retry cap, final prompt quiet threshold, and verifier support reason. */
  maxAttempts?: number | null;
  quietMs?: number | null;
  verifier?: string | null;
  /** Set by the host on a terminal row that came from a re-armed (re-polled) attempt,
   *  e.g. `respawn-carry-dropped {reason:'superseded', rearmed:true}`. Not read by the
   *  outcome derivation; declared so fixtures copied from a real log type-check. */
  rearmed?: boolean;
}

export function coldBootDrillLedgerPath(dir: string = PSU_PTY_DIR): string {
  return join(dir, DRILL_LEDGER_FILE);
}

export function ownerHostEventPath(ownerId: string, dir: string = PSU_PTY_DIR): string {
  return join(dir, `${sanitizeKey(ownerId)}.events.jsonl`);
}

function parseJsonl<T>(body: string, requireComplete = false): T[] {
  if (requireComplete && body && !body.endsWith('\n')) throw new Error('Incomplete carry ledger final row');
  const out: T[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (requireComplete && (!row || typeof row !== 'object' || Array.isArray(row) ||
          typeof row.kind !== 'string' || typeof row.ts !== 'string' || !Number.isFinite(Date.parse(row.ts)))) {
        throw new Error('Invalid carry ledger row');
      }
      if (row && typeof row === 'object') out.push(row as T);
    } catch (error) {
      if (requireComplete) throw error;
      // A host can be appending while the reader snapshots the file. A partial
      // final row is not a drill failure; the next grade/report sees it.
    }
  }
  return out;
}

export async function readColdBootDrillLedger(
  dir: string = PSU_PTY_DIR, opts: { requireComplete?: boolean } = {},
): Promise<ColdBootDrillLedgerEvent[]> {
  try {
    return parseJsonl<ColdBootDrillLedgerEvent>(await fs.readFile(coldBootDrillLedgerPath(dir), 'utf8'), opts.requireComplete);
  } catch (error) {
    if (opts.requireComplete) throw error;
    return [];
  }
}

export async function readOwnerHostEvents(
  ownerId: string,
  dir: string = PSU_PTY_DIR,
  opts: { requireComplete?: boolean } = {},
): Promise<ColdBootDrillHostEvent[]> {
  try {
    return parseJsonl<ColdBootDrillHostEvent>(await fs.readFile(ownerHostEventPath(ownerId, dir), 'utf8'), opts.requireComplete);
  } catch (error) {
    if (opts.requireComplete) throw error;
    return [];
  }
}

/** Bounded append in the existing psu-pty event directory. Unlike the host's
 * per-owner log, this small roll-up contains only drill lifecycle/sample rows so
 * a class report never scans thousands of unrelated owner files. */
export async function appendColdBootDrillLedgerEvent(
  event: ColdBootDrillLedgerEvent,
  dir: string = PSU_PTY_DIR,
): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const path = coldBootDrillLedgerPath(dir);
    try {
      const stat = await fs.stat(path);
      if (stat.size > DRILL_LEDGER_MAX_BYTES) {
        const body = await fs.readFile(path, 'utf8');
        await fs.writeFile(path, body.slice(Math.floor(body.length / 2)).replace(/^[^\n]*\n/, ''), { mode: 0o600 });
      }
    } catch {
      // First append creates the file.
    }
    await fs.appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await fs.chmod(path, 0o600);
    return true;
  } catch {
    return false;
  }
}

function latestActiveDrill(
  events: readonly ColdBootDrillLedgerEvent[],
  ownerId: string,
): ColdBootDrillLedgerEvent | null {
  const terminal = new Set(
    events
      .filter((event) => event.ownerId === ownerId && event.kind === 'carry-drill-request-failed')
      .map((event) => event.drillId),
  );
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (
      event.ownerId === ownerId &&
      (event.kind === 'carry-drill-requested' || event.kind === 'carry-drill-queued') &&
      !terminal.has(event.drillId)
    ) return event;
  }
  return null;
}

async function defaultTranscript(ownerId: string): Promise<SelfSession | null> {
  return resolveSelfSession(ownerId);
}

/**
 * Keep the existing global cold-by-default classifier Claude-only: changing its
 * vocabulary would alter live wake policy. Drills for another backend instead
 * get a backend-qualified local class so their evidence cannot accidentally
 * satisfy a Claude rollout gate.
 */
function sessionClassForDrill(host: PsuPtyHost, sourceKind: SelfSession['sourceKind']): string {
  if (sourceKind === 'claude') return sessionClassForHost(host);
  return `${sourceKind}-${host.bridgeTty === false ? 'headless' : 'interactive'}`;
}

async function defaultEffectiveWindow(ownerId: string): Promise<number> {
  try {
    const spec = await resolveModelSpecForOwner(ownerId);
    return spec ? modelWindowForSpec(spec) : DEFAULT_COLD_BOOT_DRILL_WINDOW_TOKENS;
  } catch {
    return DEFAULT_COLD_BOOT_DRILL_WINDOW_TOKENS;
  }
}

export interface StartColdBootDrillInput {
  ownerId: string;
  ownerLabel: string;
  workspaceId?: string | null;
  sessionClass?: string;
  effectiveWindowTokens?: number;
  /** Explicit retry acknowledgement for a bounded/unreadable owner-request
   *  history. Never bypasses a known unresolved owner message. */
  acknowledgeOwnerHistoryUncertainty?: boolean;
  /** Optional durable campaign/operator context for the requested ledger row. */
  note?: string;
  minIntervalMs?: number;
}

export interface StartColdBootDrillDeps {
  now: () => number;
  newId: () => string;
  findHost: (ownerId: string) => Promise<PsuPtyHost | null>;
  resolveTranscript: (ownerId: string) => Promise<SelfSession | null>;
  resolveEffectiveWindow: (ownerId: string) => Promise<number>;
  buildBrief: (ownerId: string, workspaceId?: string) => Promise<CarryBrief | null>;
  flushGate: (input: Parameters<typeof runFlushGate>[0]) => Promise<FlushGateOutcome>;
  buildSpec: (
    ownerId: string,
    input: Parameters<typeof buildOwnerRespawnLaunchSpec>[1],
  ) => Promise<RespawnLaunchSpec | null>;
  inject: typeof injectIntoHost;
  tagTurn: typeof tagTurnForInjection;
  readLedger: () => Promise<ColdBootDrillLedgerEvent[]>;
  appendLedger: (event: ColdBootDrillLedgerEvent) => Promise<boolean>;
}

function startDeps(overrides: Partial<StartColdBootDrillDeps>): StartColdBootDrillDeps {
  return {
    now: Date.now,
    newId: randomUUID,
    findHost: findLiveHostAsync,
    resolveTranscript: defaultTranscript,
    resolveEffectiveWindow: defaultEffectiveWindow,
    buildBrief: async (ownerId, workspaceId) => {
      try { return await buildCarryBrief(ownerId, { workspaceId }); } catch { return null; }
    },
    flushGate: runFlushGate,
    buildSpec: buildOwnerRespawnLaunchSpec,
    inject: injectIntoHost,
    tagTurn: tagTurnForInjection,
    readLedger: readColdBootDrillLedger,
    appendLedger: appendColdBootDrillLedgerEvent,
    ...overrides,
  };
}

export type StartColdBootDrillResult =
  | {
      ok: true;
      drillId: string;
      sessionClass: string;
      queued: true;
      nextAllowedAt: string;
      ownerHistoryUncertaintyAcknowledged?: true;
    }
  | {
      ok: false;
      error: string;
      note: string;
      retryAt?: string;
      tripwires?: unknown[];
      historyStatus?: 'truncated' | 'unreadable';
    };

export async function startColdBootDrill(
  input: StartColdBootDrillInput,
  overrides: Partial<StartColdBootDrillDeps> = {},
): Promise<StartColdBootDrillResult> {
  const deps = startDeps(overrides);
  const ownerId = input.ownerId.trim();
  const now = deps.now();
  const interval = Math.max(60_000, input.minIntervalMs ?? DEFAULT_COLD_BOOT_DRILL_INTERVAL_MS);
  if (!ownerId) return { ok: false, error: 'owner_required', note: 'A drill must target the calling session owner.' };

  const host = await deps.findHost(ownerId);
  if (!host || !hostSupports(host, 'carry-respawn')) {
    return {
      ok: false,
      error: host ? 'host_missing_carry_respawn_capability' : 'no_live_pty_host',
      note: 'P-020 drills require a live managed psu host advertising carry-respawn; no process was cut.',
    };
  }
  const active = latestActiveDrill(await deps.readLedger(), ownerId);
  const activeAt = active ? Date.parse(active.ts) : NaN;
  if (active && Number.isFinite(activeAt) && now - activeAt < interval) {
    const retryAt = new Date(activeAt + interval).toISOString();
    return {
      ok: false,
      error: 'drill_rate_limited',
      note: `The last live cut for this owner is inside the ${Math.round(interval / 60_000)}-minute chaos interval.`,
      retryAt,
    };
  }

  const transcript = await deps.resolveTranscript(ownerId);
  if (!transcript) {
    return { ok: false, error: 'transcript_unavailable', note: 'The current managed session transcript could not be resolved; no process was cut.' };
  }
  // P-021: Claude keeps the exact canonical classifier vocabulary shared with
  // cold-by-default. Other backends are deliberately qualified locally; their
  // drill samples must never count as evidence for a Claude actuation class.
  // An explicit caller class still wins for scoped campaigns.
  const sessionClass = input.sessionClass?.trim() || sessionClassForDrill(host, transcript.sourceKind);

  const workspaceId = input.workspaceId ?? '*';
  const brief = await deps.buildBrief(ownerId, input.workspaceId ?? undefined);
  const gate = await deps.flushGate({
    boundary: 'compaction',
    ownerId,
    workspaceId,
    sessionId: ownerId,
    sinceIso: new Date(now - 30 * 60_000).toISOString(),
    brief,
    nowMs: now,
  });
  if (gate.verdict === 'refuse') {
    return {
      ok: false,
      error: 'flush_required',
      note: gate.refusalText ?? 'Flush the named state, then explicitly start the drill again.',
      tripwires: gate.tripwires,
    };
  }

  const effectiveWindowTokens =
    typeof input.effectiveWindowTokens === 'number' && input.effectiveWindowTokens > 0
      ? input.effectiveWindowTokens
      : await deps.resolveEffectiveWindow(ownerId);
  const spec = await deps.buildSpec(ownerId, {
    effectiveWindowTokens,
    buildOpts: {
      workspaceId: input.workspaceId ?? undefined,
      ownerLabel: input.ownerLabel,
      transcriptPath: transcript.filePath,
      transcriptSourceKind: transcript.sourceKind,
      boundaryDeliberate: true,
    },
  });
  if (!spec) {
    return { ok: false, error: 'carry_build_failed', note: 'The deterministic carry could not be assembled; the current process remains alive.' };
  }
  const ownerGate = spec.openOwnerQuestion;
  const acknowledgedHistoryUncertainty =
    ownerGate.crossesOpenOwnerMessage &&
    ownerGate.basis === 'history-uncertain' &&
    input.acknowledgeOwnerHistoryUncertainty === true;
  if (ownerGate.crossesOpenOwnerMessage && !acknowledgedHistoryUncertainty) {
    if (ownerGate.basis === 'history-uncertain') {
      return {
        ok: false,
        error: 'owner_history_uncertain',
        historyStatus: ownerGate.historyStatus,
        note:
          `Owner-request history is ${ownerGate.historyStatus ?? 'unknown'}; the drill cannot prove there is no older open request from its bounded tail. ` +
          'After reconciling the owner request and checkpointing the current lane, retry with acknowledgeOwnerHistoryUncertainty:true. ' +
          'That acknowledgement never bypasses a known unresolved owner message.',
      };
    }
    // Missing basis is treated as known-unanswered for compatibility with an
    // older/custom RespawnLaunchSpec: uncertainty is acknowledgeable only when
    // the canonical builder positively typed it as such.
    return {
      ok: false,
      error: 'open_owner_message',
      note: 'The last owner message is unanswered. This deliberate chaos cut refuses rather than crossing it.',
    };
  }

  const drillId = deps.newId();
  const requested: ColdBootDrillLedgerEvent = {
    ts: new Date(now).toISOString(),
    kind: 'carry-drill-requested',
    drillId,
    ownerId,
    sessionClass,
    sourceKind: transcript.sourceKind,
    bridgeTty: host.bridgeTty ?? null,
    ...(input.note?.trim() ? { detail: input.note.trim() } : {}),
  };
  if (!(await deps.appendLedger(requested))) {
    return { ok: false, error: 'drill_ledger_unavailable', note: 'The drill could not be durably registered, so no process was cut.' };
  }

  const firstPrompt = [
    `⟦carry-drill:${drillId}⟧`,
    'This is an opt-in P-020 cold-boot carry-sufficiency drill on a fresh process.',
    MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION,
    'Continue the carried work.',
    'Do not search/read your prior self session unless the carry is actually insufficient; ordinary source reads are fine.',
    `At the next clean boundary call session:carry-drill { op: "grade", drillId: "${drillId}" } exactly once.`,
  ].join('\n');
  const taggedFirstPrompt = (await deps.tagTurn({
    sid: ownerId,
    origin: 'watchdog',
    text: firstPrompt,
  })).taggedText;
  const injected = await deps.inject(host.sock, {
    mode: 'carry-respawn',
    data: taggedFirstPrompt,
    // EI-153 addressing: a carry-respawn RE-EXECS the receiving CLI on someone
    // else's carry document, so an UNADDRESSED one is the highest-severity
    // unowned write in this path — the host guard is predicated on `ownerId`
    // being present and ABSTAINS (silently accepts) without it. The autorunner
    // drives this over `listLiveHosts()` with the flag default ON, so every
    // live host is reachable; naming the addressee lets a host that finds
    // itself holding another agent's drill refuse it instead of respawning.
    ownerId,
    systemPromptAddendum: spec.systemPromptAddendum,
    drillId,
    sessionClass,
  });
  if (!injected) {
    await deps.appendLedger({
      ...requested,
      ts: new Date(deps.now()).toISOString(),
      kind: 'carry-drill-request-failed',
      detail: 'control socket did not acknowledge the request',
    });
    return { ok: false, error: 'carry_respawn_inject_failed', note: 'The host did not acknowledge the cut; the current process remains available.' };
  }
  await deps.appendLedger({ ...requested, ts: new Date(deps.now()).toISOString(), kind: 'carry-drill-queued' });
  return {
    ok: true,
    drillId,
    sessionClass,
    queued: true,
    nextAllowedAt: new Date(now + interval).toISOString(),
    ...(acknowledgedHistoryUncertainty ? { ownerHistoryUncertaintyAcknowledged: true as const } : {}),
  };
}

function reportFromLedger(events: readonly ColdBootDrillLedgerEvent[]): CarrySufficiencyReport {
  const samples = new Map<string, DrillSample>();
  for (const event of events) {
    if (event.kind !== 'carry-drill-graded' || !Array.isArray(event.lookups)) continue;
    samples.set(event.drillId, {
      sessionClass: normalizeSessionClass(event.sessionClass),
      lookups: event.lookups,
    });
  }
  return gradeColdBootDrills([...samples.values()], DEFAULT_SUFFICIENCY_PARAMS);
}

/** Per-class roll-up of the host-mirrored TERMINAL drill outcomes (EI-12655).
 *  Counts drills (unique drillIds), not raw rows — a retried mirror write can
 *  duplicate a row, and one drill must never count twice. */
export interface ClassTerminalOutcomes {
  sessionClass: string;
  respawned: number;
  respawnFailed: number;
  delivered: number;
  dropped: number;
  /** dropped-drill count per drop reason (busy-gate-expired / never-settled /
   *  no-startup-ready-marker / no-first-prompt / superseded / ...). */
  dropReasons: Record<string, number>;
}

export function terminalOutcomesFromLedger(
  events: readonly ColdBootDrillLedgerEvent[],
): ClassTerminalOutcomes[] {
  const KIND_TO_FIELD: Partial<Record<ColdBootDrillLedgerKind, keyof Omit<ClassTerminalOutcomes, 'sessionClass' | 'dropReasons'>>> = {
    'carry-drill-respawned': 'respawned',
    'carry-drill-respawn-failed': 'respawnFailed',
    'carry-drill-carry-delivered': 'delivered',
    'carry-drill-carry-dropped': 'dropped',
  };
  const byClass = new Map<string, ClassTerminalOutcomes>();
  const seen = new Set<string>();
  for (const event of events) {
    const field = KIND_TO_FIELD[event.kind];
    if (!field || !event.drillId) continue;
    const dedupeKey = `${event.drillId}\x00${event.kind}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const sessionClass = event.sessionClass || 'unknown';
    const agg =
      byClass.get(sessionClass) ??
      ({ sessionClass, respawned: 0, respawnFailed: 0, delivered: 0, dropped: 0, dropReasons: {} } satisfies ClassTerminalOutcomes);
    agg[field] += 1;
    if (field === 'dropped') {
      const reason = event.reason || 'unknown';
      agg.dropReasons[reason] = (agg.dropReasons[reason] ?? 0) + 1;
    }
    byClass.set(sessionClass, agg);
  }
  return [...byClass.values()];
}

// ── EI-12755: carry-drill drop scanning (pure half of the drop watchdog) ─────
// Ledger rows are durable but nobody reads them until someone asks — the 2/2
// silent drill failures of 2026-07-15 sat unnoticed ~40 minutes. The watchdog
// (system-health/carry-drill-drop-watchdog.ts) sweeps the shared ledger with
// this pure scanner and escalates each fresh drop once.

/** The terminal kinds a human should hear about in real time. */
const DROP_ALERT_KINDS: ReadonlySet<string> = new Set([
  'carry-drill-carry-dropped',
  'carry-drill-respawn-failed',
]);

export interface CarryDrillDropAlert {
  drillId: string;
  ownerId: string;
  sessionClass: string;
  kind: string;
  reason: string;
  ts: string;
}

/**
 * Scan ledger events for terminal DROP rows newer than `sinceMs`, deduped per
 * (drillId, kind). Returns the alerts plus the advanced watermark (the newest
 * scanned drop-row ts, or `sinceMs` when nothing qualified) so a caller can
 * sweep incrementally without re-alerting old rows. Pure; exported for tests.
 */
export function scanCarryDrillDrops(
  events: readonly ColdBootDrillLedgerEvent[],
  sinceMs: number,
): { alerts: CarryDrillDropAlert[]; watermarkMs: number } {
  const alerts: CarryDrillDropAlert[] = [];
  const seen = new Set<string>();
  let watermarkMs = sinceMs;
  for (const event of events) {
    if (!DROP_ALERT_KINDS.has(event.kind) || !event.drillId) continue;
    const tsMs = Date.parse(event.ts);
    if (!Number.isFinite(tsMs) || tsMs <= sinceMs) continue;
    // A superseded carry is an intentional retirement after a newer respawn,
    // not a lost continuation. Preserve its event in the ledger, but do not
    // page it as a failed drill; advance the scan watermark so it is not
    // reconsidered on every sweep.
    if (event.kind === 'carry-drill-carry-dropped' && event.reason === 'superseded') {
      if (tsMs > watermarkMs) watermarkMs = tsMs;
      continue;
    }
    const dedupeKey = `${event.drillId}\x00${event.kind}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (tsMs > watermarkMs) watermarkMs = tsMs;
    alerts.push({
      drillId: event.drillId,
      ownerId: event.ownerId || 'unknown',
      sessionClass: event.sessionClass || 'unknown',
      kind: event.kind,
      reason: event.reason || 'unknown',
      ts: event.ts,
    });
  }
  return { alerts, watermarkMs };
}

async function safeReadCarry(path: string, root: string = CARRY_ROOT): Promise<string | null> {
  try {
    const [realRoot, realPath] = await Promise.all([fs.realpath(root), fs.realpath(path)]);
    if (realPath !== realRoot && !realPath.startsWith(realRoot + sep)) return null;
    const stat = await fs.stat(realPath);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
    return await fs.readFile(realPath, 'utf8');
  } catch {
    return null;
  }
}

export interface GradeColdBootDrillDeps {
  readLedger: () => Promise<ColdBootDrillLedgerEvent[]>;
  appendLedger: (event: ColdBootDrillLedgerEvent) => Promise<boolean>;
  readHostEvents: (ownerId: string) => Promise<ColdBootDrillHostEvent[]>;
  readCarry: (path: string) => Promise<string | null>;
  loadTranscript: (ownerId: string, nativeId: string | null) => Promise<ReplayTranscript | null>;
  now: () => number;
}

function gradeDeps(overrides: Partial<GradeColdBootDrillDeps>): GradeColdBootDrillDeps {
  return {
    readLedger: readColdBootDrillLedger,
    appendLedger: appendColdBootDrillLedgerEvent,
    readHostEvents: readOwnerHostEvents,
    readCarry: safeReadCarry,
    loadTranscript: async (ownerId, nativeId) => {
      const resolved =
        (nativeId ? await resolveOwnerIsolatedSessionByPrefix(ownerId, nativeId) : null) ??
        await resolveSelfSession(ownerId);
      if (!resolved) return null;
      try {
        return parseTranscriptJsonl(await fs.readFile(resolved.filePath, 'utf8'), resolved.filePath);
      } catch {
        return null;
      }
    },
    now: Date.now,
    ...overrides,
  };
}

export type GradeColdBootDrillResult =
  | {
      ok: true;
      drillId: string;
      sample: DrillSample;
      report: CarrySufficiencyReport;
      transcriptPath: string;
      alreadyGraded: boolean;
    }
  | { ok: false; error: string; note: string };

export async function gradeColdBootDrill(
  graderOwnerId: string,
  drillId: string,
  overrides: Partial<GradeColdBootDrillDeps> = {},
): Promise<GradeColdBootDrillResult> {
  const deps = gradeDeps(overrides);
  const ledger = await deps.readLedger();
  // startColdBootDrill creates drillId with randomUUID() and embeds it in the
  // injected successor prompt. That opaque marker is the one-drill delegation
  // capability: the successor may run under a role-scoped principal whose
  // ownerId differs from the host that owns the transcript. Keep all storage
  // reads and attribution anchored to the recorded source owner.
  const drillRows = ledger.filter((event) => event.drillId === drillId);
  const ownerIds = [...new Set(drillRows.map((event) => event.ownerId))];
  if (ownerIds.length === 0) {
    return { ok: false, error: 'unknown_drill', note: 'No durable drill request matches this id.' };
  }
  if (ownerIds.length !== 1) {
    return { ok: false, error: 'ambiguous_drill', note: 'The drill id is recorded under multiple owners; refusing to select a transcript.' };
  }
  const drillOwnerId = ownerIds[0];
  const requested = drillRows.find(
    (event) => event.ownerId === drillOwnerId && (event.kind === 'carry-drill-requested' || event.kind === 'carry-drill-queued'),
  ) ?? drillRows.find((event) => event.ownerId === drillOwnerId);
  if (!requested) {
    return { ok: false, error: 'unknown_drill', note: 'No durable drill request matches this id.' };
  }

  const existing = ledger.find(
    (event) => event.drillId === drillId && event.ownerId === drillOwnerId && event.kind === 'carry-drill-graded',
  );
  if (existing?.lookups) {
    const sample = { sessionClass: existing.sessionClass, lookups: existing.lookups };
    return {
      ok: true,
      drillId,
      sample,
      report: reportFromLedger(ledger),
      transcriptPath: existing.transcriptPath ?? '',
      alreadyGraded: true,
    };
  }

  const hostEvents = await deps.readHostEvents(drillOwnerId);
  const respawn = [...hostEvents].reverse().find(
    (event) => event.kind === 'carry-drill-respawned' && event.drillId === drillId,
  );
  if (!respawn) {
    const failure = [...hostEvents].reverse().find(
      (event) => event.kind === 'carry-drill-respawn-failed' && event.drillId === drillId,
    );
    if (failure) {
      return {
        ok: false,
        error: 'respawn_failed',
        note: `The host kept the current process alive because drill respawn preparation failed (${failure.reason ?? 'unknown reason'}).`,
      };
    }
    return { ok: false, error: 'respawn_not_observed', note: 'The host has not durably recorded this drill successor yet.' };
  }
  if (!respawn.launchContextPath) {
    return { ok: false, error: 'carry_path_missing', note: 'The host event lacks the delivered carry-file path; refusing to guess.' };
  }
  const carryText = await deps.readCarry(respawn.launchContextPath);
  if (carryText == null) {
    return { ok: false, error: 'carry_unreadable', note: 'The recorded carry file is absent, unsafe, or unreadable.' };
  }
  const transcript = await deps.loadTranscript(drillOwnerId, respawn.nativeId ?? null);
  if (!transcript) {
    return { ok: false, error: 'successor_transcript_unavailable', note: 'The fresh native transcript is not readable yet; grade at the next clean boundary.' };
  }

  const marker = `⟦carry-drill:${drillId}⟧`;
  const markerAt = transcript.turns.findIndex((turn) => turn.text.includes(marker));
  if (markerAt < 0) {
    return { ok: false, error: 'drill_marker_missing', note: 'The successor transcript does not contain the exact drill marker.' };
  }
  const gradeAt = transcript.turns.findIndex((turn, index) => {
    if (index <= markerAt || turn.role !== 'tool_use') return false;
    return (turn.toolName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').endsWith('sessioncarrydrill') && turn.text.includes(drillId);
  });
  const window = transcript.turns.slice(markerAt + 1, gradeAt >= 0 ? gradeAt + 1 : undefined);
  const sample: DrillSample = {
    sessionClass: requested.sessionClass,
    lookups: extractRecoveryLookups(window, carryText),
  };
  const graded: ColdBootDrillLedgerEvent = {
    ts: new Date(deps.now()).toISOString(),
    kind: 'carry-drill-graded',
    drillId,
    ownerId: drillOwnerId,
    gradedByOwnerId: graderOwnerId,
    sessionClass: requested.sessionClass,
    lookups: sample.lookups,
    transcriptPath: transcript.ref,
  };
  if (!(await deps.appendLedger(graded))) {
    return { ok: false, error: 'grade_persist_failed', note: 'The mechanical sample was computed but could not be durably recorded.' };
  }
  return {
    ok: true,
    drillId,
    sample,
    report: reportFromLedger([...ledger, graded]),
    transcriptPath: transcript.ref,
    alreadyGraded: false,
  };
}

/** The op:'report' shape: graded per-class sufficiency PLUS the host-mirrored
 *  terminal outcomes (EI-12655) — so a class whose drills all DROP (perClass
 *  empty because nothing was ever graded) is visible as dropped counts instead
 *  of an empty report. */
export type ColdBootDrillReport = CarrySufficiencyReport & {
  terminalOutcomes: ClassTerminalOutcomes[];
};

export async function reportColdBootDrills(
  readLedger: () => Promise<ColdBootDrillLedgerEvent[]> = readColdBootDrillLedger,
): Promise<ColdBootDrillReport> {
  const events = await readLedger();
  return { ...reportFromLedger(events), terminalOutcomes: terminalOutcomesFromLedger(events) };
}

// ── op:'verify' — the silent-vanish recurrence guard (EI-12655 fix c) ─────────
// 2/2 first-generation drills failed with NO caller-visible trace: `start`
// returned ok/queued and everything after was fire-and-forget. verify makes the
// post-start lifecycle assertable: given a drillId (or the owner's latest),
// check each durable leg the drill MUST have left behind and report
// per-assertion pass/fail instead of an opaque "grade found nothing".

export interface VerifyColdBootDrillDeps {
  readLedger: () => Promise<ColdBootDrillLedgerEvent[]>;
  readHostEvents: (ownerId: string) => Promise<ColdBootDrillHostEvent[]>;
  socketExists: (ownerId: string) => Promise<boolean>;
}

function verifyDeps(overrides: Partial<VerifyColdBootDrillDeps>): VerifyColdBootDrillDeps {
  return {
    readLedger: readColdBootDrillLedger,
    readHostEvents: readOwnerHostEvents,
    socketExists: async (ownerId) => {
      try {
        const host = await findLiveHostAsync(ownerId);
        return !!host && (await fs.stat(host.sock)).isSocket();
      } catch {
        return false;
      }
    },
    ...overrides,
  };
}

export interface VerifyAssertion {
  name: 'ledger-registered' | 'host-respawned' | 'terminal-outcome' | 'owner-socket-live';
  pass: boolean;
  detail: string;
}

export type VerifyColdBootDrillResult =
  | { ok: true; drillId: string; sessionClass: string; pass: boolean; assertions: VerifyAssertion[] }
  | { ok: false; error: string; note: string };

export async function verifyColdBootDrill(
  ownerId: string,
  input: { drillId?: string; sessionClass?: string } = {},
  overrides: Partial<VerifyColdBootDrillDeps> = {},
): Promise<VerifyColdBootDrillResult> {
  const deps = verifyDeps(overrides);
  const ledger = await deps.readLedger();
  const mine = ledger.filter((event) => event.ownerId === ownerId);
  let drillId = input.drillId?.trim() || '';
  if (!drillId) {
    for (let i = mine.length - 1; i >= 0; i -= 1) {
      const event = mine[i];
      if (event.kind !== 'carry-drill-requested') continue;
      if (input.sessionClass && event.sessionClass !== input.sessionClass) continue;
      drillId = event.drillId;
      break;
    }
    if (!drillId) {
      return {
        ok: false,
        error: 'no_drill_found',
        note: 'No drill request is registered for this owner (and session class) in the shared ledger.',
      };
    }
  }
  const rows = mine.filter((event) => event.drillId === drillId);
  const registered = rows.find(
    (event) => event.kind === 'carry-drill-requested' || event.kind === 'carry-drill-queued',
  );
  if (!registered && input.drillId) {
    return { ok: false, error: 'unknown_drill', note: 'No durable drill request matches this owner and id.' };
  }
  const hostEvents = (await deps.readHostEvents(ownerId)).filter((event) => event.drillId === drillId);
  const respawned =
    hostEvents.some((event) => event.kind === 'carry-drill-respawned') ||
    rows.some((event) => event.kind === 'carry-drill-respawned');
  const TERMINAL_KINDS = new Set([
    'carry-drill-carry-delivered',
    'carry-drill-carry-dropped',
    'carry-drill-respawn-failed',
    'carry-drill-request-failed',
    'carry-drill-graded',
  ]);
  const terminal =
    hostEvents.find((event) => TERMINAL_KINDS.has(event.kind ?? '')) ??
    [...rows].reverse().find((event) => TERMINAL_KINDS.has(event.kind));
  const socketLive = await deps.socketExists(ownerId);
  const assertions: VerifyAssertion[] = [
    {
      name: 'ledger-registered',
      pass: Boolean(registered),
      detail: registered
        ? `requested/queued at ${registered.ts} (class ${registered.sessionClass || 'unknown'})`
        : 'no requested/queued row in the shared drill ledger',
    },
    {
      name: 'host-respawned',
      pass: respawned,
      detail: respawned
        ? 'the host durably recorded the successor cut (carry-drill-respawned)'
        : 'no carry-drill-respawned event in the host log or shared ledger — the cut never happened or the host died before recording it',
    },
    {
      name: 'terminal-outcome',
      pass: Boolean(terminal),
      detail: terminal
        ? `${terminal.kind}${terminal.reason ? ` (${terminal.reason})` : ''} at ${terminal.ts ?? 'unknown ts'}`
        : 'no terminal event (delivered/dropped/failed/graded) — the drill is pending or vanished silently (the EI-12655 class)',
    },
    {
      name: 'owner-socket-live',
      pass: socketLive,
      detail: socketLive
        ? 'the owner control socket exists (host alive and injectable)'
        : 'the owner control socket is missing — the host is down; nothing can be injected',
    },
  ];
  const sessionClass = registered?.sessionClass || rows[0]?.sessionClass || input.sessionClass || 'unknown';
  return { ok: true, drillId, sessionClass, pass: assertions.every((a) => a.pass), assertions };
}

export interface CarryDrillMeasurementInput {
  ownerId: string;
  drillId: string;
  windowStart: string;
  windowEnd: string;
}

export interface CarryDrillMeasurement {
  verdict: 'pass' | 'fail' | 'unknown';
  reason: string;
  /** This detector covers the lifecycle, never the whole shipment contract. */
  scope: 'selected-codex-interactive-drill';
  drillId: string;
  ownerId: string;
  nativeId?: string;
  transcriptRef?: string;
  requestedAt?: string;
  gaps?: number;
  surfacingGaps?: number;
}

/**
 * Reuse the drill's ledger, exact successor transcript, carry reader and verifier.
 * No start/grade/retire is invoked here. In particular, a failed terminal outcome
 * satisfies verify's liveness diagnostic but MUST NOT satisfy this instrument.
 * Deployment identity, independent acceptance, class-wide sufficiency, report and
 * supported cleanup remain separate R-7 evidence obligations.
 */
export async function measureCarryDrillLifecycle(
  input: CarryDrillMeasurementInput,
  overrides: Partial<Pick<GradeColdBootDrillDeps, 'readLedger' | 'readHostEvents' | 'readCarry' | 'loadTranscript'> &
    Pick<VerifyColdBootDrillDeps, 'socketExists'> & Pick<StartColdBootDrillDeps, 'findHost'>> = {},
): Promise<CarryDrillMeasurement> {
  const result = (verdict: CarryDrillMeasurement['verdict'], reason: string,
    extra: Partial<CarryDrillMeasurement> = {}): CarryDrillMeasurement => ({
    verdict, reason, scope: 'selected-codex-interactive-drill', ownerId: input.ownerId, drillId: input.drillId, ...extra,
  });
  const start = Date.parse(input.windowStart), end = Date.parse(input.windowEnd);
  if (!input.ownerId?.trim() || !input.drillId?.trim() || !Number.isFinite(start) || !Number.isFinite(end) || start >= end)
    return result('unknown', 'An exact owner, drill and non-empty observation window are required.');
  try {
    const readLedger = overrides.readLedger ?? (() => readColdBootDrillLedger(PSU_PTY_DIR, { requireComplete: true }));
    const readHostEvents = overrides.readHostEvents ?? ((ownerId: string) => readOwnerHostEvents(ownerId, PSU_PTY_DIR, { requireComplete: true }));
    const ledger = await readLedger();
    const rows = ledger.filter(row => row.drillId === input.drillId);
    if (!rows.length) return result('unknown', 'No native ledger evidence for the selected drill.');
    if (rows.some(row => row.ownerId !== input.ownerId || row.sessionClass !== 'codex-interactive'))
      return result('fail', 'The selected drill has a foreign owner or unsupported session class.');
    const requested = rows.filter(row => row.kind === 'carry-drill-requested');
    if (requested.length !== 1) return result('fail', 'Exactly one durable request is required.');
    if (rows.some(row => !Number.isFinite(Date.parse(row.ts)) || Date.parse(row.ts) < start || Date.parse(row.ts) > end))
      return result('unknown', 'Drill evidence is incomplete or outside the selected window.');
    const failed = new Set(['carry-drill-request-failed', 'carry-drill-respawn-failed', 'carry-drill-carry-dropped']);
    if (rows.some(row => failed.has(row.kind))) return result('fail', 'The selected drill recorded a failed or dropped outcome.');
    const host = (await readHostEvents(input.ownerId)).filter(row => row.drillId === input.drillId);
    if (host.some(row => !row.ts || !Number.isFinite(Date.parse(row.ts)) || Date.parse(row.ts) < start || Date.parse(row.ts) > end))
      return result('unknown', 'Host evidence is incomplete or outside the selected window.');
    if (host.some(row => failed.has(row.kind ?? ''))) return result('fail', 'The owner host recorded a failed or dropped outcome.');
    const respawns = host.filter(row => row.kind === 'carry-drill-respawned');
    const grades = rows.filter(row => row.kind === 'carry-drill-graded');
    if (respawns.length > 1 || grades.length > 1) return result('fail', 'Duplicate respawn or durable grade.');
    const respawn = respawns[0], grade = grades[0];
    if (!respawn?.nativeId || !respawn.launchContextPath || !grade || !Array.isArray(grade.lookups) ||
        !rows.some(row => row.kind === 'carry-drill-queued') ||
        !host.some(row => row.kind === 'carry-drill-carry-delivered'))
      return result('unknown', 'Queued, delivered, exact successor and durable grade evidence are required.');
    if (grade.gradedByOwnerId !== input.ownerId) return result('fail', 'The grade was not recorded by the addressed owner.');
    // Read admission-time facts so supported cleanup cannot invalidate the
    // historical class. Old hosts without these facts remain explicitly unknown.
    if (!requested[0].sourceKind || requested[0].bridgeTty == null)
      return result('unknown', 'Actual admission-time backend and interactive host identity are unproven.');
    if (requested[0].sourceKind !== 'codex' || requested[0].bridgeTty !== true)
      return result('fail', 'Actual admission-time host class contradicts the caller label.');
    const carry = await (overrides.readCarry ?? safeReadCarry)(respawn.launchContextPath);
    const loadTranscript = overrides.loadTranscript ?? (async (ownerId: string, nativeId: string | null) => {
      // Never borrow the current session when this exact native successor is missing.
      const resolved = nativeId ? await resolveOwnerIsolatedSessionByPrefix(ownerId, nativeId) : null;
      return resolved?.sourceKind === 'codex'
        ? parseTranscriptJsonl(await fs.readFile(resolved.filePath, 'utf8'), resolved.filePath) : null;
    });
    const transcript = await loadTranscript(input.ownerId, respawn.nativeId);
    if (!carry || !transcript || transcript.backend !== 'codex') return result('unknown', 'The exact Codex successor transcript and carry must be readable.');
    const markerAt = transcript.turns.findIndex(turn => turn.role === 'user' && turn.text.includes(`⟦carry-drill:${input.drillId}⟧`));
    if (markerAt < 0 || !carry.includes(input.ownerId)) return result('fail', 'The exact addressed carry and drill marker are absent.');
    const calls = transcript.turns.map((turn, index) => ({ turn, index })).filter(({ turn, index }) => index > markerAt &&
      turn.role === 'tool_use' && (turn.toolName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').endsWith('sessioncarrydrill'));
    const operation = (text: string, op: string) => new RegExp(`["']?op["']?\\s*:\\s*["']${op}["']`).test(text);
    const gradesCalled = calls.filter(({ turn }) => turn.text.includes(input.drillId) && operation(turn.text, 'grade'));
    if (gradesCalled.length > 1) return result('fail', 'The successor invoked grade more than once.');
    const gradeAt = gradesCalled[0]?.index;
    if (gradeAt === undefined) return result('unknown', 'The native transcript has no direct drill-grade boundary; do not infer one from prose.');
    if (!calls.some(({ turn, index }) => index > gradeAt && operation(turn.text, 'verify') && turn.text.includes(input.drillId)) ||
        !calls.some(({ turn, index }) => index > gradeAt && operation(turn.text, 'report')))
      return result('unknown', 'The successor must record verify and report after its single grade.');
    // Require the actual verifier result, not just a call or a currently live
    // socket. Native result envelopes may wrap the JSON in MCP text content.
    const verifyAt = calls.find(({ turn, index }) => index > gradeAt && operation(turn.text, 'verify') && turn.text.includes(input.drillId))!.index;
    const decode = (value: unknown, depth = 0): Record<string, unknown>[] => {
      if (depth > 5) return [];
      if (typeof value === 'string') { try { return decode(JSON.parse(value), depth + 1); } catch { return []; } }
      if (Array.isArray(value)) return value.flatMap(item => decode(item, depth + 1));
      if (!value || typeof value !== 'object') return [];
      const object = value as Record<string, unknown>;
      return [object, ...decode(object.content, depth + 1), ...decode(object.text, depth + 1)];
    };
    const verifyResults = transcript.turns.slice(verifyAt + 1).filter(turn => turn.role === 'tool_result')
      .flatMap(turn => decode(turn.text)).filter(row => row.drillId === input.drillId && Array.isArray(row.assertions));
    if (!verifyResults.length) return result('unknown', 'The native successful verifier receipt is missing.');
    const expectedAssertions = ['ledger-registered', 'host-respawned', 'terminal-outcome', 'owner-socket-live'];
    if (verifyResults.some(row => row.ok !== true || row.pass !== true || row.sessionClass !== 'codex-interactive' ||
        !expectedAssertions.every(name => (row.assertions as VerifyAssertion[]).some(assertion => assertion.name === name && assertion.pass === true))))
      return result('fail', 'The native lifecycle verifier did not pass every required assertion.');
    const lookups = extractRecoveryLookups(transcript.turns.slice(markerAt + 1, gradeAt + 1), carry);
    if (JSON.stringify(lookups) !== JSON.stringify(grade.lookups)) return result('fail', 'The saved grade differs from the exact native recovery window.');
    const gaps = lookups.filter(lookup => classifyRecoveryLookup(lookup) === 'gap').length;
    const surfacingGaps = lookups.filter(lookup => classifyRecoveryLookup(lookup) === 'surfacing-gap').length;
    return result(gaps || surfacingGaps ? 'fail' : 'pass', gaps || surfacingGaps
      ? 'The selected successor has recovery gaps.' : 'Selected drill lifecycle and zero recovery gaps verified; shipment obligations remain separate.',
    { nativeId: respawn.nativeId, transcriptRef: transcript.ref, requestedAt: requested[0].ts, gaps, surfacingGaps });
  } catch (error) {
    return result('unknown', `Native drill evidence unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
