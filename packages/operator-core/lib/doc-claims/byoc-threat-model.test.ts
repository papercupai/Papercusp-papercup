/**
 * Pins the threat-model deliverable for
 * hosted-byoc-confidentiality-correction-2026-10-02 P-002 / R-7.
 *
 * The page is canonically authored through docs:author and projected into the
 * docs tree. These assertions guard the security boundary that implementation
 * work in P-004..P-008 relies on: the strong promise is BYOC-only, browser code
 * is not a content endpoint, customer-held keys are recoverable/rotatable only
 * through customer-controlled authority, and metadata leakage remains explicit.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const REPO = new URL('../../../../', import.meta.url);
const THREAT_MODEL = readFileSync(
  new URL(
    'apps/operator-docs/src/content/docs/agent-insights/byoc-hosted-relay-confidentiality-threat-model.mdx',
    REPO,
  ),
  'utf8',
);

function section(heading: string, nextHeading?: string): string {
  const start = THREAT_MODEL.indexOf(`## ${heading}`);
  expect(start, `missing section: ${heading}`).toBeGreaterThanOrEqual(0);
  const end = nextHeading ? THREAT_MODEL.indexOf(`## ${nextHeading}`, start + heading.length) : -1;
  return THREAT_MODEL.slice(start, end >= 0 ? end : undefined);
}

describe('BYOC hosted-relay confidentiality threat model', () => {
  it('distinguishes the strong BYOC promise from the weaker vendor-hosted promise', () => {
    const promise = section('Security promise by hosting kind', 'Actors and adversary capabilities');

    expect(promise).toContain('### `byoc`: strong confidentiality promise');
    expect(promise).toContain('must not be able to read customer content');
    expect(promise).toContain('### `papercusp`: deliberately weaker promise');
    expect(promise).toContain('does not store, log, index, or emit workspace content as telemetry');
    expect(promise).toContain('confidential computing');
  });

  it('names every actor required by R-7 and explains the active-vendor limit', () => {
    const actors = section('Actors and adversary capabilities', 'Transport and trust anchors');

    for (const actor of [
      'Customer',
      'Vendor operator',
      'Active vendor adversary',
      'Network attacker',
      'Compromised browser',
    ]) {
      expect(actors, `missing actor: ${actor}`).toContain(actor);
    }
    expect(actors).toContain('Cannot substitute a BYOC host key');
    expect(actors).toContain('can deny service');
  });

  it('pins the independent trust anchor and browser-code delivery boundary', () => {
    const transport = section('Transport and trust anchors', 'Browser-code delivery boundary');
    const browser = section('Browser-code delivery boundary', 'Key custody and authorization');

    expect(transport).toContain('@hyperswarm/secret-stream');
    expect(transport).toContain('customer-controlled cloud channel');
    expect(transport).toContain('inner frame `type` in clear');
    expect(browser).toContain('Vendor-served JavaScript is not a trusted BYOC content endpoint');
    expect(browser).toContain('signed customer-installed desktop application');
    expect(browser).toContain('cannot receive the client private key');
  });

  it('documents key custody, recovery, rotation, revocation, and residual limits', () => {
    const custody = section('Key custody and authorization', 'Recovery, rotation, and revocation');
    const lifecycle = section('Recovery, rotation, and revocation', 'Residual limits and non-promises');
    const residual = section('Residual limits and non-promises');

    expect(custody).toContain('workspace-host static private key remains on the customer-controlled VM');
    expect(custody).toContain('D-143');
    expect(lifecycle).toContain('customer-held recovery material');
    expect(lifecycle).toContain('Host-key rotation');
    expect(lifecycle).toContain('Client-key rotation');
    expect(lifecycle).toContain('Revocation');
    expect(residual).toContain('Confidentiality does not provide availability');
    expect(residual).toContain('traffic volume, timing, and the per-frame audit cadence');
  });
});
