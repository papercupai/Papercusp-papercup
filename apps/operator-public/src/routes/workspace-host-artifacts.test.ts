import { sha256Hex } from '@papercusp/artifact-registry';
import {
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
  WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
  WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
  WORKSPACE_HOST_SIDECAR_BUILDER_KIND,
  buildWorkspaceHostBuildManifest,
  deriveWorkspaceHostCanonicalArtifactUrls,
  workspaceHostRequiredReleaseMaterialFixtures,
  type WorkspaceHostImageArtifact,
} from '@papercusp/deployment-driver';
import { afterEach, describe, expect, it } from 'vitest';
import { gcsTestProvider } from '../../../../libs/generic/artifact-registry/src/gcs-test-provider.ts';

import { makeEnv, stubGithub, type FakeR2 } from '../__tests__/fake-d1.ts';
import type { Env } from '../env.ts';
import { buildApi } from './index.ts';
import {
  WORKSPACE_HOST_ARTIFACT_PREFIX,
  WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES,
  WORKSPACE_HOST_PUBLIC_CACHE_CONTROL,
} from './workspace-host-artifacts.ts';

const api = buildApi();
const originalFetch = globalThis.fetch;
const VERSION = '2026.8.25-1';
const SBOM_SHA256 = 'b'.repeat(64);
const ATTESTATION_SHA256 = 'c'.repeat(64);

interface Fixture {
  bundle: Uint8Array;
  bundleSha256: string;
  signature: Uint8Array;
  signatureSha256: string;
  manifest: Record<string, unknown>;
  manifestBytes: Uint8Array;
  manifestSha256: string;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function fixture(
  mutate?: (manifest: Record<string, unknown>) => void,
  bundleOverride?: Uint8Array,
): Promise<Fixture> {
  const bundle = bundleOverride ?? new TextEncoder().encode('verified workspace-host server bundle');
  const signature = new TextEncoder().encode('untrusted comment: signature\nRWSignedBundle');
  const signingPublicKey = 'untrusted comment: Papercusp workspace-host release key\nRWQpublickey';
  const [bundleSha256, signatureSha256, signingKeySha256] = await Promise.all([
    sha256Hex(bundle),
    sha256Hex(signature),
    sha256Hex(new TextEncoder().encode(signingPublicKey)),
  ]);
  const urls = deriveWorkspaceHostCanonicalArtifactUrls(bundleSha256);
  const buildManifest = buildWorkspaceHostBuildManifest({
    contractVersion: WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
    distributionProfile: 'vm-release',
    source: {
      repository: 'https://github.com/Papercusp/papercusp.git',
      revision: '1'.repeat(40),
    },
    releaseArtifact: {
      name: `papercusp-server-${VERSION}.tgz`,
      version: VERSION,
      sha256: bundleSha256,
      sizeBytes: bundle.byteLength,
    },
    baseImage: {
      reference: 'projects/papercusp-images-123/global/images/ubuntu-2404-minimal',
      architecture: 'x86_64',
      sha256: 'd'.repeat(64),
    },
    builder: {
      strategy: 'shared',
      kind: WORKSPACE_HOST_SIDECAR_BUILDER_KIND,
      version: '0.0.18',
      templatePath: 'papercusp-desktop/bin/build-desktop-sidecar.sh',
      templateSha256: 'e'.repeat(64),
    },
    materials: [
      {
        path: 'dist/papercusp-server.tgz',
        sha256: bundleSha256,
        sizeBytes: bundle.byteLength,
      },
      // Derived from the release-gate contract, never restated: a material added there must reach
      // this fixture on its own, or the publisher rejects the upload with a 400 naming a path this
      // file never mentions.
      ...workspaceHostRequiredReleaseMaterialFixtures(),
    ],
    parameters: [{ name: 'distribution_profile', value: 'vm-release' }],
    targets: [{ provider: 'gcp', locations: ['us-central1'] }],
  });
  const artifact: WorkspaceHostImageArtifact = {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    image: { id: 'papercusp-workspace-host', version: VERSION },
    buildManifest,
    release: {
      version: VERSION,
      bundleUrl: urls.bundleUrl,
      bundleSha256,
      signatureUrl: urls.signatureUrl,
      signingPublicKey,
      signingKeySha256,
    },
    lifecycle: { state: 'active', publishedAt: '2026-08-25T00:00:00.000Z' },
    compatibility: [
      {
        provider: 'gcp',
        architecture: 'x86_64',
        ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
        bootstrapContractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
        actions: ['install'],
        maximumArtifactAgeDays: 30,
      },
    ],
  };
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    kind: 'papercusp-workspace-host-release',
    artifact,
    files: {
      bundle: { name: 'server.tgz', sha256: bundleSha256, sizeBytes: bundle.byteLength },
      signature: {
        name: 'server.tgz.minisig',
        sha256: signatureSha256,
        sizeBytes: signature.byteLength,
      },
    },
    trustReport: {
      version: 'artifact-trust-v1',
      subject: {
        path: `dist/papercusp-server-${VERSION}.tgz`,
        name: `papercusp-server-${VERSION}.tgz`,
        bytes: bundle.byteLength,
        sha256: bundleSha256,
        signed: true,
      },
      policy: {
        denyVulnerabilitiesAtOrAbove: 'high',
        maxSecretFindings: 0,
        maxAttestationAgeMs: 60 * 60 * 1_000,
      },
      trusted: true,
      evidence: [
        {
          kind: 'signature',
          subjectSha256: bundleSha256,
          signatureSha256,
          signingKeySha256,
          tool: { name: 'minisign', version: '0.12' },
          valid: true,
        },
        {
          kind: 'sbom',
          subjectSha256: bundleSha256,
          tool: { name: 'syft', version: '1.30' },
          format: 'cyclonedx-json',
          documentSha256: SBOM_SHA256,
          componentCount: 42,
        },
        {
          kind: 'vulnerability-scan',
          subjectSha256: bundleSha256,
          tool: { name: 'grype', version: '0.99' },
          sbomSha256: SBOM_SHA256,
          findings: [],
        },
        {
          kind: 'secret-scan',
          subjectSha256: bundleSha256,
          tool: { name: 'gitleaks', version: '8.28' },
          findings: [],
        },
        {
          kind: 'provenance-attestation',
          subjectSha256: bundleSha256,
          tool: { name: 'cosign', version: '2.5' },
          valid: true,
          predicateType: 'https://slsa.dev/provenance/v1',
          issuedAt: new Date().toISOString(),
          attestationSha256: ATTESTATION_SHA256,
        },
      ],
      failures: [],
    },
  };
  mutate?.(manifest);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  return {
    bundle,
    bundleSha256,
    signature,
    signatureSha256,
    manifest,
    manifestBytes,
    manifestSha256: await sha256Hex(manifestBytes),
  };
}

