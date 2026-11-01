/** Passive observations only: never focus, map, show or reopen a failing popup. */
export async function sampleNativePopup(
  stage: string,
  readX11: () => Promise<unknown>,
  readNative: () => Promise<unknown>,
) {
  async function observe(read: () => Promise<unknown>) {
    const startedAt = new Date().toISOString();
    try {
      const value = await read();
      return { startedAt, endedAt: new Date().toISOString(), value };
    } catch (error) { return { startedAt, endedAt: new Date().toISOString(), error: String(error) }; }
  }
  // Bracket the bridge call, so observer-induced focus changes differ from an
  // already-hidden popup. Keep OS evidence even when the bridge is dead.
  const x11Before = await observe(readX11);
  const native = await observe(readNative);
  const x11After = await observe(readX11);
  return { stage, x11Before, native, x11After };
}

/** A diagnostic failure must never replace the assertion that actually failed. */
export async function withNativePopupFailure<T>(action: () => Promise<T>, capture: () => Promise<void>): Promise<T> {
  try { return await action(); }
  catch (error) {
    try { await capture(); }
    finally { throw error; }
  }
}
