import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { measureProviderPackageAcceptance, measureProviderVerificationClaims, measureRequestedProviderAdditions,
  type ProviderPackageInput } from './provider-package-acceptance';

const offline = 'Verification uses recorded HTTP fakes and the SDK conformance kit. Live verification pending.';
function pkg(id: string): ProviderPackageInput {
  return { path: `plugins/${id}/papercusp.json`, readme: offline, entryPresent: true, sha256: 'fixture',
    manifest: { kind: 'plugin', main: './index.cjs', provider: { id, contractVersion: 1, datatypes: ['social-post'],
      capabilities: ['social.post'], verification: { capabilities: { 'social.post': '2026-10-16' } } } } };
}
function completePopulation() {
  const linkedin = pkg('linkedin-company');
  Object.assign(linkedin.manifest.provider, { oauth: { scopes: ['w_organization_social'] },
    configSchema: { properties: { organizationId: { type: 'string' } } } });
  return [linkedin, pkg('x-twitter'), pkg('devto'), pkg('hashnode'), pkg('discord')];
}

describe('D-018 R6 requested provider additions detector', () => {
  it('requires the entire five-addition population, independently of detector test health', () => {
    expect(measureRequestedProviderAdditions(completePopulation())).toMatchObject({ verdict: 'pass', checked: [
      'LinkedIn company page', 'X', 'dev.to', 'Hashnode', 'Discord community bot' ], failures: [] });
  });
  it.each(['linkedin-company', 'x-twitter', 'devto', 'hashnode', 'discord'])('detects the missing-package inverse for %s', id => {
    const result = measureRequestedProviderAdditions(completePopulation().filter(p => p.manifest.provider.id !== id));
    expect(result.verdict).toBe('fail'); expect(result.failures).toHaveLength(1); expect(result.checked).toHaveLength(4);
  });
  it('does not count a personal LinkedIn package as the company-page addition', () => {
    const packages = completePopulation(); packages[0] = pkg('linkedin');
    expect(measureRequestedProviderAdditions(packages)).toMatchObject({ verdict: 'fail', failures: [{ package: 'LinkedIn company page' }] });
  });
  it('rejects placeholders, missing executable entries and duplicate providers', () => {
    for (const change of ['entry', 'kind', 'duplicate']) {
      const packages = completePopulation();
      if (change === 'entry') packages[1].entryPresent = false;
      if (change === 'kind') packages[1].manifest.kind = 'template';
      if (change === 'duplicate') packages.push(pkg('x-twitter'));
      expect(measureRequestedProviderAdditions(packages).verdict, change).toBe('fail');
    }
  });
});

