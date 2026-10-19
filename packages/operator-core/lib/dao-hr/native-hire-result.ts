import assert from 'node:assert/strict';

/** The outer native bootstrap's admission checks, reusable for retained journey evidence. */
export function assertNativeHireResult(result: unknown): void {
  assert.ok(result && typeof result === 'object', 'Native hire result must be an object');
  const evidence = result as Record<string, unknown>;
  for (const field of ['hireExecuted', 'acceptanceVerified', 'memberAdmitted', 'nonBinding',
    'capTableVerified', 'myEquityVerified', 'nonBindingVisible']) {
    assert.equal(evidence[field], true, 'Native hire result requires ' + field);
  }
  assert.deepEqual(evidence.runtimeUnits, ['desktop-shell', 'documenso-sandbox', 'test-chain'],
    'Native hire result must name every isolated runtime unit');
  for (const field of ['proposalHash', 'executionHash', 'acceptanceHash']) {
    assert.ok(typeof evidence[field] === 'string' && /^0x[a-f0-9]{64}$/.test(evidence[field]),
      'Native hire result requires a transaction hash for ' + field);
  }
  assert.ok(typeof evidence.documensoEnvelopeId === 'string' && evidence.documensoEnvelopeId.length > 0,
    'Native hire result requires the provider envelope identity');
  assert.equal(evidence.auditCertificateIdentityKind, 'provider-resource-path');
  assert.equal(evidence.auditCertificateId,
    '/api/v2/envelope/' + encodeURIComponent(evidence.documensoEnvelopeId) + '/certificate/download');
  assert.ok(typeof evidence.auditCertificateSha256 === 'string'
    && /^0x[a-f0-9]{64}$/.test(evidence.auditCertificateSha256), 'Native hire result requires the certificate hash');
  assert.ok(evidence.documentHash && typeof evidence.documentHash === 'object',
    'Native hire result requires document hashes');
  const documentHash = evidence.documentHash as Record<string, unknown>;
  assert.ok(typeof documentHash.provider === 'string' && /^0x[a-f0-9]{64}$/.test(documentHash.provider),
    'Native hire result requires the provider document hash');
  assert.equal(documentHash.stored, documentHash.provider, 'Native hire stored and provider document hashes must match');
}
