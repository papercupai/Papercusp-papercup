import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOSTED_INTEGRATION_SECRET_REF_PREFIX,
  createHostedSecretRefResolver,
  resolveHostedSecretRef,
} from './secret-ref';

const GCP_SECRET_REF_PREFIX = ['gcp', 'secret'].join('-') + ':';

describe('hosted secret references', () => {
  afterEach(() => {
    delete process.env.PAPERCUSP_TEST_HOSTED_SECRET_REF;
  });

  it('resolves integration:NAME from the encrypted integration store, trimmed', async () => {
    const readIntegrationKey = vi.fn(async (name: string) => (name === 'WORKOS_API_KEY' ? '  sk_test_value  ' : undefined));
    const resolveOther = vi.fn(async () => 'must-not-resolve');
    const resolve = createHostedSecretRefResolver({ readIntegrationKey, resolveOther });

    await expect(resolve(' integration:WORKOS_API_KEY ')).resolves.toBe('sk_test_value');
    expect(readIntegrationKey).toHaveBeenCalledWith('WORKOS_API_KEY');
    expect(resolveOther).not.toHaveBeenCalled();
  });

  it('fails closed, naming the reference (never a value), when the store holds nothing under NAME', async () => {
    const resolve = createHostedSecretRefResolver({
      readIntegrationKey: async () => undefined,
      resolveOther: async () => 'must-not-resolve',
    });
    await expect(resolve('integration:WORKOS_WEBHOOK_SECRET')).rejects.toThrow(
      /hosted_secret_ref_missing:integration:WORKOS_WEBHOOK_SECRET/,
    );
    await expect(
      createHostedSecretRefResolver({ readIntegrationKey: async () => '   ' })('integration:WORKOS_API_KEY'),
    ).rejects.toThrow(/hosted_secret_ref_missing/);
  });

  it('rejects a malformed integration name before touching the store', async () => {
    const readIntegrationKey = vi.fn(async () => 'never');
    const resolve = createHostedSecretRefResolver({ readIntegrationKey });
    await expect(resolve('integration:')).rejects.toThrow(/hosted_secret_ref_malformed/);
    await expect(resolve('integration:lowercase')).rejects.toThrow(/hosted_secret_ref_malformed/);
    await expect(resolve('integration:../etc/passwd')).rejects.toThrow(/hosted_secret_ref_malformed/);
    expect(readIntegrationKey).not.toHaveBeenCalled();
  });

  it('delegates every other reference kind to the generic resolver, trimmed', async () => {
    const readIntegrationKey = vi.fn(async () => 'never');
    const resolveOther = vi.fn(async (reference: string) => `resolved:${reference}`);
    const resolve = createHostedSecretRefResolver({ readIntegrationKey, resolveOther });

    await expect(resolve(' env:WORKOS_API_KEY ')).resolves.toBe('resolved:env:WORKOS_API_KEY');
    await expect(resolve('file:/run/secrets/x')).resolves.toBe('resolved:file:/run/secrets/x');
    expect(readIntegrationKey).not.toHaveBeenCalled();
  });

  it('default resolver keeps the env: kind working end to end', async () => {
    process.env.PAPERCUSP_TEST_HOSTED_SECRET_REF = 'from-env';
    await expect(resolveHostedSecretRef('env:PAPERCUSP_TEST_HOSTED_SECRET_REF')).resolves.toBe('from-env');
    expect(HOSTED_INTEGRATION_SECRET_REF_PREFIX).toBe('integration:');
  });

  it('production rejects local/integration/latest references before reading either store', async () => {
    const readIntegrationKey = vi.fn(async () => 'must-not-read');
    const resolveOther = vi.fn(async () => 'must-not-read');
    const resolve = createHostedSecretRefResolver({ env: { PAPERCUSP_DEPLOYMENT_ENVIRONMENT: 'production' }, readIntegrationKey, resolveOther });
    const UNPINNED_WORKOS_SECRET_REF = `${GCP_SECRET_REF_PREFIX}projects/123456789012/locations/us-central1/secrets/test-workos/versions/latest`;
    const PINNED_WORKOS_SECRET_REF = `${GCP_SECRET_REF_PREFIX}projects/123456789012/locations/us-central1/secrets/test-workos/versions/2`;
    for (const reference of ['env:WORKOS_API_KEY', 'file:/run/secret', 'integration:WORKOS_API_KEY',
      UNPINNED_WORKOS_SECRET_REF]) {
      await expect(resolve(reference)).rejects.toThrow('requires_pinned_secret_manager');
    }
    expect(readIntegrationKey).not.toHaveBeenCalled();
    expect(resolveOther).not.toHaveBeenCalled();
    const ref = PINNED_WORKOS_SECRET_REF;
    await expect(resolve(ref)).resolves.toBe('must-not-read');
    expect(resolveOther).toHaveBeenCalledWith(ref);
  });
});
