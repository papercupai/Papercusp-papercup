/**
 * cupboard-release-pipeline-content-trust P-011 — the R2 ORIGIN route for self-describing
 * release bytes. The address is the verification: a PUT is accepted only if the bytes'
 * Merkle root (the SAME buildArtifactPackage the publisher and installer use) equals the
 * address in the URL.
 */
import { describe, expect, it } from 'vitest';
import { buildArtifactPackage } from '@papercusp/operator-core/lib/p2p/artifact-package.ts';
import { cupboardArtifactKey } from '@papercusp/operator-core/lib/cupboard/artifact-store.ts';
import { buildApi } from '../routes/index.ts';
import { MAX_SELF_DESCRIBING_ARTIFACT_BYTES, SELF_DESCRIBING_ORIGIN } from '../routes/self-describing-artifacts.ts';
import { makeEnv, stubGithub } from './fake-d1.ts';

const BYTES = Buffer.from(JSON.stringify({ files: [{ path: 'recipe.json', body: 'clean' }] }));
const ROOT = buildArtifactPackage(BYTES).rootHash;
const HEX = ROOT.slice('sha256:'.length);

async function put(api: ReturnType<typeof buildApi>, env: ReturnType<typeof makeEnv>['env'], hex: string, body: Buffer, auth = true) {
  return api.request(
    `/artifacts/sha256/${hex}`,
    { method: 'PUT', headers: auth ? { Authorization: 'Bearer pub' } : {}, body: new Uint8Array(body) },
    env,
  );
}

describe('self-describing artifact origin route (P-011)', () => {
  it('stores bytes whose Merkle root equals the address, and serves them back byte-identical', async () => {
    const api = buildApi();
    const { env, r2 } = makeEnv();
    stubGithub({ user: { id: 1, login: 'alice' } });

    const res = await put(api, env, HEX, BYTES);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, existed: false, content_hash: ROOT, size_bytes: BYTES.length });
    const head = await r2.head(cupboardArtifactKey(ROOT));
    expect(head?.customMetadata?.origin).toBe(SELF_DESCRIBING_ORIGIN);

    const got = await api.request(`/artifacts/sha256/${HEX}`, {}, env);
    expect(got.status).toBe(200);
    expect(Buffer.from(await got.arrayBuffer()).equals(BYTES)).toBe(true);
    // Tokenless by design: a public listing's install carries no credential.
    expect(got.headers.get('cache-control')).toContain('immutable');
  });

  it('refuses content-address-mismatch when the bytes do not hold the claimed address, and stores nothing', async () => {
    const api = buildApi();
    const { env, r2 } = makeEnv();
    stubGithub({ user: { id: 1, login: 'alice' } });

    const tampered = Buffer.from(JSON.stringify({ files: [{ path: 'recipe.json', body: 'DIRTY' }] }));
    const res = await put(api, env, HEX, tampered);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'content-address-mismatch', expected: ROOT });
    expect(await r2.head(cupboardArtifactKey(ROOT))).toBeNull();
  });

  it('is idempotent: a replay of the same address is a no-op that reports existed', async () => {
    const api = buildApi();
    const { env } = makeEnv();
    stubGithub({ user: { id: 1, login: 'alice' } });
    expect((await put(api, env, HEX, BYTES)).status).toBe(201);
    const replay = await put(api, env, HEX, BYTES);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: true, existed: true });
  });

  it('requires a GitHub bearer to upload', async () => {
    const api = buildApi();
    const { env, r2 } = makeEnv();
    const res = await put(api, env, HEX, BYTES, false);
    expect(res.status).toBe(401);
    expect(await r2.head(cupboardArtifactKey(ROOT))).toBeNull();
  });

  it('rejects a malformed address and an oversize body before touching R2', async () => {
    const api = buildApi();
    const { env, r2 } = makeEnv();
    stubGithub({ user: { id: 1, login: 'alice' } });
    expect((await put(api, env, 'not-a-hash', BYTES)).status).toBe(400);
    const huge = Buffer.alloc(MAX_SELF_DESCRIBING_ARTIFACT_BYTES + 1, 7);
    const res = await put(api, env, HEX, huge);
    expect(res.status).toBe(413);
    expect(await r2.head(cupboardArtifactKey(ROOT))).toBeNull();
  });

  it('is NOT a read door onto an object this route did not write (creator-draft key space)', async () => {
    const api = buildApi();
    const { env, r2 } = makeEnv();
    // A private creator-draft artifact lives at the same key shape, addressed by a flat digest.
    await r2.put(cupboardArtifactKey(ROOT), BYTES, { customMetadata: { draftId: 'd1' } });
    expect((await api.request(`/artifacts/sha256/${HEX}`, {}, env)).status).toBe(404);
    stubGithub({ user: { id: 1, login: 'alice' } });
    // ...and a publisher cannot claim an occupied key either.
    expect((await put(api, env, HEX, BYTES)).status).toBe(409);
  });
});
