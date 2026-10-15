/**
 * WI-1613086 — the production seam must FORWARD its execution options to the release executor.
 *
 * The resume capability (candidateImageId + resumePhase) is validated and consumed inside
 * `executeGcpImageFamilyRelease`.  Every test that calls that library function DIRECTLY passes
 * while the production seam silently drops the argument, which is exactly how the resume path
 * shipped as `done` and was still unreachable from any real release: the seam called the executor
 * with two arguments, so `execution` defaulted to `{}` on every production run.
 *
 * This guard therefore asserts the HOP, not the destination.  It lives in its own file because
 * `vi.mock` is file-wide: mocking the executor is the only way to observe what the seam passed,
 * and scoping that mock here keeps it from silently applying to unrelated composition tests.
 */
import type { WorkspaceHostProviderConnection } from '@papercusp/deployment-driver';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeGcpImageFamilyRelease, GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS } from './gcp-image-family';
import { executeConfiguredGcpImageFamilyRelease } from './gcp-image-family-production';

vi.mock('./gcp-image-family', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./gcp-image-family')>()),
  executeGcpImageFamilyRelease: vi.fn(async () => ({
    contractVersion: 'papercusp-gcp-image-family-release-v1',
  })),
}));

const PROJECT_ID = 'active-alcove-504205-q3';
const CANDIDATE_IMAGE_ID = `projects/${PROJECT_ID}/global/images/papercusp-workspace-host-0-0-19-candidate`;

const connection = (): WorkspaceHostProviderConnection =>
  ({
    target: 'gcp',
    cloudCredentialRef: { kind: 'cloud', ref: 'gcloud://active-user' },
    scope: { kind: 'project', id: PROJECT_ID },
    provider: { projectId: PROJECT_ID },
  }) as WorkspaceHostProviderConnection;

/** Adapter seams only; the executor itself is mocked, so nothing here reaches Google. */
const compositionOptions = () => ({
  acquireAuth: async () => ({ accessToken: 'token', projectId: PROJECT_ID }),
  commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
});

const executorMock = vi.mocked(executeGcpImageFamilyRelease);

describe('executeConfiguredGcpImageFamilyRelease execution forwarding', () => {
  beforeEach(() => {
    executorMock.mockClear();
  });

  it('forwards candidateImageId and resumePhase to the release executor', async () => {
    await executeConfiguredGcpImageFamilyRelease(
      { projectId: PROJECT_ID } as never,
      connection(),
      compositionOptions(),
      { candidateImageId: CANDIDATE_IMAGE_ID, resumePhase: 'scan' },
    );

    expect(executorMock).toHaveBeenCalledTimes(1);
    const call = executorMock.mock.calls[0];
    // The drop mode this guard exists for: a two-argument call. Assert the arity explicitly so a
    // regression reports "seam dropped the argument" rather than "expected {…} to equal undefined".
    expect(call).toHaveLength(3);
    expect(call?.[2]).toEqual({
      candidateImageId: CANDIDATE_IMAGE_ID,
      resumePhase: 'scan',
    });
  });

  it('forwards the publish resume phase as well as scan', async () => {
    await executeConfiguredGcpImageFamilyRelease(
      { projectId: PROJECT_ID } as never,
      connection(),
      compositionOptions(),
      { candidateImageId: CANDIDATE_IMAGE_ID, resumePhase: 'publish' },
    );

    expect(executorMock.mock.calls[0]?.[2]).toEqual({
      candidateImageId: CANDIDATE_IMAGE_ID,
      resumePhase: 'publish',
    });
  });

  it('still passes an explicit empty execution when the caller omits one', async () => {
    // The default-rebuild path must remain a real forwarded value rather than an absent argument,
    // so the seam has exactly one calling convention for the executor to validate.
    await executeConfiguredGcpImageFamilyRelease(
      { projectId: PROJECT_ID } as never,
      connection(),
      compositionOptions(),
    );

    const call = executorMock.mock.calls[0];
    expect(call).toHaveLength(3);
    expect(call?.[2]).toEqual({});
  });

  it('CONTROL: the pre-fix two-argument seam is caught by these assertions', async () => {
    // Falsifiability control, permanently in-tree because the subject is an imported module and
    // mutating the shared checkout to prove a guard is unsafe here (git-sync sweeps it mid-probe).
    //
    // This is the LITERAL pre-fix body of executeConfiguredGcpImageFamilyRelease: it reaches the
    // executor the same way, through the same mock, but omits the third argument. It is exercised
    // against the same observation channel the assertions above read, so if those assertions ever
    // stop distinguishing a forwarded execution from a dropped one, this control goes green and
    // the guard is vacuous.
    await executeGcpImageFamilyRelease(
      { projectId: PROJECT_ID } as never,
      {} as never,
    );

    const call = executorMock.mock.calls[0];
    expect(call).toHaveLength(2);
    expect(call?.[2]).toBeUndefined();
  });
});

/**
 * WI-10006408 — the same HOP for the request's SBOM-derived guest-tool versions: the seam must
 * hand them to the adapter that pins the image provenance, and refuse a contradicting operator
 * file before the executor (and so before any billable build) runs.
 */
describe('executeConfiguredGcpImageFamilyRelease guest-tool version forwarding', () => {
  const derived = Object.fromEntries(
    GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS.map((name, index) => [name, `1.${index}-1.el10`]),
  );
  const pinnedBy = (adapter: unknown) =>
    (adapter as { pinnedGuestToolVersions?: Readonly<Record<string, string>> }).pinnedGuestToolVersions;

  beforeEach(() => {
    executorMock.mockClear();
  });

  it('pins the adapter to the request-carried SBOM versions when no operator file is given', async () => {
    await executeConfiguredGcpImageFamilyRelease(
      { projectId: PROJECT_ID, guestToolVersions: derived } as never,
      connection(),
      compositionOptions(),
    );
    expect(executorMock).toHaveBeenCalledTimes(1);
    expect(pinnedBy(executorMock.mock.calls[0]?.[1])).toEqual(derived);
  });

  it('accepts an operator file that restates the SBOM versions', async () => {
    await executeConfiguredGcpImageFamilyRelease(
      { projectId: PROJECT_ID, guestToolVersions: derived } as never,
      connection(),
      { ...compositionOptions(), guestToolVersions: { curl: ` ${derived.curl} ` } },
    );
    expect(pinnedBy(executorMock.mock.calls[0]?.[1])).toEqual(derived);
  });

  it('refuses an operator file that contradicts the SBOM before the executor runs', async () => {
    await expect(
      executeConfiguredGcpImageFamilyRelease(
        { projectId: PROJECT_ID, guestToolVersions: derived } as never,
        connection(),
        { ...compositionOptions(), guestToolVersions: { 'google-guest-agent': '0.1' } },
      ),
    ).rejects.toThrow(/disagrees with the bake SBOM: google-guest-agent \(override 0\.1; SBOM /);
    expect(executorMock).not.toHaveBeenCalled();
  });

  it('CONTROL: an adapter composed without the request versions is not pinned', async () => {
    // Without this, pinnedBy() reading the wrong field would make the first case pass vacuously.
    await executeConfiguredGcpImageFamilyRelease({ projectId: PROJECT_ID } as never, connection(), compositionOptions());
    expect(pinnedBy(executorMock.mock.calls[0]?.[1])).toBeUndefined();
  });
});
