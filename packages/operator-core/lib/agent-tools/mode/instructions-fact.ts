/**
 * Render the durable fact body for a mode's instructions.
 * Keep this pure formatter in a leaf so callers do not load mode:set's store,
 * coordination, goal, and release configuration dependencies.
 */
export function renderModeInstructionsFact(opts: {
  modeId: string;
  instructions: string;
  ownerDirected: boolean;
  setBy: string;
}): string {
  const who = opts.ownerDirected ? 'the owner' : opts.setBy;
  return (
    `${opts.modeId.toUpperCase()} SCOPE — while '${opts.modeId}' is on, obey this verbatim: ` +
    `${opts.instructions.trim()} ` +
    `(set by ${who}; retracted when the mode is turned off)`
  );
}
