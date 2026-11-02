import { joinPartsIntoPlan, parsePlan, splitPlanIntoParts } from './parser';

/** Receipt emitted by coordination/tools/promote.ts, never author scope.
 * Reuse the fence-aware plan splitter so quoted examples cannot hide changes.
 * An unmarked or mixed author section remains material in its entirety. */
function withoutPromotionReceipts(body: string): string {
  return joinPartsIntoPlan(splitPlanIntoParts(body).filter(part => {
    if (part.kind !== 'section') return true;
    const lines = part.text.split('\n').map(line => line.trim()).filter(Boolean);
    return !(lines[0] === '## Promoted'
      && lines[1] === '<!-- plan-pipeline: do not edit this block manually -->'
      && lines.length > 2
      && lines.slice(2).every(line => /^- \[[ x]\] (?:F|WI)-[A-Z0-9-]+ — .+$/.test(line)));
  }));
}

/** Execution scope excludes progress, but includes decisions and dependencies. */
export function planExecutionMeaning(content: string): string {
  const parsed = parsePlan(content);
  const { status: _status, updated: _updated, ...frontmatter } = parsed.frontmatter.raw;
  let body = withoutPromotionReceipts(parsed.prose);
  if (parsed.now) body = body.replace(parsed.now.raw, '');
  for (const item of parsed.items) body = body.replace(item.rawLine,
    item.rawLine.replace(/`[a-z-]+`/, item.storedStatus === 'dropped' ? '`dropped`' : '`live`'));
  return JSON.stringify([Object.entries(frontmatter).sort(), body.replace(/\s+/g, ' ').trim()]);
}