function authedEnv(): { env: Env; r2: FakeR2 } {
  stubGithub({ user: { id: 7, login: 'operator' } });
  const { env, r2 } = makeEnv({ CUPBOARD_OPERATOR_GITHUB_IDS: '7' });
  return { env, r2 };
}

async function upload(
  env: Env,
  bundleSha256: string,
  file: 'server.tgz' | 'server.tgz.minisig' | 'manifest.json' | 'sbom.cdx.json',
  bytes: Uint8Array,
  declaredSha256: string,
): Promise<Response> {
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return api.request(
    `/admin/artifacts/workspace-host/sha256/${bundleSha256}/${file}`,
    {
      method: 'PUT',
      headers: {
        authorization: 'Bearer github-token',
        'content-type': file === 'manifest.json' ? 'application/json' : 'application/octet-stream',
        'x-artifact-sha256': declaredSha256,
        'x-artifact-size': String(bytes.byteLength),
      },
      body,
    },
    env,
  );
}

interface MultipartPlanPart {
  partNumber: number;
  sha256: string;
  sizeBytes: number;
}

interface UploadedMultipartPart {
  partNumber: number;
  etag: string;
}

async function initiateMultipart(
  env: Env,
  bundleSha256: string,
  sizeBytes: number,
  parts: MultipartPlanPart[],
  operationId: string = crypto.randomUUID(),
): Promise<Response> {
  return api.request(
    `/admin/artifacts/workspace-host/sha256/${bundleSha256}/server.tgz/multipart`,
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer github-token',
        'content-type': 'application/json',
        'x-artifact-sha256': bundleSha256,
        'x-artifact-size': String(sizeBytes),
        'x-operation-id': operationId,
      },
      body: JSON.stringify({ parts }),
    },
    env,
  );
}

async function uploadMultipartPart(
  env: Env,
  bundleSha256: string,
  uploadId: string,
  partNumber: number,
  bytes: Uint8Array,
  declaredSha256: string,
): Promise<Response> {
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return api.request(
    `/admin/artifacts/workspace-host/sha256/${bundleSha256}/server.tgz/multipart/parts/${partNumber}?uploadId=${encodeURIComponent(uploadId)}`,
    {
      method: 'PUT',
      headers: {
        authorization: 'Bearer github-token',
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.byteLength),
        'x-part-sha256': declaredSha256,
        'x-part-size': String(bytes.byteLength),
      },
      body,
    },
    env,
  );
}

