import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { integrationNeedsPostgres, setupIntegrationSubstrate } from '../test/_integration-substrate.globalSetup';

const privateTransport = fileURLToPath(new URL(
  './agent-tools/capability/vm-copy-authority-bridge.integration.test.ts', import.meta.url,
));
const databaseTest = fileURLToPath(new URL('./work-items-corroboration.integration.test.ts', import.meta.url));
const selectionCanary = fileURLToPath(new URL('./integration-substrate-selection.integration.test.ts', import.meta.url));
const project = { name: 'fixture-project' };

describe('operator-core integration substrate selection (EI-26266395178004133)', () => {
  it.each([privateTransport, selectionCanary])('omits PostgreSQL for the exact selected private suite %s', async path => {
    const loaders = { baseline: vi.fn(), org: vi.fn() };
    await setupIntegrationSubstrate(project, [path], loaders);
    expect(loaders.baseline).not.toHaveBeenCalled();
    expect(loaders.org).not.toHaveBeenCalled();
  });

  it.each([{ paths: [] }, { paths: [databaseTest] }, { paths: [privateTransport, databaseTest] }, { paths: [`${privateTransport}.other`] }])(
    'retains PostgreSQL for empty, database, mixed and unknown selections: $paths', ({ paths }) => {
      expect(integrationNeedsPostgres(paths)).toBe(true);
    },
  );

  it('runs the existing baseline then org setup and preserves baseline teardown', async () => {
    const calls: string[] = [];
    const teardown = vi.fn(async () => { calls.push('teardown'); });
    const result = await setupIntegrationSubstrate(project, [databaseTest], {
      baseline: async () => async p => { expect(p).toBe(project); calls.push('baseline'); return teardown; },
      org: async () => async p => { expect(p).toBe(project); calls.push('org'); },
    });
    expect(calls).toEqual(['baseline', 'org']);
    expect(result).toBe(teardown);
    await result?.();
    expect(calls).toEqual(['baseline', 'org', 'teardown']);
  });

  it('cleans the baseline when org setup fails', async () => {
    const teardown = vi.fn(async () => {});
    await expect(setupIntegrationSubstrate(project, [databaseTest], {
      baseline: async () => async () => teardown,
      org: async () => { throw new Error('org-load-failed'); },
    })).rejects.toThrow('org-load-failed');
    expect(teardown).toHaveBeenCalledOnce();
  });

  it('does not start org setup or mask a baseline refusal', async () => {
    const org = vi.fn();
    await expect(setupIntegrationSubstrate(project, [databaseTest], {
      baseline: async () => async () => { throw new Error('storage-refused'); }, org,
    })).rejects.toThrow('storage-refused');
    expect(org).not.toHaveBeenCalled();
  });

  it('keeps the maintained integration config wired to the substrate selector', () => {
    const config = readFileSync(new URL('../vitest.integration.config.ts', import.meta.url), 'utf8');
    expect(config).toContain("globalSetup: [resolve(__dirname, 'test/_integration-substrate.globalSetup.ts')]");
    expect(config).toContain("layer: 'integration'");
  });
});
