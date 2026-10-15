// WI-10005446: the production callers (gcp-provider, initialization-operations-resolver,
// gcp-image-family-production) compose the active-user acquirer with NO injected exec, so the
// process-wide memo is what stops bg-host forking three gcloud CLIs on every acquire. This file
// drives that real-exec path with node:child_process mocked, which gcp-preflight.test.ts cannot
// do without mocking the module for every other test in it.
import { describe, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile,
}));

import { GCP_GCLOUD_ACTIVE_USER_CREDENTIAL_REF, createGcpWorkspaceHostAcquireAuth } from './gcp-preflight';

const PROJECT = 'active-alcove-504205-q3';

describe('gcloud active-user acquirer on the real exec path', () => {
  it('shares one process-wide resolution across separately composed acquirers', async () => {
    execFile.mockImplementation(
      (_file: string, args: string[], _opts: unknown, callback: (error: null, out: { stdout: string; stderr: string }) => void) => {
        const stdout =
          args[0] === 'auth' && args[1] === 'list'
            ? 'developer@example.com\n'
            : args[0] === 'auth' && args[1] === 'print-access-token'
              ? 'ya29.shared-memo-test-token\n'
              : `${PROJECT}\n`;
        callback(null, { stdout, stderr: '' });
      },
    );

    const first = createGcpWorkspaceHostAcquireAuth(GCP_GCLOUD_ACTIVE_USER_CREDENTIAL_REF);
    const second = createGcpWorkspaceHostAcquireAuth(GCP_GCLOUD_ACTIVE_USER_CREDENTIAL_REF);

    await expect(first()).resolves.toMatchObject({ identity: 'developer@example.com', projectId: PROJECT });
    expect(execFile).toHaveBeenCalledTimes(3);

    await expect(second()).resolves.toMatchObject({ identity: 'developer@example.com', projectId: PROJECT });
    expect(execFile).toHaveBeenCalledTimes(3);
  });
});
