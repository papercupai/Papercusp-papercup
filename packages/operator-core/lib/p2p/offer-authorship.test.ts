/**
 * P-102 authorship chain — EXAMPLE-based unit tests, with REAL Ed25519 sigs.
 *
 * Each test drives one link of the chain (or the C5 / X6 gates) with a
 * hand-built case, using genuine device keypairs so the signature verify is not
 * mocked. The generated round-trip / single-break corpus lives in
 * offer-authorship.property.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';
import type { WorkOffer } from './offer-budget';
import {
  offerAuthorshipSigningBytes,
  buildOfferAuthorship,
  verifyOfferAuthorship,
  runtimeSatisfies,
  type AuthorshipVerifyInput,
} from './offer-authorship';

function makeOffer(over: Partial<WorkOffer> = {}): WorkOffer {
  return {
    offerId: 'offer-1',
    fleetSlug: '279242982/hiveloop',
    publisherRef: 'user:5',
    billedTo: 'host:h1',
    modelClass: 'frontier-remote',
    priority: 3,
    isolationReqs: ['clamp:coord-fleet-only', 'clamp:no-grants'],
    minRuntimeVersion: '1.2.0',
    budget: { remote: { cap: 1000, unit: 'usd-micros', maxPerCall: 100 }, local: null },
    publishedAt: 1000,
    ttlMs: 60_000,
    ...over,
  };
}

/** A fully-valid, genuinely-signed authorship case. */
function validCase(): { input: AuthorshipVerifyInput; signerUserId: number } {
  const kp = generateEd25519KeypairDer();
  const offer = makeOffer();
  const epoch = 4;
  const sig = signWithPrivateKeyDer(kp.privateKeyDer, offerAuthorshipSigningBytes(offer, epoch));
  const authorship = buildOfferAuthorship({ devicePubkey: kp.pubkeyBase64, epoch, signature: sig });
  const input: AuthorshipVerifyInput = {
    offer,
    authorship,
    attestedGithubUserId: 5,
    publisherSet: {
      ownerGithubUserId: 279242982,
      ownerAnchored: true,
      ownerSignatureValid: true,
      memberGithubUserIds: [5, 7],
    },
    ownerHighWaterEpoch: 4,
    host: { runtimeVersion: '1.3.0', capabilities: ['clamp:coord-fleet-only', 'clamp:no-grants', 'extra'] },
  };
  return { input, signerUserId: 5 };
}

describe('verifyOfferAuthorship — happy path', () => {
  it('a validly signed, attested, in-set, anchored, fresh, capable offer verifies', () => {
    const { input, signerUserId } = validCase();
    const v = verifyOfferAuthorship(input);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.authorizedGithubUserId).toBe(signerUserId);
      expect(v.ownerGithubUserId).toBe(279242982);
      expect(v.epoch).toBe(4);
    }
  });

  it('the proven signer is authoritative — NOT the self-claimed publisherRef', () => {
    const { input } = validCase();
    // A lying publisherRef does not change the proven authority.
    const lying: AuthorshipVerifyInput = { ...input, offer: { ...input.offer, publisherRef: 'user:999999' } };
    // NB: changing the offer breaks the sig, so re-sign to isolate the point:
    const kp = generateEd25519KeypairDer();
    const offer = makeOffer({ publisherRef: 'user:999999' });
    const sig = signWithPrivateKeyDer(kp.privateKeyDer, offerAuthorshipSigningBytes(offer, 4));
    const reSigned: AuthorshipVerifyInput = {
      ...lying,
      offer,
      authorship: buildOfferAuthorship({ devicePubkey: kp.pubkeyBase64, epoch: 4, signature: sig }),
    };
    const v = verifyOfferAuthorship(reSigned);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.authorizedGithubUserId).toBe(5); // the attested signer, not publisherRef 999999
  });
});

