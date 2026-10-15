/**
 * Leaf module for the severe-event EMITTER stamp, split out of severe-event-broadcast.ts
 * so a reader (coord:inbox) can recognise the rendered trailer without importing the
 * broadcast path (messages, inbox-wake, the events-await engine). The writer and the
 * reader therefore share ONE renderer, and the reader's exact-match check cannot drift
 * from what the writer appends.
 */

/**
 * WI-7309: identity of the PROCESS that emitted an alarm.
 *
 * Stamped on every severe-event broadcast because on this box the emitter's AGE is the
 * decisive forensic fact and nothing else in the envelope carries it. Long-lived
 * `tsx bin/hono-host.ts` hosts run from the STAGING tree with no hot-reload, so each
 * executes a frozen snapshot of the code from whenever it started (measured 2026-08-03:
 * one at 8.4h, one at 7.8 DAYS). A fix can therefore be committed, green-gated, deployed
 * and verified live by every available check — `--is-ancestor`, blob identity, served sha
 * — while one of those hosts keeps paging the PRE-FIX text forever. No deploy reaches it.
 *
 * Without these fields attribution has to be reconstructed indirectly, from in-memory
 * streak arithmetic cross-referenced against `ps` by hand. That cost two agents ~1h on
 * 2026-08-03 and still ended UNDETERMINED. With them it is a field read.
 */
export interface SevereEventEmitter {
  pid: number;
  /**
   * ISO time this PROCESS started — THE discriminator. A process that started before
   * your fix landed has not loaded it, whatever the deployed sha reports.
   */
  startedAt: string;
  uptimeSec: number;
  /** cwd of the emitting process: WHICH CHECKOUT it executes from (staging vs release). */
  cwd: string;
}

/** Snapshot the current process's identity. Never throws — an alarm must still fire. */
export function severeEventEmitter(): SevereEventEmitter {
  let uptimeSec = 0;
  let cwd = '(unknown)';
  let pid = -1;
  try {
    uptimeSec = Math.max(0, Math.round(process.uptime()));
  } catch {
    /* best-effort: an unusable clock must never suppress the alarm */
  }
  try {
    cwd = process.cwd();
  } catch {
    /* best-effort */
  }
  try {
    if (typeof process.pid === 'number') pid = process.pid;
  } catch {
    /* best-effort */
  }
  return { pid, startedAt: new Date(Date.now() - uptimeSec * 1000).toISOString(), uptimeSec, cwd };
}

/**
 * The interpretation rule the trailer carries. Exported separately so a bounded reader
 * that strips N identical trailers can state the rule ONCE instead of dropping it.
 */
export const SEVERE_EVENT_EMITTER_RULE =
  'If that start time PREDATES the fix you are checking, this process never loaded it ' +
  '(no hot-reload) and no deploy will reach it — restart that host instead of re-investigating the alarm.';

/**
 * One-line trailer appended to the alarm BODY. The structured `extra.emitter` is what SQL
 * queries; this is what an agent reading coord:inbox actually sees, so it carries the
 * INTERPRETATION RULE and not only the raw numbers — the rule is the part that was missing.
 */
export function renderSevereEventEmitter(e: SevereEventEmitter): string {
  const h = Math.floor(e.uptimeSec / 3600);
  const m = Math.floor((e.uptimeSec % 3600) / 60);
  const age = h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
  return (
    `\n\n— emitted by pid ${e.pid}, process started ${e.startedAt} (up ${age}), cwd ${e.cwd}. ` +
    SEVERE_EVENT_EMITTER_RULE
  );
}

/** Narrow an envelope field to a SevereEventEmitter, or undefined. Pure. */
export function asSevereEventEmitter(v: unknown): SevereEventEmitter | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (
    typeof r['pid'] !== 'number' ||
    typeof r['startedAt'] !== 'string' ||
    typeof r['uptimeSec'] !== 'number' ||
    typeof r['cwd'] !== 'string'
  ) {
    return undefined;
  }
  return { pid: r['pid'], startedAt: r['startedAt'], uptimeSec: r['uptimeSec'], cwd: r['cwd'] };
}
