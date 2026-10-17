/**
 * Prefix a carry-respawn continuation with the owner it was written for.
 *
 * Carry delivery is owner-keyed, but the continuation text is still the
 * content every delivery path carries. Keeping this guard pure and separate
 * lets every fallback producer apply the same content-level provenance before
 * tagging or injecting the prompt.
 */
export function addressContinuationToOwner(note: string, ownerId: string): string {
  const sid = String(ownerId ?? '').trim();
  if (!sid) return note;
  return (
    `ADDRESSED TO ${sid} — this continuation was written for that session. ` +
    'The host checks this address against the receiving session before delivery. ' +
    'Continue the saved lane below.\n\n' +
    note
  );
}