async function multipartPartStatus(
  env: Env,
  bundleSha256: string,
  uploadId: string,
  partNumber: number,
): Promise<Response> {
  return api.request(
    `/admin/artifacts/workspace-host/sha256/${bundleSha256}/server.tgz/multipart?uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`,
    { headers: { authorization: 'Bearer github-token' } },
    env,
  );
}

async function completeMultipart(
  env: Env,
  bundleSha256: string,
  uploadId: string,
  parts: UploadedMultipartPart[],
): Promise<Response> {
  return api.request(
    `/admin/artifacts/workspace-host/sha256/${bundleSha256}/server.tgz/multipart/complete?uploadId=${encodeURIComponent(uploadId)}`,
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer github-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ parts }),
    },
    env,
  );
}

async function abortMultipart(
  env: Env,
  bundleSha256: string,
  uploadId: string,
): Promise<Response> {
  return api.request(
    `/admin/artifacts/workspace-host/sha256/${bundleSha256}/server.tgz/multipart?uploadId=${encodeURIComponent(uploadId)}`,
    { method: 'DELETE', headers: { authorization: 'Bearer github-token' } },
    env,
  );
}

async function uploadFixture(env: Env, value: Fixture): Promise<Response[]> {
  return Promise.all([
    upload(env, value.bundleSha256, 'server.tgz', value.bundle, value.bundleSha256),
    upload(env, value.bundleSha256, 'server.tgz.minisig', value.signature, value.signatureSha256),
    upload(env, value.bundleSha256, 'manifest.json', value.manifestBytes, value.manifestSha256),
  ]);
}

async function finalize(env: Env, bundleSha256: string): Promise<Response> {
  return api.request(
    `/admin/artifacts/workspace-host/sha256/${bundleSha256}/finalize`,
    { method: 'POST', headers: { authorization: 'Bearer github-token' } },
    env,
  );
}

