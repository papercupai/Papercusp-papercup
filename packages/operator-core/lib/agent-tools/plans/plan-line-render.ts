import { isItemContinuation, maskFences, parsePlan, renderPlanItem, type PlanItem } from '@papercusp/plan-parser';
import type { PlanIndexItem } from './derive-index';

/** Replace physical item spans. All other bytes (including free prose) belong to the author. */
export function renderPlanLines(
  content: string,
  items: readonly PlanIndexItem[],
  options: { preserveItemText?: boolean } = {},
): string {
  const parsed = parsePlan(content);
  // Parser coordinates are relative to the body AFTER the frontmatter fence.
  const prefix = content.slice(0, content.length - parsed.prose.length);
  const offset = (prefix.match(/\n/g) ?? []).length;
  const itemLines = new Set(parsed.items.map((item) => item.lineNumber + offset));
  const priorById = new Map(parsed.items.map((item) => [item.id, item]));
  const lines = content.split('\n');
  const masked = maskFences(content).split('\n');
  // The parser already folds these lines into item.text. Retaining them after
  // rendering the logical item would append the same prose on every write.
  const continuationLines = new Set<number>();
  for (const item of parsed.items) {
    for (let i = item.lineNumber + offset; i < lines.length && isItemContinuation(lines[i]); i++) {
      continuationLines.add(i + 1);
    }
  }
  const output: string[] = [];
  let phase: string | null = null;
  let next = 0;
  const emit = () => {
    const item = items[next++];
    const prior = priorById.get(item.id);
    const text = options.preserveItemText && prior ? prior.text : item.text;
    if (phase !== item.phase) {
      output.push('', item.phase ? `## ${item.phase}` : '## Items', '');
      phase = item.phase;
    }
    output.push(renderPlanItem({
      ...prior, ...item, text, storedStatus: item.status, lineNumber: 0, rawLine: '',
    } as PlanItem));
  };
  const emitRest = () => { while (next < items.length) emit(); };
  for (let i = 0; i < lines.length; i++) {
    if (continuationLines.has(i + 1)) continue;
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
