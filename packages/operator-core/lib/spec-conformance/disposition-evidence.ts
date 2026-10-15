/** R-20: a reference alone does not establish that an owner directive was carried out. */
export const URL_ONLY_DISPOSITION_ERROR = 'url_only_done_note' as const;
export const URL_ONLY_DISPOSITION_HINT =
  'Describe what was verified and its result; URLs may support that evidence but cannot be the entire done note.';

export function hasOnlyUrlReferences(note: string): boolean {
  let references = 0;
  const withoutLinks = note
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    // A Markdown label does not turn a link into verification evidence.
    .replace(/\[[^\]\n]*\]\(\s*(?:[a-z][a-z\d+.-]*:\/\/|\/reports[?#/])[^\s]+(?:\s+"[^"\n]*")?\s*\)/gi, () => {
      references += 1;
      return '';
    })
    .replace(/(?:[a-z][a-z\d+.-]*:\/\/|\/reports[?#/])[^\s<>]+/gi, () => {
      references += 1;
      return '';
    });
  // Ignore presentation around bare links, including Markdown lists and code fences.
  return references > 0 && !/[\p{L}\p{N}]/u.test(withoutLinks);
}
