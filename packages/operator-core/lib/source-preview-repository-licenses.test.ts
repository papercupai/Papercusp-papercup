import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditPublicRepositoryLicenses, PUBLIC_LICENSE_ID, PUBLIC_LICENSE_PATH, ROOT } from '../../../scripts/source-preview.mjs';
import { parseOperationalEvidenceArtifact } from './agent-tools/testing/record-run';

const text = 'reviewed license fixture\n';
const sha256 = createHash('sha256').update(text).digest('hex');
const head = 'a'.repeat(40);
const repo = (name: string, branch = 'staging') => ({ full_name: `Papercusp/${name}`, private: false, default_branch: branch, license: { spdx_id: 'Apache-2.0' } });

function fixture(options: { secondPage?: boolean; missing?: string; body?: string; name?: string; blobMismatch?: boolean; changedPopulation?: boolean; apiFailure?: boolean; duplicate?: boolean; repeatedPage?: boolean; empty?: boolean } = {}) {
  const calls: string[] = [];
  const actualText = options.body ?? text;
  const actualBlob = createHash('sha1').update(`blob ${Buffer.byteLength(actualText)}\0${actualText}`).digest('hex');
  let starts = 0;
  const api = async (endpoint: string): Promise<{ headers: Record<string, string>; body: unknown }> => {
    calls.push(endpoint);
    if (endpoint.startsWith('orgs/')) {
      if (endpoint.includes('page=1')) starts += 1;
      const second = endpoint.includes('page=2');
      const body = options.empty ? [] : second ? [repo(options.duplicate ? 'one' : 'two')] : [repo(options.changedPopulation && starts > 1 ? 'changed' : options.name ?? 'one')];
      const next = options.repeatedPage ? 1 : options.secondPage && !second ? 2 : null;
      return { headers: next ? { link: `<https://api.github.com/orgs/Papercusp/repos?type=public&per_page=100&page=${next}>; rel="next"` } : {}, body };
    }
    if (options.apiFailure) throw new Error('HTTP 403');
    if (endpoint.includes('/commits/')) return { headers: {}, body: { sha: head } };
    if (endpoint.includes('/contents?')) return { headers: {}, body: options.missing && endpoint.includes(`/${options.missing}/`) ? [] : [{ name: 'LICENSE', path: 'LICENSE', type: 'file', sha: actualBlob }] };
    return { headers: {}, body: { encoding: 'base64', content: Buffer.from(actualText).toString('base64'), sha: options.blobMismatch ? 'b'.repeat(40) : actualBlob } };
  };
  return { api, calls, licenseHashes: { [sha256]: 'Apache-2.0' }, libraryRepositories: ['Papercusp/one', 'Papercusp/two'] };
}

