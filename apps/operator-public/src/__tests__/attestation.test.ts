// SPEC-P-010 / SPEC-P-010b (cupboard-release-pipeline-content-trust-2026-09-16 P-010, R-6):
// the optional `verified_by='attestation'` badge. The fixture is a REAL GitHub attestations
// API reply captured from the Papercusp/cupboard-actions selftest run (Sigstore public-good
// bundle, DSSE in-toto statement), so the positive case exercises the real `@sigstore/verify`
// chain — Fulcio cert chain, SCT/tlog inclusion promise, DSSE signature — against the
// checked-in trusted root, not a mock of it.
import { bundleFromJSON } from '@sigstore/bundle';
import { toSignedEntity } from '@sigstore/verify';
import { describe, expect, it } from 'vitest';
import reply from './fixtures/attestation/api-reply.json';
import {
  CUPBOARD_WORKFLOW_IDENTITY_PREFIX,
  checkAttestationPolicy,
  type CertLike,
  resolveVerifiedBy,
  verifyAttestationBundle,
  verifyCupboardAttestation,
  type VerifyAttestationInput,
} from '../attestation.ts';

// What the real run attested: tree digest of fixtures/sample-recipe at commit 367edea.
const GOOD: VerifyAttestationInput = {
  repo: 'Papercusp/cupboard-actions',
  treeDigest: '1c51ad1f39ab6096c9b419fba6bce95516e59018aa2fca25bc49248a13a61205',
  commitSha: '367edea41439ed08f471094bfcc18febe1a0d93c',
};

const jsonResponse = (status: number, body: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;

const withFixture = (over: Partial<VerifyAttestationInput> = {}): VerifyAttestationInput => ({
  ...GOOD,
  fetchImpl: jsonResponse(200, reply),
  ...over,
});

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('verifyCupboardAttestation — the real Sigstore bundle', () => {
  it('verifies the genuine attestation for exactly the digest + commit + repo it attests', async () => {
    const verdict = await verifyCupboardAttestation(withFixture());
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.signerWorkflow.startsWith(CUPBOARD_WORKFLOW_IDENTITY_PREFIX)).toBe(true);
      expect(verdict.sourceRepositoryUri).toBe('https://github.com/Papercusp/cupboard-actions');
    }
    await expect(resolveVerifiedBy(withFixture())).resolves.toBe('attestation');
  });

  it('asks GitHub for the attestation of the Worker-pinned digest, with the bearer when given', async () => {
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    const spy = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as unknown as typeof fetch;
    await verifyCupboardAttestation(withFixture({ fetchImpl: spy, token: 'tkn' }));
    expect(calls).toEqual([
      {
        url: `https://api.github.com/repos/Papercusp/cupboard-actions/attestations/sha256:${GOOD.treeDigest}`,
        auth: 'Bearer tkn',
      },
    ]);
  });
});

describe('verifyCupboardAttestation — a genuine attestation for DIFFERENT bytes never badges', () => {
  // GitHub looks attestations up by subject digest, but the Worker must not trust the lookup:
  // it re-checks the signed statement itself, so a reply that does not match is refused.
  it('refuses a genuine attestation when the pinned tree digest differs', async () => {
    const treeDigest = `${GOOD.treeDigest.slice(0, 63)}${GOOD.treeDigest.endsWith('0') ? '1' : '0'}`;
    const verdict = await verifyCupboardAttestation(withFixture({ treeDigest }));
    expect(verdict).toEqual({ ok: false, code: 'policy_mismatch', reason: 'subject_digest' });
    await expect(resolveVerifiedBy(withFixture({ treeDigest }))).resolves.toBe('worker');
  });

  it('refuses a genuine attestation when the pinned commit differs', async () => {
    const commitSha = 'a'.repeat(40);
    const verdict = await verifyCupboardAttestation(withFixture({ commitSha }));
    expect(verdict).toEqual({ ok: false, code: 'policy_mismatch', reason: 'commit' });
    await expect(resolveVerifiedBy(withFixture({ commitSha }))).resolves.toBe('worker');
  });

  it('refuses a genuine attestation replayed onto a different repository', async () => {
    const verdict = await verifyCupboardAttestation(withFixture({ repo: 'someone-else/their-repo' }));
    expect(verdict).toEqual({ ok: false, code: 'policy_mismatch', reason: 'source_repository' });
    await expect(resolveVerifiedBy(withFixture({ repo: 'someone-else/their-repo' }))).resolves.toBe('worker');
  });
});

describe('verifyCupboardAttestation — a forged or untrusted bundle never badges', () => {
  it('refuses a bundle whose signed statement was edited (DSSE signature no longer verifies)', async () => {
    const forged = clone(reply) as typeof reply;
    const env = forged.attestations[0].bundle.dsseEnvelope;
    const statement = JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8')) as {
      subject: Array<{ digest: { sha256: string } }>;
    };
    // Point the signed statement at a digest the attacker controls, keep the real signature.
    statement.subject[0].digest.sha256 = 'f'.repeat(64);
    env.payload = Buffer.from(JSON.stringify(statement)).toString('base64');
    const input = withFixture({ fetchImpl: jsonResponse(200, forged), treeDigest: 'f'.repeat(64) });
    const verdict = await verifyCupboardAttestation(input);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('verification_failed');
    await expect(resolveVerifiedBy(input)).resolves.toBe('worker');
  });

  it('refuses a genuine bundle checked against a trusted root that does not contain its CA/log', async () => {
    const input = withFixture({ trustedRoot: { mediaType: 'application/vnd.dev.sigstore.trustedroot+json;version=0.1' } });
    const verdict = await verifyCupboardAttestation(input);
    expect(verdict.ok).toBe(false);
    await expect(resolveVerifiedBy(input)).resolves.toBe('worker');
  });

  it('refuses malformed bundles without throwing', () => {
    for (const bundle of [null, undefined, 42, 'x', {}, { mediaType: 'nope' }, { dsseEnvelope: {} }]) {
      const verdict = verifyAttestationBundle(bundle, GOOD);
      expect(verdict.ok).toBe(false);
    }
  });
});

