import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      sourceRevision: 'd'.repeat(40), version: '1.2.3', product: 'gui', platform: 'linux-x86_64', authorIds: ['author-principal', 'coauthor-principal'] };
    const digest = (s: string) => createHash('sha256').update(s).digest('hex');
    const metadata: TauriUpdateAuthorization = {
      schema: 'tauri-update-authorization-v2', artifactSha256: digest(candidate.artifact),
      policySha256: digest(candidate.policy), configurationSha256: digest(candidate.configuration),
      sourceRevision: candidate.sourceRevision, version: candidate.version, product: candidate.product,
      platform: candidate.platform, authorIds: candidate.authorIds, approverId: 'reviewer', approverEpoch: 2,
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
    for (const field of ['sourceRevision', 'version', 'product', 'platform'] as const) {
      add(`changed actual ${field}`, v => { v.candidate[field] += 'x'; }, false, `candidate ${field}`);
    }
    for (const authorIds of [[], ['author-principal'], ['author-principal', 'other-principal'], ['coauthor-principal', 'author-principal']]) {
      add(`changed actual authors ${JSON.stringify(authorIds)}`, v => { v.candidate.authorIds = authorIds; }, false, 'candidate authorIds');
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
    for (const principalId of candidate.authorIds) {
      add(`reviewer is source author ${principalId}`, v => { v.trust.approvers[0].principalId = principalId; }, false, 'not independent');
    }
    add('signed author set omits applicable coauthor', v => {
      v.envelope = envelope(encodeTauriUpdateAuthorization({ ...metadata, authorIds: ['author-principal'] }));
    }, false, 'candidate authorIds');
    add('author set changes after independent review', v => {
      v.candidate.authorIds = ['author-principal', 'other-principal'];
      const changed = envelope(encodeTauriUpdateAuthorization({ ...metadata, authorIds: v.candidate.authorIds }));
      v.envelope = { ...changed, approvalSignature: v.envelope.approvalSignature };
    }, false, 'approval signature');
    for (const authorIds of [Array.from({ length: 64 }, (_, i) => `author-${String(i).padStart(2, '0')}`), ['\u{10000}', '\ue000']]) {
      add(`canonical author set ${authorIds.length}`, v => {
        v.candidate.authorIds = authorIds;
        v.envelope = envelope(encodeTauriUpdateAuthorization({ ...metadata, authorIds }));
      }, true);
    }
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
      ['duplicate metadata field', encodeTauriUpdateAuthorization(metadata).replace('{', '{"schema":"tauri-update-authorization-v2",')],
      ['unsafe counter', JSON.stringify({ ...metadata, rollbackCounter: Number.MAX_SAFE_INTEGER + 1 })],
      ['negative counter', JSON.stringify({ ...metadata, rollbackCounter: -1 })],
      ['noninteger counter', JSON.stringify({ ...metadata, rollbackCounter: 7.5 })],
      ['legacy single author', JSON.stringify({ ...metadata, schema: 'tauri-update-authorization-v1', authorIds: undefined, authorId: 'author-principal' })],
      ['missing authors', JSON.stringify({ ...metadata, authorIds: undefined })],
      ...[null, [], 'author-principal', ['a', 'a'], ['z', 'a'], ['bad author'], ['a'.repeat(201)],
        Array.from({ length: 65 }, (_, i) => `a${String(i).padStart(2, '0')}`)]
        .map(authorIds => [`invalid authors ${JSON.stringify(authorIds)}`, JSON.stringify({ ...metadata, authorIds })]),
    ]) add(name, v => { v.envelope = envelope(payload); });

    const source = resolve(__dirname, '../../../../papercusp-desktop/src-tauri/src/update_authorization.rs');
    const fixtures = join(root, 'vectors.json');
    writeFileSync(fixtures, JSON.stringify(vectors));
    writeFileSync(join(root, 'Cargo.toml'), [
      '[package]', 'name="update-authorization-native-regression"', 'version="0.0.0"', 'edition="2021"',
      '[workspace]', '[lib]', 'path="driver.rs"', '[dependencies]',
      'base64="=0.22.1"', 'minisign-verify="=0.2.5"', 'sha2="=0.10.9"',
      'serde={version="1",features=["derive"]}', 'serde_json="1"', 'libc="0.2"',
      'object={version="=0.37.3",default-features=false,features=["read","std"]}',
    ].join('\n'));
    writeFileSync(join(root, 'driver.rs'), `
#[path = ${JSON.stringify(source)}] mod update_authorization;
#[cfg(test)] mod tests {
    use super::update_authorization::{verify, Candidate, Envelope, Trust};
    use serde::Deserialize;
    #[derive(Deserialize)] #[serde(rename_all="camelCase")]
    struct Input { artifact:String, policy:String, configuration:String, source_revision:String,
        version:String, product:String, platform:String, author_ids:Vec<String> }
    #[derive(Deserialize)] struct Vector { name:String, trust:Trust, envelope:Envelope,
        candidate:Input, now:u64, allow:bool, reason:String }
    #[test] fn authentic_cross_language_vectors() {
        let vectors:Vec<Vector> = serde_json::from_str(include_str!(${JSON.stringify(fixtures)})).unwrap();
        assert_eq!(vectors.len(), ${vectors.length});
        for v in vectors {
            let i=&v.candidate;
            let c=Candidate { artifact:i.artifact.as_bytes(), policy:i.policy.as_bytes(),
                configuration:i.configuration.as_bytes(), source_revision:&i.source_revision,
                version:&i.version, product:&i.product, platform:&i.platform, author_ids:&i.author_ids };
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

it('extracts actual build inputs from a compiled native image and refuses decoys or malformed sections', () => {
  const root = mkdtempSync(join(tmpdir(), 'tauri-update-candidate-'));
  try {
    const osNames: Record<string, string> = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
    const platform = `${osNames[process.platform]}-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
    const inputs = {
      schema: 'tauri-update-inputs-v2', policy: '{"effect":"bounded"}', configuration: '{"product":"gui"}',
      sourceRevision: 'd'.repeat(40), version: '1.2.3', product: 'gui', platform, authorIds: ['author-principal', 'coauthor-principal'],
    };
    const section = process.platform === 'darwin' ? '__DATA,__pcupd' : '.pcupd';
    const compile = (name: string, payload: string, options: { decoy?: boolean; duplicate?: boolean } = {}) => {
      const data = join(root, `${name}.json`);
      const source = join(root, `${name}.rs`);
      const binary = join(root, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
      writeFileSync(data, payload);
      const size = Buffer.byteLength(payload);
      const attr = options.decoy ? '' : `#[link_section=${JSON.stringify(section)}]`;
      writeFileSync(source, `${attr}\n#[used] static INPUTS:[u8;${size}]=*include_bytes!(${JSON.stringify(data)});
${options.duplicate ? `#[link_section=${JSON.stringify(process.platform === 'darwin' ? '__DATA,.pcupd' : '__pcupd')}]\n#[used] static SECOND:[u8;${size}]=*include_bytes!(${JSON.stringify(data)});` : ''}
fn main(){ std::hint::black_box(&INPUTS); ${options.duplicate ? 'std::hint::black_box(&SECOND);' : ''} }
`);
      const result = spawnSync('rustc', ['--edition=2021', '--crate-name', 'candidate_fixture', source, '-o', binary],
        { encoding: 'utf8', timeout: 30_000 });
      expect(result.status, String(result.error || result.stderr)).toBe(0);
      return binary;
    };
    const valid = compile('valid', JSON.stringify(inputs));
    const variants: Array<[string, string, { decoy?: boolean; duplicate?: boolean }?]> = [
      ['decoy outside provenance section', JSON.stringify(inputs), { decoy: true }],
      ['two provenance sections', JSON.stringify(inputs), { duplicate: true }],
      ['oversized section', ' '.repeat(1024 * 1024 + 1)],
      ['unknown field', JSON.stringify({ ...inputs, ignored: true })],
      ['reordered fields', JSON.stringify(Object.fromEntries(Object.entries(inputs).reverse()))],
      ['duplicate field', JSON.stringify(inputs).replace('{', '{"schema":"tauri-update-inputs-v2",')],
      ['wrong schema', JSON.stringify({ ...inputs, schema: 'unknown' })],
      ['wrong platform identity', JSON.stringify({ ...inputs, platform: 'darwin-universal' })],
      ['invalid source identity', JSON.stringify({ ...inputs, sourceRevision: 'dirty' })],
      ['legacy single author', JSON.stringify({ ...inputs, schema: 'tauri-update-inputs-v1', authorIds: undefined, authorId: 'author-principal' })],
      ['missing authors', JSON.stringify({ ...inputs, authorIds: undefined })],
      ...[[], ['a', 'a'], ['z', 'a'], ['bad author'], Array.from({ length: 65 }, (_, i) => `a${i}`)]
        .map(authorIds => [`invalid authors ${JSON.stringify(authorIds)}`, JSON.stringify({ ...inputs, authorIds })] as [string, string]),
      ['nonobject policy', JSON.stringify({ ...inputs, policy: '[]' })],
      ['nonobject configuration', JSON.stringify({ ...inputs, configuration: 'null' })],
    ];
    const images = variants.map(([name, payload, options], i) => ({ name, path: compile(`bad_${i}`, payload, options) }));
    const fixtures = join(root, 'images.json');
    writeFileSync(fixtures, JSON.stringify({ valid, inputs, images, artifactSha256: createHash('sha256').update(readFileSync(valid)).digest('hex') }));
    const source = resolve(__dirname, '../../../../papercusp-desktop/src-tauri/src/update_authorization.rs');
    writeFileSync(join(root, 'Cargo.toml'), [
      '[package]', 'name="update-candidate-native-regression"', 'version="0.0.0"', 'edition="2021"',
      '[workspace]', '[lib]', 'path="driver.rs"', '[dependencies]',
      'base64="=0.22.1"', 'minisign-verify="=0.2.5"', 'sha2="=0.10.9"',
      'serde={version="1",features=["derive"]}', 'serde_json="1"', 'libc="0.2"',
      'object={version="=0.37.3",default-features=false,features=["read","std"]}',
    ].join('\n'));
    writeFileSync(join(root, 'driver.rs'), `
#[path = ${JSON.stringify(source)}] mod update_authorization;
#[cfg(test)] mod tests {
    use super::update_authorization::extract_binary_inputs;
    use sha2::{Digest,Sha256};
    #[test] fn actual_compiled_image_and_negative_containers() {
        let fixtures:serde_json::Value=serde_json::from_str(include_str!(${JSON.stringify(fixtures)})).unwrap();
        let input=&fixtures["inputs"];
        let platform=input["platform"].as_str().unwrap();
        let bytes=std::fs::read(fixtures["valid"].as_str().unwrap()).unwrap();
        let extracted=extract_binary_inputs(&bytes,platform).unwrap();
        let candidate=extracted.candidate(&bytes);
        assert_eq!(candidate.policy,input["policy"].as_str().unwrap().as_bytes());
        assert_eq!(candidate.configuration,input["configuration"].as_str().unwrap().as_bytes());
        assert_eq!(candidate.source_revision,input["sourceRevision"].as_str().unwrap());
        assert_eq!(candidate.version,input["version"].as_str().unwrap());
        assert_eq!(candidate.product,input["product"].as_str().unwrap());
        assert_eq!(candidate.platform,platform);
        assert_eq!(serde_json::to_value(candidate.author_ids).unwrap(),input["authorIds"]);
        assert_eq!(format!("{:x}",Sha256::digest(candidate.artifact)),fixtures["artifactSha256"].as_str().unwrap());
        assert!(extract_binary_inputs(&bytes[..32],platform).is_err());
        assert!(extract_binary_inputs(&bytes,"unknown").is_err());
        let other=if platform=="linux-aarch64" {"linux-x86_64"}else{"linux-aarch64"};
        assert!(extract_binary_inputs(&bytes,other).is_err());
        let mut with_decoy=bytes.clone();
        with_decoy.extend_from_slice(b"manifest-supplied policy/configuration digests are not build inputs");
        assert_eq!(extract_binary_inputs(&with_decoy,platform).unwrap().candidate(&with_decoy).policy,candidate.policy);
        for image in fixtures["images"].as_array().unwrap() {
            let bytes=std::fs::read(image["path"].as_str().unwrap()).unwrap();
            assert!(extract_binary_inputs(&bytes,platform).is_err(),"{}",image["name"]);
            println!("native-extraction-refused: {}",image["name"]);
        }
        println!("native-extraction: actual compiled image and exact bytes");
    }
}
`);
    const result = spawnSync('cargo', ['test', '--offline', '--manifest-path', join(root, 'Cargo.toml'), 'actual_compiled_image_and_negative_containers', '--', '--nocapture'],
      { encoding: 'utf8', timeout: 120_000, env: { ...process.env, CARGO_TARGET_DIR: join(root, 'target') } });
    expect(result.status, String(result.error || result.stderr || result.stdout)).toBe(0);
    expect(result.stdout).toContain('native-extraction: actual compiled image and exact bytes');
    for (const [name] of variants) expect(result.stdout).toContain(`native-extraction-refused: ${JSON.stringify(name)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 240_000);

it('producer binds effective Tauri overlays and actual generated ACL bytes in retained native sections', () => {
  const root = mkdtempSync(join(tmpdir(), 'tauri-update-producer-'));
  try {
    const producer = resolve(__dirname, '../../../../papercusp-desktop/src-tauri/update_build_inputs.rs');
    const verifier = resolve(__dirname, '../../../../papercusp-desktop/src-tauri/src/update_authorization.rs');
    mkdirSync(join(root, 'capabilities'));
    writeFileSync(join(root, 'tauri.conf.json'), JSON.stringify({
      identifier: 'com.papercusp.producer-fixture', version: '1.2.3',
      app: { security: { csp: "default-src 'self'" }, windows: [{ label: 'main', title: 'base' }] },
      bundle: { active: false },
    }));
    const os = { linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform as 'linux' | 'darwin' | 'win32'];
    expect(os).toBeDefined();
    writeFileSync(join(root, `tauri.${os}.conf.json`), JSON.stringify({
      version: '1.2.4', app: { security: { csp: "default-src 'platform'" } },
    }));
    writeFileSync(join(root, 'capabilities/main.json'), JSON.stringify({
      identifier: 'main-capability', windows: ['main'], permissions: ['allow-probe'],
    }));
    const shared = ['serde={version="1",features=["derive"]}', 'serde_json="1"',
      'json-patch="=3.0.1"', 'tauri-utils={version="=2.9.3",features=["build-2"]}'];
    writeFileSync(join(root, 'Cargo.toml'), [
      '[package]', 'name="update-producer-native-regression"', 'version="0.0.0"', 'edition="2021"',
      '[workspace]', '[lib]', 'path="driver.rs"', '[build-dependencies]',
      'tauri-build="=2.6.3"', ...shared, '[dependencies]', ...shared,
      'base64="=0.22.1"', 'minisign-verify="=0.2.5"', 'sha2="=0.10.9"', 'libc="0.2"',
      'object={version="=0.37.3",default-features=false,features=["read","std"]}',
    ].join('\n'));
    writeFileSync(join(root, 'build.rs'), `
#[path=${JSON.stringify(producer)}] mod update_build_inputs;
fn main() {
    // Supply the contract normally emitted by tauri's build script, without
    // linking a desktop/WebKit runtime into this build-time integration test.
    std::env::set_var("DEP_TAURI_DEV", "true");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["probe"]))).unwrap();
    let dir=std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let out=std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let baked=std::collections::BTreeMap::from([
        ("PAPERCUSP_BUILD_SHA".into(), "d".repeat(40)),
        ("PAPERCUSP_BUILD_VERSION".into(), "1.2.5".into()),
        ("PAPERCUSP_CHANNEL".into(), "alpha".into()),
    ]);
    update_build_inputs::emit(&dir,&out,&std::env::var("TARGET").unwrap(),
        std::env::var("TAURI_CONFIG").ok().as_deref(),&baked).unwrap();
}
`);
    writeFileSync(join(root, 'driver.rs'), `
#[path=${JSON.stringify(producer)}] mod update_build_inputs;
#[path=${JSON.stringify(verifier)}] mod update_authorization;
include!(concat!(env!("OUT_DIR"),"/update-build-inputs.rs"));
#[cfg(test)] mod tests {
    use super::*;
    use object::{Object,ObjectSection};
    use serde_json::Value;
    use std::{collections::BTreeMap,fs,path::PathBuf,process::Command};
    #[test] fn producer_effective_inputs_and_refusals() {
        std::hint::black_box(&PAPERCUSP_UPDATE_BUILD_INPUTS);
        let out=PathBuf::from(env!("OUT_DIR"));
        let dir=PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let bytes=fs::read(out.join("update-build-inputs.json")).unwrap();
        assert_eq!(&bytes[..], &PAPERCUSP_UPDATE_BUILD_INPUTS);
        let input:Value=serde_json::from_slice(&bytes).unwrap();
        let config:Value=serde_json::from_str(input["configuration"].as_str().unwrap()).unwrap();
        let policy:Value=serde_json::from_str(input["policy"].as_str().unwrap()).unwrap();
        assert_eq!(input["version"],"1.2.5");
        assert_eq!(input["product"],"com.papercusp.producer-fixture");
        assert_eq!(input["sourceRevision"],"d".repeat(40));
        assert_eq!(input["schema"], "tauri-update-inputs-v2");
        assert_eq!(input["authorIds"], serde_json::json!([]));
        assert!(input.get("authorId").is_none());
        assert_eq!(config["tauri"]["app"]["windows"][0]["title"],"runtime");
        assert!(config["tauri"]["app"]["security"]["csp"].is_null());
        assert_eq!(config["nativeBuild"]["PAPERCUSP_CHANNEL"],"alpha");
        for (field,file) in [("aclManifests","acl-manifests.json"),("capabilities","capabilities.json")] {
            assert_eq!(policy[field].as_str().unwrap(),fs::read_to_string(out.join(file)).unwrap());
        }
        assert!(policy["aclManifests"].as_str().unwrap().contains("allow-probe"));
        assert!(policy["capabilities"].as_str().unwrap().contains("main-capability"));
        assert!(policy["allowedCommands"].is_null());
        // Use Cargo's exact target, including vendor/ABI, rather than guessing it.
        let target=std::env::var("PRODUCER_TEST_TARGET").unwrap();
        let baked=BTreeMap::from([("PAPERCUSP_BUILD_SHA".into(),"d".repeat(40)),
            ("PAPERCUSP_BUILD_VERSION".into(),"1.2.5".into()),("PAPERCUSP_CHANNEL".into(),"alpha".into())]);
        let overlay=std::env::var("TAURI_CONFIG").unwrap();
        // Independently exercise automatic OS overlay before the CLI overlay.
        let platform_out=out.join("platform-only"); fs::create_dir(&platform_out).unwrap();
        for file in ["acl-manifests.json","capabilities.json"] { fs::copy(out.join(file),platform_out.join(file)).unwrap(); }
        let mut no_version=baked.clone(); no_version.remove("PAPERCUSP_BUILD_VERSION");
        update_build_inputs::emit(&dir,&platform_out,&target,None,&no_version).unwrap();
        let platform_input:Value=serde_json::from_slice(&fs::read(platform_out.join("update-build-inputs.json")).unwrap()).unwrap();
        assert_eq!(platform_input["version"],"1.2.4");
        let platform_config:Value=serde_json::from_str(platform_input["configuration"].as_str().unwrap()).unwrap();
        assert_eq!(platform_config["tauri"]["app"]["security"]["csp"],"default-src 'platform'");
        // Mutating the actual generated capability bytes changes the recorded
        // policy even when every manifest-supplied digest would be unchanged.
        fs::write(platform_out.join("capabilities.json"),"{\\"changed\\":{}}").unwrap();
        update_build_inputs::emit(&dir,&platform_out,&target,Some(&overlay),&baked).unwrap();
        let changed:Value=serde_json::from_slice(&fs::read(platform_out.join("update-build-inputs.json")).unwrap()).unwrap();
        assert_ne!(changed["policy"],input["policy"]);
        fs::write(platform_out.join("allowed-commands.json"),"{\\"commands\\":[\\"probe\\"]}").unwrap();
        update_build_inputs::emit(&dir,&platform_out,&target,Some(&overlay),&baked).unwrap();
        let pruned:Value=serde_json::from_slice(&fs::read(platform_out.join("update-build-inputs.json")).unwrap()).unwrap();
        let pruned_policy:Value=serde_json::from_str(pruned["policy"].as_str().unwrap()).unwrap();
        assert_eq!(pruned_policy["allowedCommands"],"{\\"commands\\":[\\"probe\\"]}");
        fs::remove_file(platform_out.join("capabilities.json")).unwrap();
        assert!(update_build_inputs::emit(&dir,&platform_out,&target,Some(&overlay),&baked).is_err());
        for invalid in ["not-json".to_string(),"[]".into()," ".repeat(1024*1024+1)] {
            fs::write(platform_out.join("capabilities.json"),invalid).unwrap();
            assert!(update_build_inputs::emit(&dir,&platform_out,&target,Some(&overlay),&baked).is_err());
        }
        assert!(update_build_inputs::emit(&dir,&out,&target,Some("not-json"),&baked).is_err());
        let mut wrong=baked.clone(); wrong.insert("PAPERCUSP_BUILD_VERSION".into(),"9.9.9".into());
        assert!(update_build_inputs::emit(&dir,&out,&target,Some(&overlay),&wrong).is_err());
        // The generated source must survive optimized linking and symbol stripping.
        let wrapper=out.join("optimized.rs"); let image=out.join(if cfg!(windows) {"optimized.exe"} else {"optimized"});
        fs::write(&wrapper,format!("include!({:?}); fn main() {{ std::hint::black_box(&PAPERCUSP_UPDATE_BUILD_INPUTS); }}",out.join("update-build-inputs.rs"))).unwrap();
        let result=Command::new("rustc").args(["--edition=2021","--crate-name","producer_fixture","-O","-C","lto","-C","strip=symbols"])
            .arg(&wrapper).arg("-o").arg(&image).env("OUT_DIR",&out).output().unwrap();
        assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
        let image=fs::read(image).unwrap(); let parsed=object::File::parse(&image[..]).unwrap();
        let sections:Vec<_>=parsed.sections().filter(|s| matches!(s.name(),Ok(".pcupd"|"__pcupd"))).collect();
        assert_eq!(sections.len(),1); assert_eq!(sections[0].data().unwrap(),&bytes[..]);
        assert!(update_authorization::extract_binary_inputs(&image,input["platform"].as_str().unwrap()).is_err(),
            "missing authenticated author must never qualify as an authorized candidate");
        println!("producer-proof: real Tauri ACLs, OS+CLI overlays, deletion, exact bytes, optimized native section, unattributed refusal");
    }
}
`);
    const triple = spawnSync('rustc', ['-vV'], { encoding: 'utf8', timeout: 30_000 });
    expect(triple.status, String(triple.error || triple.stderr)).toBe(0);
    const host = /^host: (.+)$/m.exec(triple.stdout)?.[1];
    expect(host).toBeTruthy();
    const result = spawnSync('cargo', ['test', '--offline', '--manifest-path', join(root, 'Cargo.toml'),
      'producer_effective_inputs_and_refusals', '--', '--nocapture', '--test-threads=1'], {
      encoding: 'utf8', timeout: 240_000,
      env: { ...process.env, CARGO_TARGET_DIR: join(root, 'target'), PRODUCER_TEST_TARGET: host,
        TAURI_CONFIG: JSON.stringify({ version: '1.2.5', app: {
          security: { csp: null }, windows: [{ label: 'main', title: 'runtime' }],
        } }), GIT_AUTHOR_NAME: 'not-an-authenticated-principal' },
    });
    expect(result.status, String(result.error || result.stderr || result.stdout)).toBe(0);
    expect(result.stdout).toContain('producer-proof: real Tauri ACLs');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 300_000);