describe('workspace-host artifact publication', () => {
  it('finalizes GCS multipart bytes after lost provider responses without changing the operation or generation', async () => {
    stubGithub({ user: { id: 7, login: 'operator' } });
    const provider = gcsTestProvider();
    const { env } = makeEnv({ ARTIFACTS: provider.store, CUPBOARD_OPERATOR_GITHUB_IDS: '7' });
    const value = await fixture();
    const operation = crypto.randomUUID();
    const plan = [{ partNumber: 1, sha256: value.bundleSha256, sizeBytes: value.bundle.length }];
    const publicPath = `/artifacts/workspace-host/sha256/${value.bundleSha256}/server.tgz`;
    provider.loseNextCommitResponse();
    expect((await initiateMultipart(env, value.bundleSha256, value.bundle.length, plan, operation)).status).toBe(201);
    const resumed = await initiateMultipart(env, value.bundleSha256, value.bundle.length, plan, operation);
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ uploadId: operation, resumed: true });
    expect([...provider.objects.keys()].filter(key => key.endsWith('/session'))).toHaveLength(1);

    const part = await uploadMultipartPart(env, value.bundleSha256, operation, 1, value.bundle, value.bundleSha256);
    expect(part.status).toBe(200);
    const partBody = await part.json() as UploadedMultipartPart;
    const receipt = { partNumber: partBody.partNumber, etag: partBody.etag };
    provider.loseNextCommitResponse();
    expect((await completeMultipart(env, value.bundleSha256, operation, [receipt])).status).toBe(502);
    const bundleKey = `${WORKSPACE_HOST_ARTIFACT_PREFIX}/${value.bundleSha256}/server.tgz`;
    const generation = provider.objects.get(bundleKey)!.generation;
    const retry = await completeMultipart(env, value.bundleSha256, operation, [receipt]);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ deduped: true });
    expect(provider.objects.get(bundleKey)!.generation).toBe(generation);
    expect(provider.requests.filter(request => request.url.pathname.endsWith('/compose'))).toHaveLength(1);
    expect((await api.request(publicPath, {}, env)).status).toBe(404);

    expect((await upload(env, value.bundleSha256, 'server.tgz.minisig', value.signature, value.signatureSha256)).status).toBe(201);
    expect((await upload(env, value.bundleSha256, 'manifest.json', value.manifestBytes, value.manifestSha256)).status).toBe(201);
    expect((await finalize(env, value.bundleSha256)).status).toBe(201);
    expect((await finalize(env, value.bundleSha256)).status).toBe(200);
    const response = await api.request(publicPath, {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-artifact-sha256')).toBe(value.bundleSha256);
    expect(response.headers.get('cache-control')).toBe(WORKSPACE_HOST_PUBLIC_CACHE_CONTROL);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(value.bundle);
    const head = await api.request(publicPath, { method: 'HEAD' }, env);
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(value.bundle.length));
    expect(provider.objects.get(bundleKey)!.generation).toBe(generation);

    // The host must still enforce the finalized descriptor with a GCS backend.
    const object = provider.objects.get(bundleKey)!;
    (object.metadata.metadata as Record<string, string>).fileSha256 = '0'.repeat(64);
    expect((await api.request(publicPath, {}, env)).status).toBe(404);
    expect((await finalize(env, value.bundleSha256)).status).toBe(409);
  });

  it('refuses an untrusted GCS-backed release without creating a public finalization marker', async () => {
    stubGithub({ user: { id: 7, login: 'operator' } });
    const provider = gcsTestProvider();
    const { env } = makeEnv({ ARTIFACTS: provider.store, CUPBOARD_OPERATOR_GITHUB_IDS: '7' });
    const value = await fixture(manifest => {
      (manifest.trustReport as { trusted: boolean }).trusted = false;
    });
    expect((await uploadFixture(env, value)).map(response => response.status)).toEqual([201, 201, 201]);
    expect((await finalize(env, value.bundleSha256)).status).toBe(400);
    expect(await provider.store.head(`${WORKSPACE_HOST_ARTIFACT_PREFIX}/${value.bundleSha256}/.finalized.json`)).toBeNull();
    expect((await api.request(`/artifacts/workspace-host/sha256/${value.bundleSha256}/server.tgz`, {}, env)).status).toBe(404);
  });

  it('attaches only the SBOM bound by a finalized manifest without rewriting the release', async () => {
    const sbom = new TextEncoder().encode(JSON.stringify({ bomFormat: 'CycloneDX', components: [] }));
    const sbomSha = await sha256Hex(sbom);
    const value = await fixture((manifest) => {
      const evidence = (manifest.trustReport as { evidence: Array<Record<string, unknown>> }).evidence;
      evidence.find((entry) => entry.kind === 'sbom')!.documentSha256 = sbomSha;
      evidence.find((entry) => entry.kind === 'vulnerability-scan')!.sbomSha256 = sbomSha;
    });
    const { env, r2 } = authedEnv();
    expect((await upload(env, value.bundleSha256, 'sbom.cdx.json', sbom, sbomSha)).status).toBe(409);
    await uploadFixture(env, value);
    expect((await finalize(env, value.bundleSha256)).status).toBe(201);
    const before = new Map(r2.data);
    const path = `/artifacts/workspace-host/sha256/${value.bundleSha256}/sbom.cdx.json`;
    expect((await api.request(path, {}, env)).status).toBe(404);

    const wrong = new TextEncoder().encode('unbound evidence');
    expect((await upload(env, value.bundleSha256, 'sbom.cdx.json', wrong, await sha256Hex(wrong))).status).toBe(409);
    expect((await upload(env, value.bundleSha256, 'sbom.cdx.json', wrong, sbomSha)).status).toBe(400);
    expect((await upload(env, value.bundleSha256, 'sbom.cdx.json', sbom, sbomSha)).status).toBe(201);
    const retry = await upload(env, value.bundleSha256, 'sbom.cdx.json', sbom, sbomSha);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ deduped: true });
    const publicBytes = await api.request(path, {}, env);
    expect(publicBytes.status).toBe(200);
    expect(publicBytes.headers.get('x-artifact-sha256')).toBe(sbomSha);
    expect(new Uint8Array(await publicBytes.arrayBuffer())).toEqual(sbom);
    expect((await api.request(path, { method: 'HEAD' }, env)).headers.get('content-length')).toBe(String(sbom.length));
    for (const [key, object] of before) expect(r2.data.get(key)).toEqual(object);
    expect(r2.data.size).toBe(before.size + 1);

    // A manifest altered behind the immutable descriptor cannot authorize public evidence.
    const manifestKey = `${WORKSPACE_HOST_ARTIFACT_PREFIX}/${value.bundleSha256}/manifest.json`;
    r2.data.set(manifestKey, new TextEncoder().encode('{}'));
    expect((await api.request(path, {}, env)).status).toBe(404);
  });

  it('requires a valid allowlisted GitHub operator before storing bytes', async () => {
    const value = await fixture();
    stubGithub({ user: { error: 401 } });
    const { env, r2 } = makeEnv({ CUPBOARD_OPERATOR_GITHUB_IDS: '7' });

    const response = await upload(env, value.bundleSha256, 'server.tgz', value.bundle, value.bundleSha256);

    expect(response.status).toBe(401);
    expect(r2.data.size).toBe(0);
  });

  it('verifies actual bytes, stores create-only, dedupes an exact retry, and stays private before finalize', async () => {
    const value = await fixture();
    const { env, r2 } = authedEnv();
    const tampered = new TextEncoder().encode('different bytes with the declared digest');

    const rejected = await upload(
      env,
      value.bundleSha256,
      'server.tgz',
      tampered,
      value.bundleSha256,
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: 'artifact_sha256_mismatch' });

    const created = await upload(
      env,
      value.bundleSha256,
      'server.tgz',
      value.bundle,
      value.bundleSha256,
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ deduped: false });

    const duplicate = await upload(
      env,
      value.bundleSha256,
      'server.tgz',
      value.bundle,
      value.bundleSha256,
    );
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ deduped: true });
    expect(r2.data.size).toBe(1);

    const hidden = await api.request(
      `/artifacts/workspace-host/sha256/${value.bundleSha256}/server.tgz`,
      {},
      env,
    );
    expect(hidden.status).toBe(404);
  });

  it('redirects oversized direct uploads to multipart and rejects an invalid bounded part plan', async () => {
    const bundleSha256 = 'a'.repeat(64);
    const { env } = authedEnv();
    const oversized = await api.request(
      `/admin/artifacts/workspace-host/sha256/${bundleSha256}/server.tgz`,
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer github-token',
          'content-length': '1',
          'x-artifact-sha256': bundleSha256,
          'x-artifact-size': String(64 * 1024 * 1024 + 1),
        },
        body: new Uint8Array([1]),
      },
      env,
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({
      error: 'artifact_too_large',
      multipart: { maxPartBytes: WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES },
    });

    const invalidPlan = await initiateMultipart(
      env,
      bundleSha256,
      10 * 1024 * 1024 + 1,
      [
        { partNumber: 1, sha256: 'b'.repeat(64), sizeBytes: 5 * 1024 * 1024 },
        { partNumber: 2, sha256: 'c'.repeat(64), sizeBytes: 5 * 1024 * 1024 + 1 },
      ],
    );
    expect(invalidPlan.status).toBe(400);
    expect(await invalidPlan.json()).toMatchObject({
      error: 'invalid_multipart_plan',
      errors: ['the final multipart part cannot exceed the regular part size'],
    });
  });

  it('reconciles a lost initiate response by caller operation id and rejects identity drift', async () => {
    const bundle = new TextEncoder().encode('restart-safe multipart body');
    const bundleSha256 = await sha256Hex(bundle);
    const part: MultipartPlanPart = {
      partNumber: 1,
      sha256: bundleSha256,
      sizeBytes: bundle.byteLength,
    };
    const operationId = crypto.randomUUID();
    const { env, r2 } = authedEnv();

    // The first response is deliberately discarded: from the client's view the
    // provider may have accepted the mutation and the outcome is unknown.
    const lost = await initiateMultipart(
      env,
      bundleSha256,
      bundle.byteLength,
      [part],
      operationId,
    );
    expect(lost.status).toBe(201);
    expect(r2.multipartUploads.size).toBe(1);

    const reconciled = await initiateMultipart(
      env,
      bundleSha256,
      bundle.byteLength,
      [part],
      operationId,
    );
    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toMatchObject({
      uploadId: operationId,
      operationId,
      resumed: true,
      deduped: false,
    });
    expect(r2.multipartUploads.size).toBe(1);

    const drifted = await initiateMultipart(
      env,
      bundleSha256,
      bundle.byteLength,
      [{ ...part, sha256: 'f'.repeat(64) }],
      operationId,
    );
    expect(drifted.status).toBe(409);
    expect(await drifted.json()).toMatchObject({ error: 'multipart_operation_conflict' });
    expect(r2.multipartUploads.size).toBe(1);
  });

  it('reconciles a lost part response from its committed receipt without another R2 mutation', async () => {
    const bundle = new TextEncoder().encode('one restart-safe part');
    const bundleSha256 = await sha256Hex(bundle);
    const operationId = crypto.randomUUID();
    const { env, r2 } = authedEnv();
    const initiated = await initiateMultipart(env, bundleSha256, bundle.byteLength, [{
      partNumber: 1,
      sha256: bundleSha256,
      sizeBytes: bundle.byteLength,
    }], operationId);
    expect(initiated.status).toBe(201);

    // Discard the response after the server has accepted and receipted the R2
    // mutation, matching a client transport loss/restart.
    const lost = await uploadMultipartPart(
      env,
      bundleSha256,
      operationId,
      1,
      bundle,
      bundleSha256,
    );
    expect(lost.status).toBe(200);
    expect(r2.multipartPartUploadCalls).toBe(1);

    const status = await multipartPartStatus(env, bundleSha256, operationId, 1);
    expect(status.status).toBe(200);
    const committed = await status.json() as { etag: string };
    expect(committed).toMatchObject({ state: 'committed', sha256: bundleSha256 });

    const replay = await uploadMultipartPart(
      env,
      bundleSha256,
      operationId,
      1,
      bundle,
      bundleSha256,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      etag: committed.etag,
      deduped: true,
      resumed: true,
    });
    expect(r2.multipartPartUploadCalls).toBe(1);
  });

  it('uploads a bounded multipart bundle with verified replay, incomplete, conflict, and finalize behavior', async () => {
    const regularPartBytes = 5 * 1024 * 1024;
    const firstPart = new Uint8Array(regularPartBytes).fill(0x61);
    const finalPart = new TextEncoder().encode('final multipart bytes');
    const bundle = new Uint8Array(firstPart.byteLength + finalPart.byteLength);
    bundle.set(firstPart, 0);
    bundle.set(finalPart, firstPart.byteLength);
    const value = await fixture(undefined, bundle);
    const parts: MultipartPlanPart[] = [
      {
        partNumber: 1,
        sha256: await sha256Hex(firstPart),
        sizeBytes: firstPart.byteLength,
      },
      {
        partNumber: 2,
        sha256: await sha256Hex(finalPart),
        sizeBytes: finalPart.byteLength,
      },
    ];
    const { env, r2 } = authedEnv();
    const opaqueNativeUploadId = `opaque/native+r2=${'x'.repeat(600)}`;
    r2.nextMultipartUploadId = opaqueNativeUploadId;

    const initiated = await initiateMultipart(
      env,
      value.bundleSha256,
      bundle.byteLength,
      parts,
    );
    expect(initiated.status).toBe(201);
    const initiatedBody = await initiated.json() as {
      uploadId: string;
      partCount: number;
      partSizeBytes: number;
      maxPartBytes: number;
      deduped: boolean;
    };
    expect(initiatedBody).toMatchObject({
      partCount: 2,
      partSizeBytes: regularPartBytes,
      maxPartBytes: WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES,
      deduped: false,
    });
    expect(initiatedBody.uploadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(initiatedBody.uploadId).not.toBe(opaqueNativeUploadId);
    expect(r2.multipartUploads.size).toBe(1);
    expect(r2.multipartUploads.has(opaqueNativeUploadId)).toBe(true);

    const rejectedPart = await uploadMultipartPart(
      env,
      value.bundleSha256,
      initiatedBody.uploadId,
      1,
      firstPart,
      '0'.repeat(64),
    );
    expect(rejectedPart.status).toBe(400);
    expect(await rejectedPart.json()).toMatchObject({ error: 'multipart_part_digest_mismatch' });

    const firstUpload = await uploadMultipartPart(
      env,
      value.bundleSha256,
      initiatedBody.uploadId,
      1,
      firstPart,
      parts[0].sha256,
    );
    expect(firstUpload.status).toBe(200);
    const firstUploadBody = await firstUpload.json() as UploadedMultipartPart;
    const firstUploaded: UploadedMultipartPart = {
      partNumber: firstUploadBody.partNumber,
      etag: firstUploadBody.etag,
    };
    const firstReplay = await uploadMultipartPart(
      env,
      value.bundleSha256,
      initiatedBody.uploadId,
      1,
      firstPart,
      parts[0].sha256,
    );
    expect(firstReplay.status).toBe(200);
    expect(await firstReplay.json()).toMatchObject({ etag: firstUploaded.etag });

    const incomplete = await completeMultipart(
      env,
      value.bundleSha256,
      initiatedBody.uploadId,
      [firstUploaded, { partNumber: 2, etag: 'missing-part' }],
    );
    expect(incomplete.status).toBe(409);
    expect(await incomplete.json()).toMatchObject({ error: 'multipart_upload_incomplete' });

    const finalUpload = await uploadMultipartPart(
      env,
      value.bundleSha256,
      initiatedBody.uploadId,
      2,
      finalPart,
      parts[1].sha256,
    );
    expect(finalUpload.status).toBe(200);
    const finalUploadBody = await finalUpload.json() as UploadedMultipartPart;
    const finalUploaded: UploadedMultipartPart = {
      partNumber: finalUploadBody.partNumber,
      etag: finalUploadBody.etag,
    };

    // Production R2 can omit durable custom metadata from the immediate
    // `complete()` return even though a fresh HEAD already carries it. The
    // completion route must adjudicate the stored object, not that transient
    // response shape (live D-129 publication incident, 2026-08-26).
    r2.nextMultipartCompleteReturnOmitsCustomMetadata = true;
    const completed = await completeMultipart(
      env,
      value.bundleSha256,
      initiatedBody.uploadId,
      [firstUploaded, finalUploaded],
    );
    expect(completed.status).toBe(201);
    expect(await completed.json()).toMatchObject({ deduped: false, bytes: bundle.byteLength });
    expect(r2.multipartUploads.size).toBe(0);
    const bundleKey = `${WORKSPACE_HOST_ARTIFACT_PREFIX}/${value.bundleSha256}/server.tgz`;
    const storedBundle = r2.data.get(bundleKey)!;
    expect(storedBundle.byteLength).toBe(bundle.byteLength);
    expect(await sha256Hex(storedBundle)).toBe(value.bundleSha256);

    const completedReplay = await completeMultipart(
      env,
      value.bundleSha256,
      initiatedBody.uploadId,
      [firstUploaded, finalUploaded],
    );
    expect(completedReplay.status).toBe(200);
    expect(await completedReplay.json()).toMatchObject({ deduped: true });

    const conflictingInitiate = await initiateMultipart(
      env,
      value.bundleSha256,
      bundle.byteLength + 1,
      parts,
    );
    expect(conflictingInitiate.status).toBe(409);
    expect(await conflictingInitiate.json()).toMatchObject({ error: 'artifact_conflict' });

    expect((await upload(
      env,
      value.bundleSha256,
      'server.tgz.minisig',
      value.signature,
      value.signatureSha256,
    )).status).toBe(201);
    expect((await upload(
      env,
      value.bundleSha256,
      'manifest.json',
      value.manifestBytes,
      value.manifestSha256,
    )).status).toBe(201);
    expect((await finalize(env, value.bundleSha256)).status).toBe(201);
    const published = await api.request(
      `/artifacts/workspace-host/sha256/${value.bundleSha256}/server.tgz`,
      {},
      env,
    );
    expect(published.status).toBe(200);
    const publishedBundle = new Uint8Array(await published.arrayBuffer());
    expect(publishedBundle.byteLength).toBe(bundle.byteLength);
    expect(await sha256Hex(publishedBundle)).toBe(value.bundleSha256);
  });

  it('aborts multipart state idempotently and refuses parts after closure', async () => {
    const bundle = new TextEncoder().encode('small abortable multipart body');
    const bundleSha256 = await sha256Hex(bundle);
    const partSha256 = await sha256Hex(bundle);
    const { env, r2 } = authedEnv();
    const initiated = await initiateMultipart(env, bundleSha256, bundle.byteLength, [
      { partNumber: 1, sha256: partSha256, sizeBytes: bundle.byteLength },
    ]);
    const { uploadId } = await initiated.json() as { uploadId: string };
    expect(initiated.status).toBe(201);
    expect(r2.multipartUploads.size).toBe(1);

    expect((await abortMultipart(env, bundleSha256, uploadId)).status).toBe(204);
    expect((await abortMultipart(env, bundleSha256, uploadId)).status).toBe(204);
    expect(r2.multipartUploads.size).toBe(0);
    const closedPart = await uploadMultipartPart(
      env,
      bundleSha256,
      uploadId,
      1,
      bundle,
      partSha256,
    );
    expect(closedPart.status).toBe(404);
    expect(await closedPart.json()).toMatchObject({ error: 'multipart_upload_not_found' });
    expect(r2.data.has(`${WORKSPACE_HOST_ARTIFACT_PREFIX}/${bundleSha256}/server.tgz`)).toBe(false);
  });

  it('refuses finalization until all three verified objects exist', async () => {
    const value = await fixture();
    const { env } = authedEnv();
    await upload(env, value.bundleSha256, 'server.tgz', value.bundle, value.bundleSha256);

    const response = await finalize(env, value.bundleSha256);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'uploads_incomplete',
      missing: ['server.tgz.minisig', 'manifest.json'],
    });
  });

  it('rejects a trust envelope with secret findings and never creates visibility', async () => {
    const value = await fixture((manifest) => {
      const trust = manifest.trustReport as { evidence: Array<Record<string, unknown>> };
      const secretScan = trust.evidence.find((entry) => entry.kind === 'secret-scan')!;
      secretScan.findings = [{ ruleId: 'cloud-api-key', location: 'bundle:12' }];
      (manifest as Record<string, unknown>).smuggledToken = 'ghp_abcdefghijklmnopqrstuvwxyz';
    });
    const { env, r2 } = authedEnv();
    expect((await Promise.all(await uploadFixture(env, value))).every((response) => response.status === 201)).toBe(true);

    const response = await finalize(env, value.bundleSha256);
    const body = await response.json() as { error: string; errors: string[] };

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_manifest');
    expect(body.errors.join(' ')).toMatch(/unexpected manifest field|secret-shaped|zero findings/);
    expect(r2.data.has(`${WORKSPACE_HOST_ARTIFACT_PREFIX}/${value.bundleSha256}/.finalized.json`)).toBe(false);
    expect((await api.request(
      `/artifacts/workspace-host/sha256/${value.bundleSha256}/manifest.json`,
      {},
      env,
    )).status).toBe(404);
  });

  it('rejects an otherwise valid manifest that points at a noncanonical release origin', async () => {
    const value = await fixture((manifest) => {
      const artifact = manifest.artifact as WorkspaceHostImageArtifact;
      (artifact.release as { bundleUrl: string }).bundleUrl =
        `https://releases.papercusp.com/${VERSION}/server.tgz`;
      (artifact.release as { signatureUrl: string }).signatureUrl =
        `${artifact.release.bundleUrl}.minisig`;
    });
    const { env } = authedEnv();
    await uploadFixture(env, value);

    const response = await finalize(env, value.bundleSha256);
    const body = await response.json() as { errors: string[] };

    expect(response.status).toBe(400);
    expect(body.errors).toContain('artifact release URLs must equal the D-105 digest-derived Cupboard URLs');
  });

  it('finalizes idempotently and serves public GET/HEAD with immutable integrity metadata', async () => {
    const value = await fixture();
    const { env, r2 } = authedEnv();
    const uploads = await uploadFixture(env, value);
    expect(uploads.map((response) => response.status)).toEqual([201, 201, 201]);

    const created = await finalize(env, value.bundleSha256);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      ok: true,
      bundleSha256: value.bundleSha256,
      manifestSha256: value.manifestSha256,
      deduped: false,
    });

    const duplicate = await finalize(env, value.bundleSha256);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ deduped: true });

    const get = await api.request(
      `/artifacts/workspace-host/sha256/${value.bundleSha256}/server.tgz`,
      {},
      env,
    );
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(value.bundle);
    expect(get.headers.get('cache-control')).toBe(WORKSPACE_HOST_PUBLIC_CACHE_CONTROL);
    expect(get.headers.get('x-artifact-sha256')).toBe(value.bundleSha256);
    expect(get.headers.get('content-type')).toBe('application/gzip');
    expect(get.headers.get('x-content-type-options')).toBe('nosniff');

    const head = await api.request(
      `/artifacts/workspace-host/sha256/${value.bundleSha256}/manifest.json`,
      { method: 'HEAD' },
      env,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('content-length')).toBe(String(value.manifestBytes.byteLength));
    expect(head.headers.get('x-artifact-sha256')).toBe(value.manifestSha256);

    const markerKey = `${WORKSPACE_HOST_ARTIFACT_PREFIX}/${value.bundleSha256}/.finalized.json`;
    expect(r2.data.has(markerKey)).toBe(true);

    // A marker is not a blanket success forever: an idempotent retry re-proves
    // the finalized set and fails closed if a sibling object disappeared.
    await r2.delete(`${WORKSPACE_HOST_ARTIFACT_PREFIX}/${value.bundleSha256}/server.tgz.minisig`);
    const incompleteRetry = await finalize(env, value.bundleSha256);
    expect(incompleteRetry.status).toBe(409);
    expect(await incompleteRetry.json()).toMatchObject({ error: 'finalization_conflict' });
  });

  it('fails closed when finalized object metadata no longer matches the marker', async () => {
    const value = await fixture();
    const { env, r2 } = authedEnv();
    await uploadFixture(env, value);
    expect((await finalize(env, value.bundleSha256)).status).toBe(201);
    const bundleKey = `${WORKSPACE_HOST_ARTIFACT_PREFIX}/${value.bundleSha256}/server.tgz`;
    const bundleMetadata = r2.customMetadata.get(bundleKey)!;
    const originalBundleSha256 = bundleMetadata.fileSha256;
    bundleMetadata.fileSha256 = '0'.repeat(64);

    const objectMismatch = await api.request(
      `/artifacts/workspace-host/sha256/${value.bundleSha256}/server.tgz`,
      {},
      env,
    );
    expect(objectMismatch.status).toBe(404);

    bundleMetadata.fileSha256 = originalBundleSha256;
    const markerKey = `${WORKSPACE_HOST_ARTIFACT_PREFIX}/${value.bundleSha256}/.finalized.json`;
    r2.customMetadata.get(markerKey)!.manifestSha256 = '0'.repeat(64);
    const markerMismatch = await api.request(
      `/artifacts/workspace-host/sha256/${value.bundleSha256}/server.tgz`,
      {},
      env,
    );

    expect(markerMismatch.status).toBe(404);
  });

  it('refuses a conflicting re-upload at the same bundle namespace', async () => {
    const value = await fixture();
    const { env } = authedEnv();
    expect((await upload(
      env,
      value.bundleSha256,
      'server.tgz.minisig',
      value.signature,
      value.signatureSha256,
    )).status).toBe(201);
    const replacement = new TextEncoder().encode('different detached signature');
    const replacementSha256 = await sha256Hex(replacement);

    const response = await upload(
      env,
      value.bundleSha256,
      'server.tgz.minisig',
      replacement,
      replacementSha256,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'artifact_conflict' });
  });
});
