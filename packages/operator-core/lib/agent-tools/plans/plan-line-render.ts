import { maskFences, parsePlan, renderPlanItem, type PlanItem } from '@papercusp/plan-parser';
import type { PlanIndexItem } from './derive-index';

/** Replace only item lines. All other bytes (including free prose) belong to the author. */
export function renderPlanLines(content: string, items: readonly PlanIndexItem[]): string {
  const parsed = parsePlan(content);
  // Parser coordinates are relative to the body AFTER the frontmatter fence.
  const prefix = content.slice(0, content.length - parsed.prose.length);
  const offset = (prefix.match(/\n/g) ?? []).length;
  const itemLines = new Set(parsed.items.map((item) => item.lineNumber + offset));
  const priorById = new Map(parsed.items.map((item) => [item.id, item]));
  const lines = content.split('\n');
  const masked = maskFences(content).split('\n');
  const output: string[] = [];
  let phase: string | null = null;
  let next = 0;
  const emit = () => {
    const item = items[next++];
    if (phase !== item.phase) {
      output.push('', item.phase ? `## ${item.phase}` : '## Items', '');
      phase = item.phase;
    }
    output.push(renderPlanItem({
      ...priorById.get(item.id), ...item, storedStatus: item.status, lineNumber: 0, rawLine: '',
    } as PlanItem));
  };
  const emitRest = () => { while (next < items.length) emit(); };
  for (let i = 0; i < lines.length; i++) {
    if (itemLines.has(i + 1)) {
      if (next < items.length) emit();
      continue;
    }
    if (/^## (?:\d+(?:\.\d+)?\.\s+)?Decisions\b/.test(masked[i])) emitRest();
    const heading = /^## (?:\d+(?:\.\d+)?\.\s+)?(.+?)\s*$/.exec(masked[i]);
    if (heading) phase = /^Phase\b/i.test(heading[1]) ? heading[1] : null;
    output.push(lines[i]);
  }
  emitRest();
  return output.join('\n');
}
