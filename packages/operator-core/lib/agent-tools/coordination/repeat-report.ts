/**
 * WI-6554700010029331 — the `repeat_report_no_delta` rail on coord:send.
 *
 * A directed, unthreaded send that re-cites, to the SAME recipients, work items
 * the sender already reported to them inside the window — when none of those
 * items has changed in a way the recipient can see — is refused. The recipient
 * already has the report; a second copy is noise that buries the messages that
 * do carry news.
 *
 * Measured on the Luna Max drain fleet (2026-10-26, 10:32–19:55Z, member
 * senders): 153 of 813 member messages (19%) re-cited only items they had
 * already sent to the same recipients within 6h, with no other-agent or
 * state-changing write on those items in between. 88% of unprompted repeats
 * originated at machine-started turns (loop fires, compaction successors,
 * wake-pumps) that cannot see what the previous turn already said — so the
 * rail has to live at the send seam, not in a prompt.
 *
 * "Changed in a way the recipient can see" = the item's state token moved:
 * status, holder, the state/claim/release/admission timestamps, or the count of
 * active external blockers. The sender's OWN checkpoints and comments do not
 * move it — they are exactly what a re-announcing turn writes before it
 * re-announces.
 *
 * Two doors stay open and the refusal names both: reply to the prior message
 * (`related_msg_id`) saying what changed — a threaded follow-up is never judged
 * here — or record the wait once with `work_items:set_blocker` and stay quiet.
 *
 * This module is the PURE judgement; `repeat-report-reads.ts` reads the inputs
 * (fail-open: a failed read never refuses a message).
 */
import { workItemRefsIn } from '../../goal-owner-report';

/** Envelope field: the state token of each cited work item at send time — the next send's baseline. */
export const CITED_ITEM_STATES_FIELD = 'citedItemStates';
/** Refusal code returned to the sender. */
export const REPEAT_REPORT_REFUSAL = 'repeat_report_no_delta';
/** How far back a prior send to the same recipients counts as "already reported". */
export const REPEAT_REPORT_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Upper bound on prior messages read per check (one writer, one window). */
export const REPEAT_REPORT_PRIOR_SCAN_CAP = 200;

export interface CitedItemState {
  ref: string;
  token: string;
}

/** The fields of one work item that make up its recipient-visible state. */
export interface ItemStateRow {
  ref: string;
  status: string;
  holder: string | null;
  stateChangedAt: string | null;
  takenAt: string | null;
  lastReleasedAt: string | null;
  admittedAt: string | null;
  activeBlockers: number;
}

/** One message the same writer sent inside the window. */
export interface PriorSend {
  msgId: string;
  ts: string;
  to: readonly string[];
  /** Summary + body text, the surface refs are cited in. */
  text: string;
  /** The prior message's own stamp, when it was sent after this rail shipped. */
  citedItemStates: CitedItemState[] | null;
}

export interface RepeatedRef {
  ref: string;
  priorMsgId: string;
  priorTs: string;
  status: string;
  holder: string | null;
}

export type RepeatReportVerdict =
  | { kind: 'pass'; stamps: CitedItemState[] }
  | { kind: 'refuse'; stamps: CitedItemState[]; repeats: RepeatedRef[] };

const msOf = (value: string | null): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/** The item's recipient-visible state as one comparable string. */
export function itemStateToken(row: ItemStateRow): string {
  return [
    row.status,
    row.holder ?? '',
    msOf(row.stateChangedAt) ?? '',
    msOf(row.takenAt) ?? '',
    msOf(row.lastReleasedAt) ?? '',
    msOf(row.admittedAt) ?? '',
    `b${row.activeBlockers}`,
  ].join('|');
}

/** Order-insensitive identity of a recipient list. */
export function recipientSetKey(to: readonly string[]): string {
  return [...new Set(to)].sort().join('\n');
}

/** The work-item refs a message cites in its summary and body. */
export function citedWorkItemRefs(summary: string | null | undefined, bodyText: string | null | undefined): string[] {
  return workItemRefsIn(`${summary ?? ''}\n${bodyText ?? ''}`);
}

/** Read a persisted `citedItemStates` stamp back; anything malformed reads as absent. */
export function readCitedItemStates(value: unknown): CitedItemState[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    return typeof row.ref === 'string' && typeof row.token === 'string' ? [{ ref: row.ref, token: row.token }] : [];
  });
}

