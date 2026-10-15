import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  GCP_BASE_IMAGE_IDENTITY_SCHEME,
  gcpBaseImageIdentity,
  gcpBaseImageIdentityDigest,
  measureGcpBaseImage,
} from './gcp-base-image-identity';
import type { GcpImageFamilyComputeImage } from './gcp-image-family-adapter';

/**
 * WI-10005746: the GCP image release attested `baseImage.sha256` from hand-supplied input. These
 * tests pin what the measured replacement covers, so a later edit cannot quietly widen it to a
 * mutable field (which would change the digest of a past release's base) or narrow it to the name
 * alone (which would make every image ever created under that name collide).
 */
const REFERENCE = 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20260826';
const IMAGE: GcpImageFamilyComputeImage = {
  name: 'ubuntu-2404-noble-amd64-v20260826',
  id: '4405532451318052745',
  creationTimestamp: '2026-08-26T10:12:03.517-07:00',
  state: 'ACTIVE',
  labels: { channel: 'stable' },
  description: 'Canonical, Ubuntu, 24.04 LTS',
};

function digestOf(image: GcpImageFamilyComputeImage): string {
  return gcpBaseImageIdentityDigest(gcpBaseImageIdentity(REFERENCE, image));
}

describe('gcp base image identity', () => {
  it('hashes exactly the canonical JSON of scheme, reference, id and creationTimestamp', () => {
    const canonical =
      `{"scheme":"${GCP_BASE_IMAGE_IDENTITY_SCHEME}","reference":"${REFERENCE}",` +
      `"id":"4405532451318052745","creationTimestamp":"2026-08-26T10:12:03.517-07:00"}`;
    expect(digestOf(IMAGE)).toBe(createHash('sha256').update(canonical).digest('hex'));
  });

  it('accepts a numeric id the same as its decimal string', () => {
    expect(digestOf({ ...IMAGE, id: 4405532451318052 })).toBe(digestOf({ ...IMAGE, id: '4405532451318052' }));
  });

  it('ignores mutable fields, so deprecating a base later does not change a past release digest', () => {
    const aged: GcpImageFamilyComputeImage = {
      ...IMAGE,
      state: 'DEPRECATED',
      deprecated: { state: 'DEPRECATED', replacement: 'ubuntu-2404-noble-amd64-v20261001' },
      labels: {},
      description: 'superseded',
    };
    expect(digestOf(aged)).toBe(digestOf(IMAGE));
  });

  it('changes when the image is recreated under the same name (new id) or at a new time', () => {
    expect(digestOf({ ...IMAGE, id: '4405532451318052746' })).not.toBe(digestOf(IMAGE));
    expect(digestOf({ ...IMAGE, creationTimestamp: '2026-08-27T10:12:03.517-07:00' })).not.toBe(digestOf(IMAGE));
  });

  it('refuses to measure a partial identity rather than hash the name alone', () => {
    expect(() => gcpBaseImageIdentity(REFERENCE, { ...IMAGE, id: undefined })).toThrow(/no numeric resource id/);
    expect(() => gcpBaseImageIdentity(REFERENCE, { ...IMAGE, id: 'abc' })).toThrow(/no numeric resource id/);
    expect(() => gcpBaseImageIdentity(REFERENCE, { ...IMAGE, creationTimestamp: undefined })).toThrow(
      /no creationTimestamp/,
    );
  });

  it('refuses a response for a different image than the reference names', () => {
    expect(() => gcpBaseImageIdentity(REFERENCE, { ...IMAGE, name: 'ubuntu-2404-noble-amd64-v20261001' })).toThrow(
      /refusing to measure a different resource/,
    );
  });

  it('refuses a family alias before any lookup', async () => {
    let looked = false;
    await expect(
      measureGcpBaseImage(
        {
          getImage: async () => {
            looked = true;
            return IMAGE;
          },
        },
        'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64',
      ),
    ).rejects.toThrow();
    expect(looked).toBe(false);
  });

  it('measures through the Compute getter with the parsed project and name', async () => {
    const seen: string[] = [];
    const measured = await measureGcpBaseImage(
      {
        getImage: async (projectId, imageName) => {
          seen.push(`${projectId}/${imageName}`);
          return IMAGE;
        },
      },
      REFERENCE,
    );
    expect(seen).toEqual(['ubuntu-os-cloud/ubuntu-2404-noble-amd64-v20260826']);
    expect(measured.sha256).toBe(digestOf(IMAGE));
    expect(measured.identity).toEqual({
      scheme: GCP_BASE_IMAGE_IDENTITY_SCHEME,
      reference: REFERENCE,
      id: '4405532451318052745',
      creationTimestamp: '2026-08-26T10:12:03.517-07:00',
    });
  });

  it('refuses an image the API cannot find', async () => {
    await expect(measureGcpBaseImage({ getImage: async () => undefined }, REFERENCE)).rejects.toThrow(
      /was not found; refusing to attest/,
    );
  });
});