describe('verifyOfferAuthorship — device signature link', () => {
  it('refuses a tampered offer (sig no longer matches)', () => {
    const { input } = validCase();
    const tampered: AuthorshipVerifyInput = { ...input, offer: { ...input.offer, priority: 99 } };
    const v = verifyOfferAuthorship(tampered);
    expect(v).toMatchObject({ ok: false, code: 'device_sig_invalid' });
  });

  it('refuses a wrong-key signature', () => {
    const { input } = validCase();
    const other = generateEd25519KeypairDer();
    const v = verifyOfferAuthorship({
      ...input,
      authorship: { ...input.authorship, devicePubkey: other.pubkeyBase64 },
    });
    expect(v).toMatchObject({ ok: false, code: 'device_sig_invalid' });
  });

  it('refuses a malformed signature without throwing', () => {
    const { input } = validCase();
    const v = verifyOfferAuthorship({
      ...input,
      authorship: { ...input.authorship, signatureByDevice: '!!!not-base64!!!' },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('device_sig_invalid');
  });

  it('refuses a tampered epoch (epoch is covered by the signature)', () => {
    const { input } = validCase();
    // Bump the envelope epoch WITHOUT re-signing; the signed bytes no longer match.
    const v = verifyOfferAuthorship({
      ...input,
      authorship: { ...input.authorship, epoch: 5 },
      ownerHighWaterEpoch: 5,
    });
    expect(v).toMatchObject({ ok: false, code: 'device_sig_invalid' });
  });
});

describe('verifyOfferAuthorship — attestation + publisher-set links', () => {
  it('refuses an unattested device', () => {
    const { input } = validCase();
    const v = verifyOfferAuthorship({ ...input, attestedGithubUserId: null });
    expect(v).toMatchObject({ ok: false, code: 'device_not_attested' });
  });

  it('refuses a signer not in the publisher set', () => {
    const { input } = validCase();
    const v = verifyOfferAuthorship({
      ...input,
      publisherSet: { ...input.publisherSet, memberGithubUserIds: [7, 9] },
    });
    expect(v).toMatchObject({ ok: false, code: 'user_not_in_publisher_set' });
  });

  it('refuses an unsigned publisher set', () => {
    const { input } = validCase();
    const v = verifyOfferAuthorship({
      ...input,
      publisherSet: { ...input.publisherSet, ownerSignatureValid: false },
    });
    expect(v).toMatchObject({ ok: false, code: 'owner_signature_invalid' });
  });

  it('refuses an unanchored owner (no root of trust)', () => {
    const { input } = validCase();
    const v = verifyOfferAuthorship({
      ...input,
      publisherSet: { ...input.publisherSet, ownerAnchored: false },
    });
    expect(v).toMatchObject({ ok: false, code: 'owner_unanchored' });
  });
});

describe('verifyOfferAuthorship — X6 epoch fence', () => {
  it('refuses a stale epoch (below the owner high-water)', () => {
    // Sign at epoch 2, but the receiver high-water is 5 → stale.
    const kp = generateEd25519KeypairDer();
    const offer = makeOffer();
    const sig = signWithPrivateKeyDer(kp.privateKeyDer, offerAuthorshipSigningBytes(offer, 2));
    const input: AuthorshipVerifyInput = {
      offer,
      authorship: buildOfferAuthorship({ devicePubkey: kp.pubkeyBase64, epoch: 2, signature: sig }),
      attestedGithubUserId: 5,
      publisherSet: { ownerGithubUserId: 1, ownerAnchored: true, ownerSignatureValid: true, memberGithubUserIds: [5] },
      ownerHighWaterEpoch: 5,
      host: { runtimeVersion: '2.0.0', capabilities: ['clamp:coord-fleet-only', 'clamp:no-grants'] },
    };
    const v = verifyOfferAuthorship(input);
    expect(v).toMatchObject({ ok: false, code: 'epoch_stale' });
  });

  it('accepts epoch equal to the high-water (monotone, not strict)', () => {
    const { input } = validCase(); // epoch 4, high-water 4
    expect(verifyOfferAuthorship(input).ok).toBe(true);
  });
});

describe('verifyOfferAuthorship — C5 runtime + capability gates', () => {
  it('refuses a host below the min runtime version', () => {
    const { input } = validCase(); // min 1.2.0
    const v = verifyOfferAuthorship({ ...input, host: { ...input.host, runtimeVersion: '1.1.9' } });
    expect(v).toMatchObject({ ok: false, code: 'runtime_too_old' });
  });

  it('refuses a host missing a required isolation capability', () => {
    const { input } = validCase();
    const v = verifyOfferAuthorship({
      ...input,
      host: { ...input.host, capabilities: ['clamp:coord-fleet-only'] }, // missing clamp:no-grants
    });
    expect(v).toMatchObject({ ok: false, code: 'capability_unsatisfied' });
    // WI-10005197: the refusal names what would LIFT it, who can make that true, and what it compared.
    expect(v).toMatchObject({
      refusal: {
        observed: { missingCapabilities: 'clamp:no-grants' },
        whoCanMakeItTrue: ['host', 'owner'],
      },
    });
    if (!v.ok) expect(v.refusal?.liftsWhen).toMatch(/isolation capability/);
  });

  it('a cryptographic refusal carries no lift contract (no remedy short of a different offer)', () => {
    const { input } = validCase();
    const v = verifyOfferAuthorship({ ...input, host: { ...input.host, runtimeVersion: '1.1.9' } });
    expect(v).toMatchObject({ ok: false, code: 'runtime_too_old' });
    if (!v.ok) expect(v.refusal).toBeUndefined();
  });

  it('an offer with no min-runtime and no isolationReqs still verifies', () => {
    const kp = generateEd25519KeypairDer();
    const offer = makeOffer({ minRuntimeVersion: undefined, isolationReqs: [] });
    const sig = signWithPrivateKeyDer(kp.privateKeyDer, offerAuthorshipSigningBytes(offer, 4));
    const input: AuthorshipVerifyInput = {
      offer,
      authorship: buildOfferAuthorship({ devicePubkey: kp.pubkeyBase64, epoch: 4, signature: sig }),
      attestedGithubUserId: 5,
      publisherSet: { ownerGithubUserId: 1, ownerAnchored: true, ownerSignatureValid: true, memberGithubUserIds: [5] },
      ownerHighWaterEpoch: 0,
      host: { runtimeVersion: '0.0.1', capabilities: [] },
    };
    expect(verifyOfferAuthorship(input).ok).toBe(true);
  });
});

describe('runtimeSatisfies', () => {
  it('no requirement ⇒ satisfied', () => {
    expect(runtimeSatisfies('0.0.1', undefined)).toBe(true);
    expect(runtimeSatisfies('0.0.1', '')).toBe(true);
  });
  it('compares dotted-numeric versions (host >= min)', () => {
    expect(runtimeSatisfies('1.2.3', '1.2.3')).toBe(true);
    expect(runtimeSatisfies('1.3.0', '1.2.9')).toBe(true);
    expect(runtimeSatisfies('2.0.0', '1.9.9')).toBe(true);
    expect(runtimeSatisfies('1.2.0', '1.2.1')).toBe(false);
    expect(runtimeSatisfies('1.2', '1.2.0')).toBe(true); // 1.2 == 1.2.0
    expect(runtimeSatisfies('1.2.0.0', '1.2')).toBe(true);
  });
  it('fails CLOSED on a malformed version (C5 — never launch unclamped)', () => {
    expect(runtimeSatisfies('1.x', '1.0.0')).toBe(false);
    expect(runtimeSatisfies('1.0.0', 'latest')).toBe(false);
    expect(runtimeSatisfies('', '1.0.0')).toBe(false);
  });
});
