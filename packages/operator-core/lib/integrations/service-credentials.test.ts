/**
 * Google Pub/Sub service credential for Gmail push (plan
 * generalized-integrations-google-migration-cupboard-workflows-2026-10-05, D-018).
 *
 * Port guard for WI-474688: bg-host deliberately unsets GOOGLE_APPLICATION_CREDENTIALS
 * (the workspace-host service-account-key ban), and that once stranded Gmail push on the
 * routines executor. The bg-host unit keeps the key reachable through
 * PAPERCUSP_GOOGLE_PUBSUB_SERVICE_ACCOUNT_PATH (pinned by bghost-bundled-entry.test.ts);
 * these cases pin the code half: that variable is read first, and the resolver works with
 * ADC unset.
 */
import { describe, expect, it } from 'vitest';
import {
  GOOGLE_GMAIL_PUSH_TOPIC_ID,
  googlePubSubResolver,
  googlePubSubServiceAccountPath,
} from './service-credentials.js';

const KEY = JSON.stringify({ project_id: 'proj-1', client_email: 'push@proj-1.iam.gserviceaccount.com' });

describe('googlePubSubServiceAccountPath (WI-474688)', () => {
  it('reads the Pub/Sub key path when GOOGLE_APPLICATION_CREDENTIALS is unset, as on bg-host', () => {
    expect(googlePubSubServiceAccountPath({ PAPERCUSP_GOOGLE_PUBSUB_SERVICE_ACCOUNT_PATH: '/keys/pubsub.json' })).toBe(
      '/keys/pubsub.json',
    );
  });

  it('prefers the Pub/Sub key path over ADC, falls back to ADC, and treats blanks as unset', () => {
    expect(
      googlePubSubServiceAccountPath({
        PAPERCUSP_GOOGLE_PUBSUB_SERVICE_ACCOUNT_PATH: '/keys/pubsub.json',
        GOOGLE_APPLICATION_CREDENTIALS: '/keys/adc.json',
      }),
    ).toBe('/keys/pubsub.json');
    expect(googlePubSubServiceAccountPath({ GOOGLE_APPLICATION_CREDENTIALS: '/keys/adc.json' })).toBe('/keys/adc.json');
    expect(
      googlePubSubServiceAccountPath({ PAPERCUSP_GOOGLE_PUBSUB_SERVICE_ACCOUNT_PATH: '  ', GOOGLE_APPLICATION_CREDENTIALS: '/keys/adc.json' }),
    ).toBe('/keys/adc.json');
    expect(googlePubSubServiceAccountPath({})).toBeNull();
  });
});

describe('googlePubSubResolver under the bg-host environment', () => {
  const env = { PAPERCUSP_GOOGLE_PUBSUB_SERVICE_ACCOUNT_PATH: '/keys/pubsub.json' };

  it('reads params from the Pub/Sub key and mints its token from the same path', async () => {
    const read: string[] = [];
    const minted: string[] = [];
    const resolver = googlePubSubResolver({
      env,
      readFile: async (path) => {
        read.push(path);
        return KEY;
      },
      mintToken: async (path) => {
        minted.push(path);
        return 'tok-1';
      },
    });
    await expect(resolver.params()).resolves.toEqual({
      projectId: 'proj-1',
      topicName: `projects/proj-1/topics/${GOOGLE_GMAIL_PUSH_TOPIC_ID}`,
      principal: 'push@proj-1.iam.gserviceaccount.com',
    });
    await expect(resolver.accessToken()).resolves.toBe('tok-1');
    expect(read).toEqual(['/keys/pubsub.json']);
    expect(minted).toEqual(['/keys/pubsub.json']);
  });

  it('with no key path at all, params is null and minting is refused rather than using ambient credentials', async () => {
    const resolver = googlePubSubResolver({
      env: {},
      readFile: async () => {
        throw new Error('must not read');
      },
      mintToken: async () => {
        throw new Error('must not mint');
      },
    });
    await expect(resolver.params()).resolves.toBeNull();
    await expect(resolver.accessToken()).rejects.toThrow(/google_pubsub_service_account_path_required/);
  });
});
