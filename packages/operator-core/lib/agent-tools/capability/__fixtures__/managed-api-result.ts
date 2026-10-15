import assert from 'node:assert/strict';

/** Preserve the actual MCP reply when a private acceptance call is refused. */
export function assertManagedToolSuccess(name: string, result: {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
  _meta?: unknown;
}, body: unknown): void {
  assert(!result.isError, JSON.stringify({ name, body, content: result.content,
    structuredContent: result.structuredContent, meta: result._meta }));
}

/** Close the private venue before checking assertions that require a successful run. */
export async function finishManagedApiTeardown(options: {
  hasProof: boolean;
  rowCount: number;
  cleanupErrors: unknown[];
  close: ReadonlyArray<() => Promise<unknown>>;
}): Promise<void> {
  for (const close of options.close) {
    try { await close(); }
    catch (error) { options.cleanupErrors.push(error); }
  }
  assert.equal(options.cleanupErrors.length, 0,
    String(new AggregateError(options.cleanupErrors, 'Owned resource cleanup failed')));
  if (options.hasProof) assert.equal(options.rowCount, 1,
    'Refused PTY must create no task row; one owned browser is expected');
}
