import { NOTE_SUFFIX_RE } from '@papercusp/plan-parser';

/**
 * Does the item's latest injected note attribute its current block to `workItemId`?
 *
 * Keep this parser-backed predicate in a leaf module: the scheduler lane guard
 * needs the same decision as plans:set-status, but importing the write-side tool
 * from the guard pulls in the full lifecycle dependency graph and its failures
 * are otherwise indistinguishable from a negative attribution result.
 */
export function noteAttributesBlockTo(itemText: string | undefined, workItemId: string): boolean {
  if (!itemText || !workItemId) return false;
  const matched = itemText.match(NOTE_SUFFIX_RE);
  if (!matched) return false;
  const note = matched[0].toLowerCase();
  if (!note.includes(workItemId.toLowerCase())) return false;
  return note.includes('blocked') || note.includes('needs-human');
}
