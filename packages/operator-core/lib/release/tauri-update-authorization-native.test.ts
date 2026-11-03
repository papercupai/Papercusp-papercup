import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { encodeTauriUpdateAuthorization, type TauriUpdateAuthorization } from '../../../../libs/generic/tauri-release-kit/src/signature.mjs';

// Compile the actual portable native consumer, avoiding a dependency on a running
// desktop/WebKit. This maintained Vitest test owns the Cargo harness and fixtures.
it('native consumer verifies real dual signatures, actual bytes, identities and current trust', () => {
  const root = mkdtempSync(join(tmpdir(), 'tauri-update-authorization-'));
  try {
    const key = (id: string, principalId: string) => {
      const pair = generateKeyPairSync('ed25519');
      const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
      const keyId = createHash('sha256').update(id).digest().subarray(0, 8);
      return {
        trusted: { id, epoch: 2, principalId, revoked: false,
          publicKey: `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')}\n` },
        sign(payload: string, algorithm = 'ED') {
          const bytes = Buffer.from(payload);
          const signature = sign(null, algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes, pair.privateKey);
          const comment = 'timestamp:2 file:update-authorization';
          const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), pair.privateKey).toString('base64');
          return Buffer.from(`untrusted comment: update\n${Buffer.concat([Buffer.from(algorithm), keyId, signature]).toString('base64')}\ntrusted comment: ${comment}\n${global}\n`).toString('base64');
        },
      };
    };
    const signer = key('release', 'release-principal');
    const approver = key('reviewer', 'reviewer-principal');
    const candidate = { artifact: 'actual candidate archive\n', policy: '{"effect":"bounded"}', configuration: '{"product":"gui"}',
      sourceRevision: 'd'.repeat(40), version: '1.2.3', product: 'gui', platform: 'linux-x86_64', authorId: 'author-principal' };
    const digest = (s: string) => createHash('sha256').update(s).digest('hex');
    const metadata: TauriUpdateAuthorization = {
      schema: 'tauri-update-authorization-v1', artifactSha256: digest(candidate.artifact),
      policySha256: digest(candidate.policy), configurationSha256: digest(candidate.configuration),
      sourceRevision: candidate.sourceRevision, version: candidate.version, product: candidate.product,
      platform: candidate.platform, authorId: candidate.authorId, approverId: 'reviewer', approverEpoch: 2,
      signerId: 'release', signerEpoch: 2, rootEpoch: 3, rollbackCounter: 7, issuedAt: 1000, expiresAt: 3000,
    };
    const envelope = (payload = encodeTauriUpdateAuthorization(metadata), algorithm = 'ED') =>
      ({ payload, signature: signer.sign(payload, algorithm), approvalSignature: approver.sign(payload, algorithm) });
    const baseline = { trust: { rootEpoch: 3, minRollbackCounter: 7, minIssuedAt: 1000,
      maxMetadataAgeMs: 1500, signers: [signer.trusted], approvers: [approver.trusted] },
      envelope: envelope(), candidate, now: 2000, allow: true, reason: '' };
    const vectors: Array<typeof baseline & { name: string }> = [];
    const add = (name: string, edit: (v: typeof baseline) => void, allow = false, reason = '') => {
      const v = structuredClone(baseline); edit(v); vectors.push({ ...v, allow, reason, name });
    };
    add('current authorized candidate', () => {}, true);
    add('legacy Ed signatures with complete authenticated comments', v => { v.envelope = envelope(undefined, 'Ed'); }, true);
    add('base64 wrapped pinned keys', v => {
      for (const k of [...v.trust.signers, ...v.trust.approvers]) k.publicKey = Buffer.from(k.publicKey).toString('base64');
    }, true);
    add('native public key ED marker', v => {
      for (const k of [...v.trust.signers, ...v.trust.approvers]) {
        const raw = Buffer.from(k.publicKey.trim().split('\n').at(-1)!, 'base64'); raw.write('ED'); k.publicKey = raw.toString('base64');
      }
    }, true);
    for (const field of ['artifact', 'policy', 'configuration'] as const) {
      add(`changed actual ${field} bytes`, v => { v.candidate[field] += 'tampered'; }, false,
        `candidate ${{ artifact: 'artifactSha256', policy: 'policySha256', configuration: 'configurationSha256' }[field]}`);
    }
    for (const field of ['sourceRevision', 'version', 'product', 'platform', 'authorId'] as const) {
      add(`changed actual ${field}`, v => { v.candidate[field] += 'x'; }, false, `candidate ${field}`);
    }
    for (const field of ['signature', 'approvalSignature'] as const) {
      add(`wrong ${field}`, v => { v.envelope[field] = key('wrong', 'wrong-principal').sign(v.envelope.payload); });
      add(`tampered trusted comment in ${field}`, v => {
        v.envelope[field] = Buffer.from(Buffer.from(v.envelope[field], 'base64').toString().replace('timestamp:2', 'timestamp:3')).toString('base64');
      });
      add(`incomplete ${field}`, v => { v.envelope[field] = Buffer.from(Buffer.from(v.envelope[field], 'base64').toString().split('\n').slice(0, 2).join('\n')).toString('base64'); });
      add(`extra line in ${field}`, v => { v.envelope[field] = Buffer.from(Buffer.from(v.envelope[field], 'base64').toString() + 'ignored\n').toString('base64'); });
    }
    for (const role of ['signers', 'approvers'] as const) {
      add(`revoked ${role}`, v => { v.trust[role][0].revoked = true; });
      add(`rotated ${role} epoch`, v => { v.trust[role][0].epoch++; });
      add(`ambiguous ${role}`, v => { v.trust[role].push({ ...v.trust[role][0] }); });
      add(`missing ${role}`, v => { v.trust[role] = []; });
      add(`invalid ${role} key`, v => { v.trust[role][0].publicKey = 'untrusted'; });
    }
    add('reviewer is author', v => { v.trust.approvers[0].principalId = candidate.authorId; }, false, 'not independent');
    add('reviewer is release principal', v => { v.trust.approvers[0].principalId = signer.trusted.principalId; }, false, 'not independent');
    add('same cryptographic key under a distinct principal', v => { v.trust.approvers[0].publicKey = signer.trusted.publicKey; }, false, 'not independent');
    for (const [field, value] of [['rootEpoch', 4], ['minRollbackCounter', 8], ['minIssuedAt', 1001], ['maxMetadataAgeMs', 999], ['maxMetadataAgeMs', 0]] as const) {
      add(`${field}=${value}`, v => { v.trust[field] = value; });
    }
    add('future metadata', v => { v.now = 999; });
    add('expired metadata', v => { v.now = 3000; });
    add('safe clock bound', v => { v.now = Number.MAX_SAFE_INTEGER + 1; });
    add('metadata modified after review', v => { v.envelope.payload = v.envelope.payload.replace('"rollbackCounter":7', '"rollbackCounter":8'); });
    add('signed policy differs from actual extracted policy', v => {
      v.envelope = envelope(encodeTauriUpdateAuthorization({ ...metadata, policySha256: 'b'.repeat(64) }));
    }, false, 'candidate policySha256');
    for (const [name, payload] of [
      ['reordered canonical fields', JSON.stringify(Object.fromEntries(Object.entries(metadata).reverse()))],
      ['unknown metadata field', JSON.stringify({ ...metadata, ignored: true })],
      ['duplicate metadata field', encodeTauriUpdateAuthorization(metadata).replace('{', '{"schema":"tauri-update-authorization-v1",')],
      ['unsafe counter', JSON.stringify({ ...metadata, rollbackCounter: Number.MAX_SAFE_INTEGER + 1 })],
      ['negative counter', JSON.stringify({ ...metadata, rollbackCounter: -1 })],
      ['noninteger counter', JSON.stringify({ ...metadata, rollbackCounter: 7.5 })],
      ['whitespace in label', JSON.stringify({ ...metadata, authorId: 'author principal' })],
    ]) add(name, v => { v.envelope = envelope(payload); });

    const source = resolve(__dirname, '../../../../papercusp-desktop/src-tauri/src/update_authorization.rs');
    const fixtures = join(root, 'vectors.json');
    writeFileSync(fixtures, JSON.stringify(vectors));
    writeFileSync(join(root, 'Cargo.toml'), [
      '[package]', 'name="update-authorization-native-regression"', 'version="0.0.0"', 'edition="2021"',
      '[workspace]', '[lib]', 'path="driver.rs"', '[dependencies]',
      'base64="=0.22.1"', 'minisign-verify="=0.2.5"', 'sha2="=0.10.9"',
      'serde={version="1",features=["derive"]}', 'serde_json="1"', 'libc="0.2"',
    ].join('\n'));
    writeFileSync(join(root, 'driver.rs'), `
#[path = ${JSON.stringify(source)}] mod update_authorization;
#[cfg(test)] mod tests {
    use super::update_authorization::{verify, Candidate, Envelope, Trust};
    use serde::Deserialize;
    #[derive(Deserialize)] #[serde(rename_all="camelCase")]
    struct Input { artifact:String, policy:String, configuration:String, source_revision:String,
        version:String, product:String, platform:String, author_id:String }
    #[derive(Deserialize)] struct Vector { name:String, trust:Trust, envelope:Envelope,
        candidate:Input, now:u64, allow:bool, reason:String }
    #[test] fn authentic_cross_language_vectors() {
        let vectors:Vec<Vector> = serde_json::from_str(include_str!(${JSON.stringify(fixtures)})).unwrap();
        assert_eq!(vectors.len(), ${vectors.length});
        for v in vectors {
            let i=&v.candidate;
            let c=Candidate { artifact:i.artifact.as_bytes(), policy:i.policy.as_bytes(),
                configuration:i.configuration.as_bytes(), source_revision:&i.source_revision,
                version:&i.version, product:&i.product, platform:&i.platform, author_id:&i.author_id };
            let result=verify(&v.trust, &v.envelope, &c, v.now);
            assert_eq!(result.is_ok(),v.allow,"{}: {:?}",v.name,result.as_ref().err());
            match result {
                Ok(authorized) => assert_eq!(authorized.metadata().rollback_counter,7),
                Err(reason) => assert!(reason.contains(&v.reason),"{}: {}",v.name,reason),
            }
            println!("native-vector: {}",v.name);
        }
    }
}
`);
    const result = spawnSync('cargo', ['test', '--offline', '--manifest-path', join(root, 'Cargo.toml'), '--', '--nocapture'],
      { encoding: 'utf8', timeout: 120_000, env: { ...process.env, CARGO_TARGET_DIR: join(root, 'target') } });
    expect(result.status, String(result.error || result.stderr || result.stdout)).toBe(0);
    expect(result.stdout).toContain('0 failed; 0 ignored');
    if (process.platform !== 'win32') {
      expect(result.stdout).toContain('protected_policy_reloads_current_revocation_and_floors ... ok');
      expect(result.stdout).toContain('protected_policy_refuses_missing_symlink_hardlink_fifo_and_permissions ... ok');
      expect(result.stdout).toContain('protected_policy_rejects_unbounded_ambiguous_or_incomplete_input ... ok');
      expect(result.stdout).toContain('protected_policy_component_open_does_not_follow_directory_symlinks ... ok');
    }
    for (const vector of vectors) expect(result.stdout).toContain(`native-vector: ${vector.name}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