describe('D-018 R7 verification and capability claims detector', () => {
  it('accepts explicitly offline fake/conformance labels without calling contract dates live runs', () => {
    const linkedin = pkg('linkedin'); Object.assign(linkedin.manifest.provider, { sync: false, oauth: { scopes: ['openid', 'profile', 'w_member_social'] } });
    expect(measureProviderVerificationClaims([pkg('x-twitter'), linkedin])).toMatchObject({ verdict: 'pass', failures: [], unknown: [] });
  });
  it.each(['Live-verified on a real account.', 'Verified live on a real account.', 'Live verification passed.'])('detects a false-live inverse appended after a pending label: %s', claim => {
    const subject = pkg('x-twitter'); subject.readme += '\n' + claim;
    expect(measureProviderVerificationClaims([subject])).toMatchObject({ verdict: 'fail', failures: [{ package: 'x-twitter', reason: expect.stringContaining('independently resolved') }] });
  });
  it('checks manifest descriptions and structured labels too', () => {
    const subject = pkg('x-twitter'); subject.manifest.description = 'Live-verified';
    expect(measureProviderVerificationClaims([subject]).verdict).toBe('fail');
    delete subject.manifest.description; subject.manifest.provider.verification.level = 'live';
    expect(measureProviderVerificationClaims([subject]).verdict).toBe('fail');
  });
  it('does not let a negative statement hide a later positive live claim', () => {
    const subject = pkg('x-twitter'); subject.readme += '\nNo live-account verification has been performed. Live-verified.';
    expect(measureProviderVerificationClaims([subject]).verdict).toBe('fail');
  });
  it.each(['reply', 'organization', 'scope'])('detects unsupported LinkedIn capability/approval inverse: %s', change => {
    const subject = pkg('linkedin'); subject.manifest.provider.sync = false;
    if (change === 'reply') subject.manifest.provider.capabilities.push('social.reply');
    if (change === 'organization') subject.manifest.provider.configSchema = { properties: { organizationId: { type: 'string' } } };
    if (change === 'scope') subject.manifest.provider.oauth = { scopes: ['w_organization_social'] };
    expect(measureProviderVerificationClaims([subject]).failures.some(f => f.reason.includes('self-serve member grant'))).toBe(true);
  });
  it('refuses a declared capability with no verified contract or an explicit blocker', () => {
    const subject = pkg('x-twitter'); subject.manifest.provider.capabilities.push('social.reply');
    expect(measureProviderVerificationClaims([subject]).verdict).toBe('fail');
    subject.manifest.provider.verification.capabilities['social.reply'] = '2026-10-16';
    subject.manifest.provider.verification.blockedOn = { 'social.reply': 'Application approval pending' };
    expect(measureProviderVerificationClaims([subject]).verdict).toBe('fail');
  });
  it('accepts a separately registered blocked company package but detects a missing approval wall or borrowed identity', () => {
    const subject = pkg('linkedin-company');
    Object.assign(subject.manifest.provider, { oauth: { clientRegistrationRef: 'linkedin-company',
      scopes: ['openid', 'profile', 'r_organization_social', 'w_organization_social'],
      identity: { url: 'https://api.linkedin.com/v2/userinfo', idField: 'sub' } },
      configSchema: { properties: { organizationId: { type: 'string' } } } });
    subject.manifest.provider.verification.blockedOn = 'Partner approval and Member Data review pending';
    expect(measureProviderVerificationClaims([subject]).verdict).toBe('pass');
    delete subject.manifest.provider.verification.blockedOn;
    expect(measureProviderVerificationClaims([subject]).failures).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('approval-blocked') }));
    subject.manifest.provider.verification.blockedOn = 'Partner approval pending';
    subject.manifest.provider.oauth.clientRegistrationRef = 'linkedin';
    expect(measureProviderVerificationClaims([subject]).failures).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('personal member grant') }));
  });
  it('keeps missing verification labels and an empty population unknown', () => {
    for (const readme of [null, 'Contract reviewed 2026-10-16.', 'Live verification pending.']) {
      const subject = pkg('x-twitter'); subject.readme = readme;
      expect(measureProviderVerificationClaims([subject]).verdict).toBe('unknown');
    }
    expect(measureProviderVerificationClaims([]).verdict).toBe('unknown');
  });
});

describe('provider acceptance instrument reads real package inputs', () => {
  it('measures disk removals and false-live edits; malformed manifests never disappear into a pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-acceptance-'));
    try {
      for (const subject of completePopulation()) {
        const directory = join(root, 'libs/papercusp/plugins', subject.manifest.provider.id);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'papercusp.json'), JSON.stringify(subject.manifest));
        await writeFile(join(directory, 'README.md'), subject.readme!);
        await writeFile(join(directory, 'index.cjs'), 'module.exports = {};');
      }
      const before = await measureProviderPackageAcceptance(root);
      expect(before.additions.verdict).toBe('pass');
      await rm(join(root, 'libs/papercusp/plugins/hashnode'), { recursive: true });
      await writeFile(join(root, 'libs/papercusp/plugins/x-twitter/README.md'), offline + '\nLive-verified.');
      const after = await measureProviderPackageAcceptance(root);
      expect(after.additions).toMatchObject({ verdict: 'fail', failures: [{ package: 'Hashnode' }] });
      expect(after.claims.failures).toContainEqual(expect.objectContaining({ package: 'x-twitter', reason: expect.stringContaining('Live verification claimed') }));
      expect(after.claims.evidence).not.toEqual(before.claims.evidence);
      await writeFile(join(root, 'libs/papercusp/plugins/x-twitter/papercusp.json'), '{');
      expect((await measureProviderPackageAcceptance(root)).claims.unknown).toContainEqual(expect.objectContaining({ package: expect.stringContaining('x-twitter') }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