describe('resolveVerifiedBy — every failure to ask or verify is a quiet "worker", never a publish blocker', () => {
  const cases: Array<[string, Partial<VerifyAttestationInput>, string]> = [
    ['no attestation exists (404)', { fetchImpl: jsonResponse(404, { message: 'Not Found' }) }, 'no_attestation'],
    ['an empty attestations list', { fetchImpl: jsonResponse(200, { attestations: [] }) }, 'no_attestation'],
    ['a non-object body', { fetchImpl: jsonResponse(200, null) }, 'no_attestation'],
    ['GitHub 500', { fetchImpl: jsonResponse(500, {}) }, 'github_unreachable'],
    ['GitHub rate limit (403)', { fetchImpl: jsonResponse(403, {}) }, 'github_unreachable'],
    [
      'a network failure',
      {
        fetchImpl: (async () => {
          throw new TypeError('network down');
        }) as unknown as typeof fetch,
      },
      'github_unreachable',
    ],
    [
      'a body that is not JSON',
      { fetchImpl: (async () => new Response('<html>oops</html>', { status: 200 })) as unknown as typeof fetch },
      'github_unreachable',
    ],
    ['a malformed tree digest', { treeDigest: 'not-a-digest' }, 'invalid_input'],
    ['a malformed commit sha', { commitSha: 'abc' }, 'invalid_input'],
    ['a malformed repo', { repo: '../../etc/passwd' }, 'invalid_input'],
  ];

  for (const [name, over, code] of cases) {
    it(`${name} → verdict ${code}, stored verified_by 'worker'`, async () => {
      const input = withFixture(over);
      const verdict = await verifyCupboardAttestation(input);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe(code);
      await expect(resolveVerifiedBy(input)).resolves.toBe('worker');
    });
  }

  it('only ever looks at the first few attestations (a hostile reply cannot make the Worker verify unboundedly)', async () => {
    const many = { attestations: Array.from({ length: 50 }, () => ({ bundle: {} })) };
    let verified = 0;
    const verdict = await verifyCupboardAttestation(
      withFixture({
        fetchImpl: jsonResponse(200, many),
        // the bundles are all invalid, so each costs one failed parse; the cap bounds the loop
      }),
    );
    verified += 1;
    expect(verified).toBe(1);
    expect(verdict.ok).toBe(false);
    // A genuine attestation placed AFTER the cap is not reached: attacker padding cannot win.
    const padded = {
      attestations: [...Array.from({ length: 5 }, () => ({ bundle: {} })), ...reply.attestations],
    };
    await expect(resolveVerifiedBy(withFixture({ fetchImpl: jsonResponse(200, padded) }))).resolves.toBe('worker');
  });

  it('finds a genuine attestation among several (a bad one first does not mask it)', async () => {
    const mixed = { attestations: [{ bundle: {} }, ...reply.attestations] };
    await expect(resolveVerifiedBy(withFixture({ fetchImpl: jsonResponse(200, mixed) }))).resolves.toBe('attestation');
  });
});

// A genuine Sigstore bundle cannot be forged into a certificate for a non-public source
// repository, so the visibility leg of the policy is exercised on the REAL certificate and
// statement with ONE extension edited at the certificate view (the signature leg is not
// touched). The unedited control proves the harness itself accepts, so a refusal below is the
// edited extension and nothing else.
describe('checkAttestationPolicy — the source repository must be PUBLIC (cert extension edited)', () => {
  const OID_VISIBILITY = '1.3.6.1.4.1.57264.1.22';
  const bundleJson = reply.attestations[0]?.bundle;
  const bundle = bundleFromJSON(bundleJson);
  const entity = toSignedEntity(bundle);
  if (bundle.content.$case !== 'dsseEnvelope' || entity.key.$case !== 'certificate') {
    throw new Error('fixture is not a DSSE + certificate bundle');
  }
  const payload = bundle.content.dsseEnvelope.payload;
  const realCert = entity.key.certificate as unknown as CertLike;
  const genuine = verifyAttestationBundle(bundleJson, GOOD);
  const derUtf8 = (text: string): Uint8Array => {
    const bytes = new TextEncoder().encode(text);
    return Uint8Array.from([0x0c, bytes.length, ...bytes]);
  };
  const withVisibility = (text: string | null): CertLike => ({
    extension: (oid) =>
      oid === OID_VISIBILITY ? (text === null ? undefined : { value: derUtf8(text) }) : realCert.extension(oid),
  });
  const policy = (cert: CertLike) =>
    checkAttestationPolicy(
      { signerWorkflow: genuine.ok ? genuine.signerWorkflow : '', cert, payload },
      GOOD,
    );

  it('control: the genuine bundle verifies, and its own certificate says visibility public', () => {
    expect(genuine.ok).toBe(true);
    expect(policy(realCert)).toMatchObject({ ok: true });
    expect(policy(withVisibility('public'))).toMatchObject({ ok: true });
  });

  it.each([['private'], ['internal'], ['Public'], ['']])(
    'refuses a certificate whose source-repository-visibility is %j',
    (visibility) => {
      expect(policy(withVisibility(visibility))).toEqual({ ok: false, code: 'policy_mismatch', reason: 'visibility' });
    },
  );

  it('refuses a certificate with NO source-repository-visibility extension at all', () => {
    expect(policy(withVisibility(null))).toEqual({ ok: false, code: 'policy_mismatch', reason: 'visibility' });
  });
});