describe('public repository licensing census', () => {
  it('produces artifacts accepted by the real operational evidence recorder on both pass and fail', async () => {
    for (const options of [{}, { missing: 'one' }]) {
      const result = await auditPublicRepositoryLicenses(fixture(options));
      expect(parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify(result))).exitCode).toBe(result.exitCode);
    }
  });

  it('checks every page and reads bytes pinned to each actual default-branch commit', async () => {
    const fx = fixture({ secondPage: true });
    const result = await auditPublicRepositoryLicenses(fx);
    expect(result.exitCode).toBe(0);
    expect(result.rows.map((row) => row.repo)).toEqual(['Papercusp/one', 'Papercusp/two']);
    expect(fx.calls).toContain('repos/Papercusp/two/commits/staging');
    expect(fx.calls).toContain(`repos/Papercusp/two/contents/LICENSE?ref=${head}`);
    expect(result.licenseTexts[sha256]).toBe(text);
  });

  it('fails when a new repository on a later page has no license despite license metadata', async () => {
    const result = await auditPublicRepositoryLicenses(fixture({ secondPage: true, missing: 'two' }));
    expect(result.exitCode).toBe(1);
    expect(result.rows[1].errors).toEqual(['default branch has no root license file']);
  });

  it('refuses bytes whose Git blob does not match the pinned root entry', async () => {
    const result = await auditPublicRepositoryLicenses(fixture({ blobMismatch: true }));
    expect(result.exitCode).toBe(1);
    expect(result.rows[0].errors[0]).toMatch(/blob mismatch/);
  });

  it('refuses an API error instead of treating the repository as licensed or absent', async () => {
    const result = await auditPublicRepositoryLicenses(fixture({ apiFailure: true }));
    expect(result.exitCode).toBe(1);
    expect(result.rows[0].errors).toEqual(['HTTP 403']);
  });

  it('refuses unreviewed actual text even when the Git blob and license metadata look valid', async () => {
    const result = await auditPublicRepositoryLicenses(fixture({ body: 'Apache License\nAdditional unreviewed terms\n' }));
    expect(result.exitCode).toBe(1);
    expect(result.rows[0].errors).toEqual(['unreviewed license text: LICENSE']);
  });

  it('enforces the applicable product license rather than accepting any recognized license', async () => {
    const result = await auditPublicRepositoryLicenses(fixture({ name: 'goals' }));
    expect(result.exitCode).toBe(1);
    expect(result.rows[0].errors).toEqual(['D-011/D-023 require ELv2: LICENSE']);
  });

  it('recognizes the canonical SUL for the app without changing existing ELv2 component licenses', async () => {
    for (const [name, body, expected] of [
      ['papercusp-app', readFileSync(PUBLIC_LICENSE_PATH, 'utf8'), 'LicenseRef-Sustainable-Use-1.0'],
      ['cupboard-actions', readFileSync(join(ROOT, 'apps/operator-public/cupboard-actions/LICENSE'), 'utf8'), 'ELv2'],
    ]) {
      const { licenseHashes: _unused, ...fx } = fixture({ name, body });
      const result = await auditPublicRepositoryLicenses(fx);
      expect(result.exitCode).toBe(0);
      expect(result.rows[0].licenses[0].license).toBe(expected);
    }
    expect(PUBLIC_LICENSE_ID).toBe('LicenseRef-Sustainable-Use-1.0');
  });

  it('rejects the former ELv2 license for the app even when the license text is recognized', async () => {
    const fx = fixture({ name: 'papercusp-app' });
    fx.licenseHashes[sha256] = 'ELv2';
    const result = await auditPublicRepositoryLicenses(fx);
    expect(result.exitCode).toBe(1);
    expect(result.rows[0].errors).toEqual(['Application release requires SUL 1.0: LICENSE']);
  });

  it('does not silently relicense an existing ELv2 component under SUL', async () => {
    const fx = fixture({ name: 'goals' });
    fx.licenseHashes[sha256] = PUBLIC_LICENSE_ID;
    const result = await auditPublicRepositoryLicenses(fx);
    expect(result.exitCode).toBe(1);
    expect(result.rows[0].errors).toEqual(['D-011/D-023 require ELv2: LICENSE']);
  });

  it.each(['ELv2', 'LicenseRef-Sustainable-Use-1.0'])('preserves permissive library policy when text is recognized as %s', async (license) => {
    const fx = fixture();
    fx.licenseHashes[sha256] = license;
    const result = await auditPublicRepositoryLicenses(fx);
    expect(result.exitCode).toBe(1);
    expect(result.rows[0].errors).toEqual(['D-003 requires a permissive library license: LICENSE']);
  });

  it('refuses a population/default-branch change during the observation', async () => {
    const result = await auditPublicRepositoryLicenses(fixture({ changedPopulation: true }));
    expect(result.exitCode).toBe(1);
    expect(result.assertions[0].passed).toBe(false);
  });

  it('refuses duplicate repositories and looping pagination', async () => {
    await expect(auditPublicRepositoryLicenses(fixture({ secondPage: true, duplicate: true }))).rejects.toThrow(/repeats/);
    await expect(auditPublicRepositoryLicenses(fixture({ repeatedPage: true }))).rejects.toThrow(/repeated a page/);
  });

  it('refuses an empty population instead of producing a vacuous pass', async () => {
    await expect(auditPublicRepositoryLicenses(fixture({ empty: true }))).rejects.toThrow(/empty/);
  });
});
