import { describe, expect, it } from 'vitest';
import { assertManagedToolSuccess, finishManagedApiTeardown } from './__fixtures__/managed-api-result';

describe('managed HTTP acceptance failure evidence', () => {
  it('keeps a plain-text refusal when no JSON body exists', () => {
    const message = 'tool_error: systemd-run refused: Failed to connect to bus';
    expect(() => assertManagedToolSuccess('capability:pty_open', {
      isError: true, content: [{ type: 'text', text: message }],
    }, null)).toThrow(message);
  });

  it('keeps structured and media evidence alongside the rejected operation', () => {
    let caught: unknown;
    try {
      assertManagedToolSuccess('capability:fetch', {
        isError: true,
        content: [{ type: 'resource', resource: { uri: 'papercusp://scratch/owned-ref' } }],
        structuredContent: { reason: 'browser_operation_aborted' },
        _meta: { stage: 'launch' },
      }, { ok: false });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    const evidence = JSON.parse((caught as Error).message);
    expect(evidence).toMatchObject({ name: 'capability:fetch', body: { ok: false },
      content: [{ resource: { uri: 'papercusp://scratch/owned-ref' } }],
      structuredContent: { reason: 'browser_operation_aborted' }, meta: { stage: 'launch' } });
  });

  it('accepts successful non-text results without requiring a JSON body', () => {
    expect(() => assertManagedToolSuccess('capability:pty_read_screen', {
      content: [{ type: 'resource', resource: { text: 'terminal screen' } }],
    }, null)).not.toThrow();
  });
});

describe('managed HTTP acceptance teardown', () => {
  it('preserves an early request failure and tears down when no browser opened', async () => {
    const primary = new Error('pty_confinement_unavailable');
    const closed: string[] = [];
    const run = async () => {
      try { throw primary; }
      finally {
        await finishManagedApiTeardown({ hasProof: false, rowCount: 0, cleanupErrors: [],
          close: ['clients', 'http', 'pages', 'database'].map(name => async () => { closed.push(name); }) });
      }
    };
    await expect(run()).rejects.toBe(primary);
    expect(closed).toEqual(['clients', 'http', 'pages', 'database']);
  });

  it('checks the success-only browser census after every venue has closed', async () => {
    const closed: string[] = [];
    await expect(finishManagedApiTeardown({ hasProof: true, rowCount: 0, cleanupErrors: [],
      close: ['clients', 'http', 'database'].map(name => async () => { closed.push(name); }) }))
      .rejects.toThrow('one owned browser is expected');
    expect(closed).toEqual(['clients', 'http', 'database']);
    await expect(finishManagedApiTeardown({ hasProof: true, rowCount: 1, cleanupErrors: [], close: [] }))
      .resolves.toBeUndefined();
  });

  it('continues teardown after a close failure and reports the failed cleanup', async () => {
    const closed: string[] = [];
    const cleanupErrors: unknown[] = [];
    const failure = new Error('HTTP close failed');
    await expect(finishManagedApiTeardown({ hasProof: false, rowCount: 0, cleanupErrors, close: [
      async () => { closed.push('http'); throw failure; },
      async () => { closed.push('database'); },
    ] })).rejects.toThrow('Owned resource cleanup failed');
    expect(closed).toEqual(['http', 'database']);
    expect(cleanupErrors).toEqual([failure]);
  });
});