/**
 * Did the item change, in a recipient-visible way, after `prior` was sent?
 * A stamped prior compares tokens exactly; an unstamped one (sent before this
 * rail shipped) compares the item's state timestamps against the prior's send time.
 */
function changedSince(prior: PriorSend, ref: string, row: ItemStateRow): boolean {
  const stamped = prior.citedItemStates?.find((state) => state.ref === ref);
  if (stamped) return stamped.token !== itemStateToken(row);
  const priorMs = msOf(prior.ts);
  if (priorMs === null) return true;
  return [row.stateChangedAt, row.takenAt, row.lastReleasedAt, row.admittedAt].some((at) => {
    const ms = msOf(at);
    return ms !== null && ms > priorMs;
  });
}

/**
 * Judge one send. Refuses only when EVERY cited ref was already sent to this
 * exact recipient set inside the window and none of them changed since. Any new
 * ref, any changed ref, or any ref whose state could not be read passes the
 * whole message.
 *
 * `current` null = the state read failed: pass, unstamped (fail-open).
 * `judge` false = stamp only (a threaded reply is never judged).
 */
export function judgeRepeatReport(input: {
  refs: readonly string[];
  to: readonly string[];
  priors: readonly PriorSend[];
  current: ReadonlyMap<string, ItemStateRow> | null;
  judge: boolean;
  /** This send's own deterministic msg_id (an idempotent retry) — never its own prior. */
  ownMsgId?: string;
  nowMs?: number;
}): RepeatReportVerdict {
  if (input.refs.length === 0 || input.current === null) return { kind: 'pass', stamps: [] };
  const current = input.current;
  const stamps = input.refs.flatMap((ref) => {
    const row = current.get(ref);
    return row ? [{ ref, token: itemStateToken(row) }] : [];
  });
  if (!input.judge) return { kind: 'pass', stamps };

  const key = recipientSetKey(input.to);
  const sinceMs = (input.nowMs ?? Date.now()) - REPEAT_REPORT_WINDOW_MS;
  const sameRecipients = input.priors
    .filter((prior) => prior.msgId !== input.ownMsgId && recipientSetKey(prior.to) === key)
    .filter((prior) => (msOf(prior.ts) ?? 0) >= sinceMs)
    .sort((a, b) => (msOf(b.ts) ?? 0) - (msOf(a.ts) ?? 0));

  const repeats: RepeatedRef[] = [];
  for (const ref of input.refs) {
    const row = current.get(ref);
    if (!row) return { kind: 'pass', stamps };
    const prior = sameRecipients.find((candidate) => workItemRefsIn(candidate.text).includes(ref));
    if (!prior || changedSince(prior, ref, row)) return { kind: 'pass', stamps };
    repeats.push({ ref, priorMsgId: prior.msgId, priorTs: prior.ts, status: row.status, holder: row.holder });
  }
  return { kind: 'refuse', stamps, repeats };
}

/** The sender-facing refusal text. Names the prior message(s) and both doors. */
export function describeRepeatReportRefusal(repeats: readonly RepeatedRef[]): string {
  const lines = repeats.slice(0, 5).map(
    (repeat) =>
      `${repeat.ref} (sent ${repeat.priorTs} in ${repeat.priorMsgId}; still ${repeat.status}` +
      `${repeat.holder ? `, held by ${repeat.holder}` : ', unheld'})`,
  );
  const first = repeats[0]?.priorMsgId ?? '<prior msg_id>';
  return (
    'Nothing was sent: you already reported every work item this message cites to these same recipients ' +
    `within ${REPEAT_REPORT_WINDOW_MS / 3_600_000}h, and none of them has changed since — ` +
    `${lines.join('; ')}${repeats.length > 5 ? `; +${repeats.length - 5} more` : ''}. ` +
    'The recipients already have that report. If something DID change that the item does not show, ' +
    `reply to your earlier message instead — related_msg_id:'${first}' — and say what changed. ` +
    'If you are only waiting on it, record that once with work_items:set_blocker on the item and stay quiet ' +
    'until it moves; a new report is accepted as soon as the item changes state, holder, admission or blockers.'
  );
}
