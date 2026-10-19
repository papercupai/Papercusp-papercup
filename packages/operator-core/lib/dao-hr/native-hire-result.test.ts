import { describe, expect, it } from 'vitest';
import { assertNativeHireResult } from './native-hire-result';

function completedHire() {
  return {
    hireExecuted: true, acceptanceVerified: true, memberAdmitted: true, nonBinding: true,
    capTableVerified: true, myEquityVerified: true, nonBindingVisible: true,
    runtimeUnits: ['desktop-shell', 'documenso-sandbox', 'test-chain'],
    proposalHash: '0x' + '1'.repeat(64), executionHash: '0x' + '2'.repeat(64), acceptanceHash: '0x' + '3'.repeat(64),
    documensoEnvelopeId: 'envelope/native', auditCertificateIdentityKind: 'provider-resource-path',
    auditCertificateId: '/api/v2/envelope/envelope%2Fnative/certificate/download',
    auditCertificateSha256: '0x' + '4'.repeat(64),
    documentHash: { provider: '0x' + '5'.repeat(64), stored: '0x' + '5'.repeat(64) },
  };
}

describe('native hire result admission', () => {
  it('accepts complete journey evidence', () => {
    expect(() => assertNativeHireResult(completedHire())).not.toThrow();
  });
  it('refuses journey evidence without the executed hire proposal transaction hash', () => {
    const { proposalHash: _, ...missing } = completedHire();
    expect(() => assertNativeHireResult(missing)).toThrow('proposalHash');
  });
  it.each(['proposalHash', 'executionHash', 'acceptanceHash'] as const)('refuses a malformed %s', field => {
    expect(() => assertNativeHireResult({ ...completedHire(), [field]: 'not-a-transaction' })).toThrow(field);
  });
  it.each(['desktop-shell', 'documenso-sandbox', 'test-chain'])('refuses evidence omitting the %s runtime unit', unit => {
    const evidence = completedHire();
    evidence.runtimeUnits = evidence.runtimeUnits.filter(value => value !== unit);
    expect(() => assertNativeHireResult(evidence)).toThrow('every isolated runtime unit');
  });
  it('refuses a completed journey without member admission', () => {
    expect(() => assertNativeHireResult({ ...completedHire(), memberAdmitted: false })).toThrow('memberAdmitted');
  });
  it('refuses missing or mismatched provider artifacts', () => {
    const evidence = completedHire();
    expect(() => assertNativeHireResult({ ...evidence, auditCertificateId: undefined })).toThrow();
    expect(() => assertNativeHireResult({ ...evidence, documentHash: { ...evidence.documentHash, stored: '0x' + '6'.repeat(64) } })).toThrow('must match');
  });
});
