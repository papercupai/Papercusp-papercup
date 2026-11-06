/** Pure turn grouping shared by the GUI timeline and native sidebar projection. */
import type { AgentTimelineEntry as TimelineEntry } from '@papercusp/operator-core/lib/cross-boundary-event-contracts';

export type { AgentTimelineEntry as TimelineEntry } from '@papercusp/operator-core/lib/cross-boundary-event-contracts';

export interface Turn {
  seq: number;
  prompt: TimelineEntry | null;
  entries: TimelineEntry[];
  startTs?: string;
  endTs?: string;
}

export function groupEntriesIntoTurns(entries: readonly TimelineEntry[]): Turn[] {
  const turns: Turn[] = [];
  for (const e of entries) {
    if (e.kind === 'prompt') {
      turns.push({ seq: turns.length, prompt: e, entries: [], startTs: e.ts, endTs: e.ts });
      continue;
    }
    let cur = turns[turns.length - 1];
    if (!cur) {
      cur = { seq: 0, prompt: null, entries: [], startTs: e.ts, endTs: e.ts };
      turns.push(cur);
    }
    cur.entries.push(e);
    if (e.ts) cur.endTs = e.ts;
  }
  return turns;
}
