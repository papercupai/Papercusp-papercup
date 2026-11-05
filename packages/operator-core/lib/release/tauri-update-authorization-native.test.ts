import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { encodeTauriUpdateAuthorization, type TauriUpdateAuthorization } from '../../../../libs/generic/tauri-release-kit/src/signature.mjs';

const archiveDependencies = ['fs2="0.4"', 'tar="=0.4.46"', 'flate2="=1.1.9"',
  'plist={version="=1.10.0",features=["enable_unstable_features_that_may_break_with_minor_version_bumps"]}'];

// The results ledger bounds assertion messages from the front. Keep actual Rust
// errors and test failures ahead of Cargo's long dependency-compilation prelude.
function nativeFailure(result: { error?: Error; stderr: string; stdout: string }): string {
  const lines = result.stderr.split('\n');
  const errors = lines.flatMap((line, index) => /^(error(?:\[|:)|thread )|panicked|^assertion/.test(line)
    ? lines.slice(index, index + 10) : []);
  return [result.error?.message, errors.join('\n').slice(0, 8000), result.stdout.slice(-8000), result.stderr.slice(-2000)]
    .filter(Boolean).join('\n');
}

it('keeps native failures ahead of warning locations in bounded diagnostic records', () => {
  const warnings = 'warning: unused function\n   --> source.rs:1:1\n'.repeat(100);
  const panic = "thread 'protected_ancestors' panicked at source.rs:444:13:\nassertion failed: trusted ancestor";
  const diagnostic = nativeFailure({ stderr: `${warnings}${panic}\nerror: test failed`, stdout: '' });
  expect(diagnostic.slice(0, 300)).toContain(panic);
  const compile = nativeFailure({ stderr: `${warnings}error[E0425]: missing value\n --> source.rs:12:3\n  missing`, stdout: '' });
  expect(compile.slice(0, 300)).toContain('error[E0425]: missing value\n --> source.rs:12:3');
});

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
      ...archiveDependencies,
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
    #[cfg(unix)] #[test] fn current_trust_activation_is_serialized_and_floors_survive_failure() {
        use super::update_authorization::activate_test_update;
        use std::fs::{self, File, Permissions};
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let vectors:Vec<Vector> = serde_json::from_str(include_str!(${JSON.stringify(fixtures)})).unwrap();
        let v=&vectors[0]; let i=&v.candidate;
        let candidate=|| Candidate { artifact:i.artifact.as_bytes(), policy:i.policy.as_bytes(),
            configuration:i.configuration.as_bytes(), source_revision:&i.source_revision,
            version:&i.version, product:&i.product, platform:&i.platform, author_ids:&i.author_ids };
        let path=std::path::Path::new(${JSON.stringify(root)}).join("activation");
        if std::env::var_os("PC_NATIVE_ACTIVATION_EXIT").is_some() {
            let directory=File::open(&path).unwrap();
            activate_test_update(&directory,&v.envelope,&candidate(),v.now,
                || -> Result<(),String> { std::process::exit(73) }).unwrap();
            panic!("install exit did not execute");
        }
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, Permissions::from_mode(0o700)).unwrap();
        let directory=File::open(&path).unwrap();
        let policy_path=path.join("managed-policy.json");
        let policy=|| {
            let mut trust=serde_json::to_value(&v.trust).unwrap();
            trust["minRollbackCounter"]=0.into(); trust["minIssuedAt"]=0.into();
            serde_json::json!({"version":1,"update_channel":"stable","updateAuthorization":trust})
        };
        let write=|p:&serde_json::Value| {
            fs::write(&policy_path,serde_json::to_vec(p).unwrap()).unwrap();
            fs::set_permissions(&policy_path,Permissions::from_mode(0o640)).unwrap();
        };
        let read=|| serde_json::from_slice::<serde_json::Value>(&fs::read(&policy_path).unwrap()).unwrap();
        write(&policy());
        let old=fs::metadata(&policy_path).unwrap().ino();
        let effects=AtomicUsize::new(0);
        let (locked_tx,locked_rx)=std::sync::mpsc::channel();
        let (resume_tx,resume_rx)=std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let effects=&effects; let candidate=&candidate; let directory=&directory; let read=&read;
            let first=scope.spawn(move || activate_test_update(directory,&v.envelope,&candidate(),v.now,|| {
                effects.fetch_add(1,Ordering::SeqCst);
                assert_eq!(read()["updateAuthorization"]["minRollbackCounter"],7);
                assert_eq!(read()["updateAuthorization"]["minIssuedAt"],1000);
                locked_tx.send(()).unwrap();
                resume_rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
                Err::<(),_>("simulated installer failure".into())
            }));
            locked_rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
            let competing=activate_test_update(directory,&v.envelope,&candidate(),v.now,
                || -> Result<(),String> { panic!("concurrent install ran") });
            assert!(competing.unwrap_err().contains("busy"));
            resume_tx.send(()).unwrap();
            assert_eq!(first.join().unwrap().unwrap_err(),"simulated installer failure");
        });
        assert_eq!(effects.load(Ordering::SeqCst),1);
        assert_ne!(fs::metadata(&policy_path).unwrap().ino(),old,"policy must replace atomically");
        assert_eq!(fs::metadata(&policy_path).unwrap().mode() & 0o777,0o640);
        let retained=read();
        assert_eq!(retained["update_channel"],"stable");
        assert_eq!(retained["updateAuthorization"]["minRollbackCounter"],7);
        assert_eq!(retained["updateAuthorization"]["minIssuedAt"],1000);
        assert_eq!(retained["updateAuthorization"]["approvers"],policy()["updateAuthorization"]["approvers"]);
        let install=|| { effects.fetch_add(1,Ordering::SeqCst); Ok(()) };
        // Releasing this transaction must unlock even while directory stays open.
        activate_test_update(&directory,&v.envelope,&candidate(),v.now,install).unwrap();
        for (field,value) in [("minRollbackCounter",8),("minIssuedAt",1001)] {
            let mut p=retained.clone(); p["updateAuthorization"][field]=value.into(); write(&p);
            assert!(activate_test_update(&directory,&v.envelope,&candidate(),v.now,install).is_err());
        }
        let mut revoked=retained.clone(); revoked["updateAuthorization"]["signers"][0]["revoked"]=true.into(); write(&revoked);
        assert!(activate_test_update(&directory,&v.envelope,&candidate(),v.now,install).is_err());
        write(&retained);
        let changed=Candidate { artifact:b"tampered", ..candidate() };
        assert!(activate_test_update(&directory,&v.envelope,&changed,v.now,install).is_err());
        assert_eq!(effects.load(Ordering::SeqCst),2,"no refused candidate may reach install");
        assert_eq!(read(),retained,"refusal must preserve trust and floors");
        assert_eq!(fs::read_dir(&path).unwrap().count(),1,"no temporary policy debris");
        // A real process exits during install, after persistence. Its lock must
        // be released and the next process must observe the advanced floors.
        write(&policy());
        let exited=std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact","tests::current_trust_activation_is_serialized_and_floors_survive_failure"])
            .env("PC_NATIVE_ACTIVATION_EXIT","1").output().unwrap();
        assert_eq!(exited.status.code(),Some(73),"{:?}",exited);
        assert_eq!(read()["updateAuthorization"]["minRollbackCounter"],7);
        assert_eq!(read()["updateAuthorization"]["minIssuedAt"],1000);
        activate_test_update(&directory,&v.envelope,&candidate(),v.now,install).unwrap();
        if unsafe { libc::geteuid() } != 0 {
            write(&policy());
            fs::set_permissions(&path,Permissions::from_mode(0o500)).unwrap();
            let refused=activate_test_update(&directory,&v.envelope,&candidate(),v.now,install);
            fs::set_permissions(&path,Permissions::from_mode(0o700)).unwrap();
            assert!(refused.unwrap_err().contains("cannot durably advance"));
            assert_eq!(read()["updateAuthorization"]["minRollbackCounter"],0);
            assert_eq!(effects.load(Ordering::SeqCst),3,"uncommitted floors must prevent install");
        }
        println!("native-activation: serialized install, current revocation and crash-conservative monotonic floors");
    }
}
`);
    const result = spawnSync('cargo', ['test', '--offline', '--manifest-path', join(root, 'Cargo.toml'), '--', '--nocapture'],
      { encoding: 'utf8', timeout: 120_000, env: { ...process.env, CARGO_TARGET_DIR: join(root, 'target') } });
    expect(result.status, nativeFailure(result)).toBe(0);
    expect(result.stdout).toContain('0 failed; 0 ignored');
    if (process.platform !== 'win32') {
      expect(result.stdout).toContain('native-activation: serialized install, current revocation and crash-conservative monotonic floors');
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
      expect(result.status, nativeFailure(result)).toBe(0);
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
      ...archiveDependencies,
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
    expect(result.status, nativeFailure(result)).toBe(0);
    expect(result.stdout).toContain('native-extraction: actual compiled image and exact bytes');
    for (const [name] of variants) expect(result.stdout).toContain(`native-extraction-refused: ${JSON.stringify(name)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 240_000);

it('selects universal Mach-O and Mac archive inputs by installed executable identity with bounded paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'tauri-update-universal-'));
  try {
    const source = resolve(__dirname, '../../../../papercusp-desktop/src-tauri/src/update_authorization.rs');
    // Sign canonical metadata from the Rust archive fixture with real independent keys.
    const signer = join(root, 'sign.cjs');
    writeFileSync(signer, `
const {createHash,generateKeyPairSync,sign}=require('node:crypto');
const payload=require('node:fs').readFileSync(0,'utf8');
function key(id,principalId) {
  const pair=generateKeyPairSync('ed25519'), keyId=createHash('sha256').update(id).digest().subarray(0,8);
  const raw=pair.publicKey.export({format:'der',type:'spki'}).subarray(-32);
  return { trusted:{id,epoch:2,principalId,revoked:false,
    publicKey:Buffer.concat([Buffer.from('Ed'),keyId,raw]).toString('base64')},
    sign(){const signature=sign(null,createHash('blake2b512').update(payload).digest(),pair.privateKey);
      const comment='timestamp:2 file:update-authorization';
      const global=sign(null,Buffer.concat([signature,Buffer.from(comment)]),pair.privateKey).toString('base64');
      return Buffer.from(['untrusted comment: update',Buffer.concat([Buffer.from('ED'),keyId,signature]).toString('base64'),
        'trusted comment: '+comment,global,''].join('\\n')).toString('base64');}};
}
const signer=key('release','release-principal'), reviewer=key('reviewer','reviewer-principal');
process.stdout.write(JSON.stringify({trust:{rootEpoch:3,minRollbackCounter:0,minIssuedAt:0,maxMetadataAgeMs:1500,
  signers:[signer.trusted],approvers:[reviewer.trusted]},
  manifest:{updateAuthorization:{payload,signature:signer.sign(),approvalSignature:reviewer.sign()}}}));
`);
    writeFileSync(join(root, 'Cargo.toml'), [
      '[package]', 'name="update-universal-native-regression"', 'version="0.0.0"', 'edition="2021"',
      '[workspace]', '[lib]', 'path="driver.rs"', '[dependencies]',
      'base64="=0.22.1"', 'minisign-verify="=0.2.5"', 'sha2="=0.10.9"',
      'serde={version="1",features=["derive"]}', 'serde_json="1"', 'libc="0.2"',
      'object={version="=0.37.3",default-features=false,features=["read","write","std"]}',
      ...archiveDependencies,
    ].join('\n'));
    writeFileSync(join(root, 'driver.rs'), `
#[path = ${JSON.stringify(source)}] mod update_authorization;
#[cfg(test)] mod tests {
    use super::update_authorization::{extract_binary_inputs, extract_macos_archive_inputs};
    use object::{macho, Architecture, BinaryFormat, Endianness, SectionKind};
    use object::write::Object;
    use sha2::{Digest, Sha256};
    fn thin(arch:Architecture, platform:&str, field:&str, value:serde_json::Value)->Vec<u8> {
        let mut inputs=serde_json::json!({"schema":"tauri-update-inputs-v2",
            "policy":"{\\"target\\":\\"local\\"}","configuration":"{}",
            "sourceRevision":"d".repeat(40),"version":"1.2.3","product":"gui",
            "platform":platform,"authorIds":["author","coauthor"]});
        inputs[field]=value;
        // Match the producer's canonical struct order, not a JSON map's order.
        let ordered=format!("{{\\"schema\\":{},\\"policy\\":{},\\"configuration\\":{},\\"sourceRevision\\":{},\\"version\\":{},\\"product\\":{},\\"platform\\":{},\\"authorIds\\":{}}}",
            inputs["schema"],inputs["policy"],inputs["configuration"],inputs["sourceRevision"],
            inputs["version"],inputs["product"],inputs["platform"],inputs["authorIds"]);
        let mut object=Object::new(BinaryFormat::MachO,arch,Endianness::Little);
        let section=object.add_section(b"__DATA".to_vec(),b"__pcupd".to_vec(),SectionKind::ReadOnlyData);
        object.append_section_data(section,ordered.as_bytes(),1);
        let mut bytes=object.write().unwrap();
        // The writer emits MH_OBJECT. This is a parser fixture marked
        // MH_EXECUTE, never an executed or signed Mac product.
        bytes[12..16].copy_from_slice(&macho::MH_EXECUTE.to_le_bytes());
        bytes
    }
    fn image(arch:Architecture, platform:&str)->Vec<u8> { thin(arch,platform,"product","gui".into()) }
    fn fat(slices:&[(u32,u32,Vec<u8>)],wide:bool)->Vec<u8> {
        let width=if wide {32}else{20};
        let mut out=vec![0u8;8+width*slices.len()];
        out[..4].copy_from_slice(&(if wide {macho::FAT_MAGIC_64}else{macho::FAT_MAGIC}).to_be_bytes());
        out[4..8].copy_from_slice(&(slices.len() as u32).to_be_bytes());
        for (i,(cpu,subtype,bytes)) in slices.iter().enumerate() {
            let offset=(out.len()+7)&!7;
            out.resize(offset,0);
            out.extend_from_slice(bytes);
            let p=8+i*width;
            out[p..p+4].copy_from_slice(&cpu.to_be_bytes());
            out[p+4..p+8].copy_from_slice(&subtype.to_be_bytes());
            if wide {
                out[p+8..p+16].copy_from_slice(&(offset as u64).to_be_bytes());
                out[p+16..p+24].copy_from_slice(&(bytes.len() as u64).to_be_bytes());
                out[p+24..p+28].copy_from_slice(&3u32.to_be_bytes());
            } else {
                out[p+8..p+12].copy_from_slice(&(offset as u32).to_be_bytes());
                out[p+12..p+16].copy_from_slice(&(bytes.len() as u32).to_be_bytes());
                out[p+16..p+20].copy_from_slice(&3u32.to_be_bytes());
            }
        }
        out
    }
    #[test] fn candidate_universal_target_and_all_slice_identity() {
        let x=(macho::CPU_TYPE_X86_64,macho::CPU_SUBTYPE_X86_64_ALL,image(Architecture::X86_64,"darwin-x86_64"));
        let a=(macho::CPU_TYPE_ARM64,macho::CPU_SUBTYPE_ARM64_ALL,image(Architecture::Aarch64,"darwin-aarch64"));
        for wide in [false,true] {
            let bytes=fat(&[x.clone(),a.clone()],wide);
            for platform in ["darwin-x86_64","darwin-aarch64"] {
                let inputs=extract_binary_inputs(&bytes,platform).unwrap();
                let c=inputs.candidate(&bytes);
                assert_eq!(c.platform,platform);
                assert_eq!(c.author_ids,["author","coauthor"]);
                assert_eq!(Sha256::digest(c.artifact),Sha256::digest(&bytes));
            }
            for platform in ["linux-x86_64","windows-x86_64","darwin-universal","unknown"] {
                assert!(extract_binary_inputs(&bytes,platform).is_err());
            }
            let refuse=|parts:Vec<(u32,u32,Vec<u8>)>| {
                assert!(extract_binary_inputs(&fat(&parts,wide),"darwin-x86_64").is_err());
            };
            refuse(vec![]);
            refuse(vec![a.clone()]);
            refuse(vec![x.clone(),x.clone()]);
            refuse(vec![x.clone(),a.clone(),a.clone()]);
            refuse(vec![x.clone(),(123,0,a.2.clone())]);
            refuse(vec![x.clone(),(a.0,1,a.2.clone())]);
            refuse(vec![x.clone(),(a.0,a.1,x.2.clone())]);
            refuse(vec![x.clone(),(a.0,a.1,bytes.clone())]);
            for (field,value) in [("sourceRevision","e".repeat(40).into()),("product","other".into()),
                ("version","2.0.0".into()),("authorIds",serde_json::json!(["author"]))] {
                refuse(vec![x.clone(),(a.0,a.1,thin(Architecture::Aarch64,"darwin-aarch64",field,value))]);
            }
            let different_policy=thin(Architecture::Aarch64,"darwin-aarch64","policy","{\\"target\\":\\"arm\\"}".into());
            assert!(extract_binary_inputs(&fat(&[x.clone(),(a.0,a.1,different_policy)],wide),"darwin-x86_64").is_ok());
            for (position,encoded) in if wide {
                vec![(16,0u64.to_be_bytes().to_vec()),(16,u64::MAX.to_be_bytes().to_vec()),
                    (24,u64::MAX.to_be_bytes().to_vec()),(32,64u32.to_be_bytes().to_vec()),
                    (32,30u32.to_be_bytes().to_vec()),(48,bytes[16..24].to_vec())]
            } else {
                vec![(16,0u32.to_be_bytes().to_vec()),(16,u32::MAX.to_be_bytes().to_vec()),
                    (20,u32::MAX.to_be_bytes().to_vec()),(24,64u32.to_be_bytes().to_vec()),
                    (24,30u32.to_be_bytes().to_vec()),(36,bytes[16..20].to_vec())]
            } {
                let mut bad=bytes.clone(); bad[position..position+encoded.len()].copy_from_slice(&encoded);
                assert!(extract_binary_inputs(&bad,"darwin-x86_64").is_err(),"invalid range at {}",position);
            }
            for n in [0,4,7,8,bytes.len()-1] {
                assert!(extract_binary_inputs(&bytes[..n],"darwin-x86_64").is_err());
            }
        }
        println!("native-universal: both table widths, both targets, full artifact and all-slice refusal");
    }

    fn bundle_info(executable:&str, identifier:&str, version:&str, binary:bool)->Vec<u8> {
        let mut dict=plist::Dictionary::new();
        dict.insert("CFBundleExecutable".into(),executable.into());
        dict.insert("CFBundleIdentifier".into(),identifier.into());
        dict.insert("CFBundleShortVersionString".into(),version.into());
        dict.insert("UnrelatedAppSetting".into(),true.into());
        let mut bytes=Vec::new();
        if binary { plist::Value::Dictionary(dict).to_writer_binary(&mut bytes).unwrap(); }
        else { plist::Value::Dictionary(dict).to_writer_xml(&mut bytes).unwrap(); }
        bytes
    }
    fn gzip(bytes:&[u8])->Vec<u8> {
        use std::io::Write;
        let mut encoder=flate2::write::GzEncoder::new(Vec::new(),flate2::Compression::fast());
        encoder.write_all(bytes).unwrap(); encoder.finish().unwrap()
    }
    // Raw headers permit deliberately hostile paths that tar::Builder's normal
    // append_data rejects. Nothing from these parser fixtures is unpacked/run.
    fn archive(entries:Vec<(&str,u8,u32,Vec<u8>,&str)>)->Vec<u8> {
        let mut builder=tar::Builder::new(Vec::new());
        for (path,kind,mode,bytes,link) in entries {
            let mut h=tar::Header::new_gnu();
            h.set_entry_type(tar::EntryType::new(kind)); h.set_mode(mode); h.set_size(bytes.len() as u64);
            if !link.is_empty() { h.set_link_name(link).unwrap(); }
            if path.len() <= 100 {
                h.as_mut_bytes()[..100].fill(0);
                h.as_mut_bytes()[..path.len()].copy_from_slice(path.as_bytes()); h.set_cksum();
                builder.append(&h,bytes.as_slice()).unwrap();
            } else { builder.append_data(&mut h,path,bytes.as_slice()).unwrap(); }
        }
        gzip(&builder.into_inner().unwrap())
    }
    fn bundle(main:Vec<u8>, info:Vec<u8>, mut extra:Vec<(&str,u8,u32,Vec<u8>,&str)>)->Vec<u8> {
        let mut entries=vec![("GUI.app/Contents/MacOS/Main",b'0',0o755,main,""),
            ("GUI.app/Contents/Info.plist",b'0',0o644,info,"")];
        entries.append(&mut extra); archive(entries)
    }
    fn x86()->Vec<u8> { image(Architecture::X86_64,"darwin-x86_64") }
    #[test] fn candidate_mac_bundle_main_and_archive_binding() {
        let a=image(Architecture::Aarch64,"darwin-aarch64");
        let universal=fat(&[(macho::CPU_TYPE_X86_64,macho::CPU_SUBTYPE_X86_64_ALL,x86()),
            (macho::CPU_TYPE_ARM64,macho::CPU_SUBTYPE_ARM64_ALL,a)],false);
        let long_path=format!("GUI.app/Contents/Resources/{}/asset.txt","r".repeat(120));
        for binary_plist in [false,true] {
            let bytes=bundle(universal.clone(),bundle_info("Main","gui","1.2.3",binary_plist),vec![
                // A reviewed-looking decoy is never selected by marker scanning.
                ("GUI.app/Contents/MacOS/Decoy",b'0',0o755,thin(Architecture::X86_64,"darwin-x86_64","product","decoy".into()),""),
                (&long_path,b'0',0o644,b"long resource".to_vec(),""),
                ("GUI.app/Contents/Frameworks/F/Versions/Current",b'2',0o777,vec![],"A"),
                ("GUI.app/Contents/Frameworks/F/F",b'2',0o777,vec![],"Versions/Current/F")]);
            for platform in ["darwin-x86_64","darwin-aarch64"] {
                let inputs=extract_macos_archive_inputs(&bytes,platform).unwrap();
                let c=inputs.candidate(&bytes);
                assert_eq!(c.product,"gui"); assert_eq!(c.version,"1.2.3");
                assert_eq!(c.platform,platform); assert_eq!(c.author_ids,["author","coauthor"]);
                assert_eq!(Sha256::digest(c.artifact),Sha256::digest(&bytes));
                assert_ne!(Sha256::digest(c.artifact),Sha256::digest(&universal));
            }
        }
        // Executable before/after plist and omitted/explicit directories behave
        // like updater's one-component stripping, not a search for an app name.
        let bytes=archive(vec![("Other Name.app",b'5',0o755,vec![],""),
            ("Other Name.app/Contents/Info.plist",b'0',0o644,bundle_info("Main","gui","1.2.3",false),""),
            ("Other Name.app/Contents",b'5',0o755,vec![],""),
            ("Other Name.app/Contents/MacOS/Main",b'0',0o755,x86(),"")]);
        assert!(extract_macos_archive_inputs(&bytes,"darwin-x86_64").is_ok());
        println!("native-mac-archive: XML/binary plist, GNU long path, thin/universal, full archive binding");
    }
    #[cfg(unix)] #[test] fn candidate_mac_activation_uses_downloaded_bytes_and_current_policy() {
        use super::update_authorization::{activate_test_macos_update, DownloadedUpdate, Metadata};
        use super::update_authorization::macos_update_installer::{Request, install_test, serve, transact};
        use std::fs::{self,File,Permissions};
        use std::os::unix::fs::PermissionsExt;
        use std::io::Write;
        use std::process::{Command,Stdio};
        use std::cell::Cell;
        let product="com.papercusp.gui";
        let main=thin(Architecture::X86_64,"darwin-x86_64","product",product.into());
        let bytes=bundle(main.clone(),bundle_info("Main",product,"1.2.3",false),vec![]);
        let inputs=extract_macos_archive_inputs(&bytes,"darwin-x86_64").unwrap();
        let c=inputs.candidate(&bytes);
        let digest=|s:&[u8]|format!("{:x}",Sha256::digest(s));
        let metadata=Metadata {schema:"tauri-update-authorization-v2".into(),artifact_sha256:digest(c.artifact),
            policy_sha256:digest(c.policy),configuration_sha256:digest(c.configuration),
            source_revision:c.source_revision.into(),version:c.version.into(),product:c.product.into(),
            platform:c.platform.into(),author_ids:c.author_ids.to_vec(),approver_id:"reviewer".into(),approver_epoch:2,
            signer_id:"release".into(),signer_epoch:2,root_epoch:3,rollback_counter:7,issued_at:1000,expires_at:3000};
        let mut child=Command::new(${JSON.stringify(process.execPath)}).arg(${JSON.stringify(signer)})
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(serde_json::to_string(&metadata).unwrap().as_bytes()).unwrap();
        let signed=child.wait_with_output().unwrap();
        assert!(signed.status.success(),"{:?}",signed);
        let signed:serde_json::Value=serde_json::from_slice(&signed.stdout).unwrap();
        let path=std::path::Path::new(${JSON.stringify(root)}).join("mac-activation");
        fs::create_dir(&path).unwrap(); fs::set_permissions(&path,Permissions::from_mode(0o700)).unwrap();
        let directory=File::open(&path).unwrap(); let policy_path=path.join("managed-policy.json");
        let policy=serde_json::json!({"version":1,"update_channel":"stable","updateAuthorization":signed["trust"]});
        let write=|p:&serde_json::Value| {fs::write(&policy_path,serde_json::to_vec(p).unwrap()).unwrap();
            fs::set_permissions(&policy_path,Permissions::from_mode(0o600)).unwrap();};
        let read=||serde_json::from_slice::<serde_json::Value>(&fs::read(&policy_path).unwrap()).unwrap();
        let download=DownloadedUpdate {artifact:&bytes,manifest:&signed["manifest"],version:"1.2.3",product,platform:"darwin-x86_64"};
        let effects=Cell::new(0);
        let install=|| {assert_eq!(read()["updateAuthorization"]["minRollbackCounter"],7);
            assert_eq!(read()["updateAuthorization"]["minIssuedAt"],1000);
            effects.set(effects.get()+1); Ok(())};
        write(&policy);
        activate_test_macos_update(&directory,&download,2000,install).unwrap();
        assert_eq!(effects.get(),1);
        let retained=read();
        let refuses=|d:&DownloadedUpdate<'_>| {
            assert!(activate_test_macos_update(&directory,d,2000,install).is_err());
            assert_eq!(effects.get(),1,"refusal must leave teardown/install untouched");
        };
        for manifest in [serde_json::json!({}),serde_json::json!({"updateAuthorization":null}),{
            let mut m=signed["manifest"].clone(); m["updateAuthorization"]["ignored"]=true.into(); m
        },{
            let mut m=signed["manifest"].clone(); m["updateAuthorization"]["approvalSignature"]="tampered".into(); m
        }] {refuses(&DownloadedUpdate {manifest:&manifest,..download});}
        refuses(&DownloadedUpdate {version:"9.0.0",..download});
        refuses(&DownloadedUpdate {product:"server",..download});
        refuses(&DownloadedUpdate {platform:"darwin-aarch64",..download});
        let mut tampered=bytes.clone(); tampered.push(1);
        refuses(&DownloadedUpdate {artifact:&tampered,..download});
        for p in [{let mut p=retained.clone();p["updateAuthorization"]["signers"][0]["revoked"]=true.into();p},
            {let mut p=retained.clone();p["updateAuthorization"]["minRollbackCounter"]=8.into();p},
            {let mut p=retained.clone();p["updateAuthorization"]["minIssuedAt"]=1001.into();p}] {
            write(&p); refuses(&download); assert_eq!(read(),p);
        }
        write(&retained);
        assert!(activate_test_macos_update(&directory,&download,3000,install).is_err());
        assert_eq!(effects.get(),1);
        fs::set_permissions(&policy_path,Permissions::from_mode(0o666)).unwrap(); refuses(&download);
        write(&policy);
        if unsafe {libc::geteuid()} != 0 {
            fs::set_permissions(&path,Permissions::from_mode(0o500)).unwrap(); refuses(&download);
            fs::set_permissions(&path,Permissions::from_mode(0o700)).unwrap();
            assert_eq!(read(),policy,"persistence refusal must preserve the original policy");
        }
        let failed=activate_test_macos_update(&directory,&download,2000,|| {
            install()?; Err::<(),_>("installer failed".to_string())});
        assert_eq!(failed.unwrap_err(),"installer failed");
        assert_eq!(read(),retained,"failed install retains floors");
        assert_eq!(effects.get(),2);

        // Exercise the real installer core against protected native directories.
        // Linux exchange semantics are local development proof, not signed Mac proof.
        let apps=path.join("Applications"); fs::create_dir(&apps).unwrap();
        fs::set_permissions(&apps,Permissions::from_mode(0o700)).unwrap();
        let target=apps.join("Papercusp GUI.app"); fs::create_dir(&target).unwrap();
        fs::set_permissions(&target,Permissions::from_mode(0o755)).unwrap();
        fs::write(target.join("old-product"),b"old").unwrap();
        let outside=path.join("outside"); fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep"),b"untouched").unwrap();
        std::os::unix::fs::symlink(&outside,target.join("external-link")).unwrap();
        let applications=File::open(&apps).unwrap();
        let ready_count=Cell::new(0);
        let request=||Request::capture(&download).unwrap();
        let receive=|request:Request| {
            let mut wire=Vec::new();request.send(&mut wire).unwrap();
            Request::receive(wire.as_slice()).unwrap()
        };
        let no_ready=|| {ready_count.set(ready_count.get()+1);Ok(())};
        let captured=receive(request());
        let mut revoked=policy.clone();revoked["updateAuthorization"]["signers"][0]["revoked"]=true.into();
        write(&revoked);
        assert!(install_test(&directory,&applications,captured,2000,no_ready).is_err());
        assert_eq!(ready_count.get(),0);assert!(target.join("old-product").exists());
        let mut wire=Vec::new();request().send(&mut wire).unwrap();
        for n in [0,11,12,wire.len()-1] {assert!(Request::receive(&wire[..n]).is_err());}
        let mut trailing=wire.clone();trailing.push(0);assert!(Request::receive(trailing.as_slice()).is_err());
        let mut huge=wire.clone();huge[..4].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(Request::receive(huge.as_slice()).is_err());
        assert!(Request::capture(&DownloadedUpdate {product:"../../outside",..download}).is_err());
        write(&policy);
        fs::rename(&target,apps.join("saved.app")).unwrap();
        std::os::unix::fs::symlink(&outside,&target).unwrap();
        assert!(install_test(&directory,&applications,request(),2000,no_ready).is_err());
        fs::remove_file(&target).unwrap();fs::rename(apps.join("saved.app"),&target).unwrap();
        assert_eq!(read(),policy);assert_eq!(ready_count.get(),0);
        fs::set_permissions(&apps,Permissions::from_mode(0o770)).unwrap();
        assert!(install_test(&directory,&applications,request(),2000,no_ready).is_err());
        fs::set_permissions(&apps,Permissions::from_mode(0o700)).unwrap();
        assert_eq!(read(),policy);assert_eq!(ready_count.get(),0);
        let cancelled=install_test(&directory,&applications,receive(request()),2000,||Err("cancelled".into()));
        assert_eq!(cancelled.unwrap_err(),"cancelled","must reach READY before exercising cancellation");
        assert_eq!(read(),retained);assert!(target.join("old-product").exists());
        assert_eq!(fs::read(outside.join("keep")).unwrap(),b"untouched");
        assert_eq!(fs::read_dir(&apps).unwrap().count(),1,"cancel cleans only its private stage");
        let mut sender=bytes.clone();
        let owned=Request::capture(&DownloadedUpdate {artifact:&sender,..download}).unwrap();
        sender.fill(0);
        install_test(&directory,&applications,receive(owned),2000,|| {
            ready_count.set(ready_count.get()+1);
            assert_eq!(read(),retained);assert!(target.join("old-product").exists());
            assert!(activate_test_macos_update(&directory,&download,2000,|| -> Result<(),String> {panic!("lock bypass")}).is_err());
            Ok(())
        }).unwrap();
        assert_eq!(ready_count.get(),1);
        assert_eq!(fs::read(target.join("Contents/MacOS/Main")).unwrap(),main);
        assert!(!target.join("old-product").exists());
        assert!(!target.join("external-link").exists());
        assert_eq!(fs::read(outside.join("keep")).unwrap(),b"untouched");
        assert_eq!(fs::read_dir(&apps).unwrap().count(),1,"completed swap removes the previous private tree");
        assert_eq!(read(),retained);
        // Exercise the actual duplex protocol and filesystem effect together.
        // The two threads have separate pipe ends, as do the GUI and root helper.
        use std::os::unix::net::UnixStream;
        use std::time::Duration;
        for scenario in ["commit","cancel","revoked","disconnect","invalid-commit"] {
            fs::write(target.join("before-handshake"),b"old").unwrap();
            let captured=request();
            if scenario=="revoked" { write(&revoked); } else { write(&policy); }
            let (mut client,mut helper)=UnixStream::pair().unwrap();
            for stream in [&client,&helper] {
                stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                stream.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
            }
            std::thread::scope(|scope| {
                let server=scope.spawn(|| serve(&mut helper,|request,ready|
                    install_test(&directory,&applications,request,2000,ready)));
                if scenario=="disconnect" || scenario=="invalid-commit" {
                    use std::io::Read;
                    captured.send(&mut client).unwrap();client.write_all(b"PCREQ01\\n").unwrap();
                    let mut ready=[0;8];client.read_exact(&mut ready).unwrap();
                    assert_eq!(&ready,b"PCRDY01\\n");assert_eq!(read(),retained);
                    assert!(target.join("before-handshake").exists());
                    if scenario=="invalid-commit" { client.write_all(b"INVALID\\n").unwrap(); }
                    else {client.shutdown(std::net::Shutdown::Both).unwrap();}
                    assert!(server.join().unwrap().is_err());
                } else {
                    let outcome=transact(&mut client,captured,|| {
                        assert_ne!(scenario,"revoked","revoked CURRENT trust must refuse before teardown");
                        assert_eq!(read(),retained);assert!(target.join("before-handshake").exists());
                        assert!(activate_test_macos_update(&directory,&download,2000,|| -> Result<(),String> {panic!("lock bypass")}).is_err());
                        if scenario=="cancel" {Err("GUI cancelled".into())} else {Ok(())}
                    });
                    let server_outcome=server.join().unwrap();
                    if scenario=="commit" {outcome.unwrap();server_outcome.unwrap();}
                    else {assert!(outcome.is_err());assert!(server_outcome.is_err());}
                }
            });
            assert_eq!(target.join("before-handshake").exists(),scenario!="commit");
            assert_eq!(fs::read(target.join("Contents/MacOS/Main")).unwrap(),main);
            assert_eq!(fs::read(outside.join("keep")).unwrap(),b"untouched");
            assert_eq!(fs::read_dir(&apps).unwrap().count(),1,"no abandoned staging tree");
            if scenario=="revoked" {assert_eq!(read(),revoked);}else{assert_eq!(read(),retained);}
            write(&retained);
            // A failed/disconnected helper released the lock, so retry is possible.
            activate_test_macos_update(&directory,&download,2000,||Ok(())).unwrap();
        }
        println!("native-mac-handshake: actual duplex READY before quiescence, COMMIT effect, cancellation, current revocation, disconnect and invalid commit with lock release");
        println!("native-mac-installer: owned framed bytes, fixed destination, current revocation, symlink/writable-directory refusal, READY cancellation, lock through exchange, exact installed bytes and external canary");
        println!("native-mac-activation: real dual signatures, selected identity, current policy and no-effect refusals");
    }
    #[test] fn candidate_mac_bundle_refuses_identity_and_namespace_ambiguity() {
        let good=bundle_info("Main","gui","1.2.3",false);
        let xml=String::from_utf8(good.clone()).unwrap();
        // These otherwise valid plists preserve every required identity field.
        // Without the duplicate/depth/event guards each would be accepted.
        let duplicate=xml.replace("</dict>","<key>CFBundleExecutable</key><string>Main</string></dict>").into_bytes();
        let deep=xml.replace("</dict>",&format!("<key>Ignored</key>{}<string>x</string>{}</dict>",
            "<array>".repeat(40),"</array>".repeat(40))).into_bytes();
        let mut amplified=plist::Value::from_reader(std::io::Cursor::new(&good)).unwrap();
        amplified.as_dictionary_mut().unwrap().insert("Ignored".into(),
            plist::Value::Array(vec![plist::Value::Boolean(true);16_384]));
        let mut many_events=Vec::new(); amplified.to_writer_binary(&mut many_events).unwrap();
        assert!(many_events.len() <= 65_536);
        let refuses=|bytes:Vec<u8>| assert!(extract_macos_archive_inputs(&bytes,"darwin-x86_64").is_err());
        for info in [bundle_info("Missing","gui","1.2.3",false),bundle_info("Main","other","1.2.3",true),
            bundle_info("Main","gui","2.0.0",false),bundle_info("../Main","gui","1.2.3",false),
            bundle_info("/Main","gui","1.2.3",false),b"invalid plist".to_vec(),
            duplicate, deep, many_events,
            vec![b'x';65_537]] { refuses(bundle(x86(),info,vec![])); }
        for path in ["Other.app/Contents/extra","GUI.app/Contents/MacOS/main","GUI.app/contents/resource",
            "GUI.app/Contents/Info.plist","GUI.app/Contents/MacOS/Main/child","GUI.app/Contents/MacOS",
            "GUI.app/../escape","/GUI.app/escape","GUI.app//escape","GUI.app/./escape",
            "GUI.app/Contents/Resources/café","GUI.app/Contents/a:b","GUI.app/Contents/a\\\\b"] {
            refuses(bundle(x86(),good.clone(),vec![(path,b'0',0o644,vec![],"")]));
        }
        for (path,kind,mode,link) in [("GUI.app/Contents/MacOS",b'2',0o777,"Other"),
            ("GUI.app/Contents/Info.plist",b'2',0o777,"Other"),
            ("GUI.app/Contents/link",b'2',0o777,"../../outside"),
            ("GUI.app/Contents/link",b'2',0o777,"/outside"),
            ("GUI.app/Contents/hard",b'1',0o644,"GUI.app/Contents/MacOS/Main"),
            ("GUI.app/Contents/device",b'3',0o644,""),("GUI.app/Contents/fifo",b'6',0o644,""),
            ("GUI.app/Contents/sparse",b'S',0o644,""),("GUI.app/Contents/pax",b'x',0o644,""),
            ("GUI.app/Contents/global",b'g',0o644,""),("GUI.app/Contents/setuid",b'0',0o4755,"")] {
            refuses(bundle(x86(),good.clone(),vec![(path,kind,mode,vec![],link)]));
        }
        for kind in [b'0',b'2'] {
            refuses(archive(vec![("GUI.app/Contents/Info.plist",b'0',0o644,good.clone(),""),
                ("GUI.app/Contents/MacOS/Main",kind,0o644,if kind==b'0' {x86()}else{vec![]},"Decoy")]));
        }
        refuses(archive(vec![("GUI.app/Contents/Info.plist",b'2',0o777,vec![],"Other.plist"),
            ("GUI.app/Contents/Other.plist",b'0',0o644,good.clone(),""),
            ("GUI.app/Contents/MacOS/Main",b'0',0o755,x86(),"")]));
        // A symlink ancestor before its child also refuses (opposite tar order).
        refuses(archive(vec![("GUI.app/Contents/MacOS",b'2',0o777,vec![],"Other"),
            ("GUI.app/Contents/MacOS/Main",b'0',0o755,x86(),""),
            ("GUI.app/Contents/Info.plist",b'0',0o644,good.clone(),"")]));
        let empty_authors=thin(Architecture::X86_64,"darwin-x86_64","authorIds",serde_json::json!([]));
        refuses(bundle(empty_authors,good.clone(),vec![]));
        let bytes=bundle(x86(),good,vec![]);
        for platform in ["linux-x86_64","windows-x86_64","darwin-universal"] {
            assert!(extract_macos_archive_inputs(&bytes,platform).is_err());
        }
        println!("native-mac-refusal: plist identity, aliases, traversal, links, types and unattributed inputs");
    }
    #[test] fn candidate_mac_archive_bounds_and_gzip_integrity() {
        use std::io::Read;
        let good=bundle(x86(),bundle_info("Main","gui","1.2.3",false),vec![]);
        let refuses=|bytes:Vec<u8>| assert!(extract_macos_archive_inputs(&bytes,"darwin-x86_64").is_err());
        for n in [0,1,10,good.len()-1,good.len()-8] { refuses(good[..n].to_vec()); }
        let mut bad=good.clone(); let n=bad.len(); bad[n-8]^=1; refuses(bad);
        let mut appended=good.clone(); appended.extend(&good); refuses(appended);
        let mut appended=good.clone(); appended.push(0); refuses(appended);
        let mut raw=Vec::new(); flate2::read::GzDecoder::new(good.as_slice()).read_to_end(&mut raw).unwrap();
        let mut h=tar::Header::new_gnu(); h.set_path("GUI.app/Contents/huge").unwrap();
        h.set_mode(0o644); h.set_size(512*1024*1024+1); h.set_cksum();
        raw[..512].copy_from_slice(h.as_bytes()); refuses(gzip(&raw));
        let mut h=tar::Header::new_gnu(); h.set_path("././@LongLink").unwrap();
        h.set_mode(0o644); h.set_entry_type(tar::EntryType::GNULongName); h.set_size(4097); h.set_cksum();
        raw[..512].copy_from_slice(h.as_bytes()); refuses(gzip(&raw));
        let mut builder=tar::Builder::new(Vec::new());
        for i in 0..65_537 {
            let mut h=tar::Header::new_gnu(); h.set_size(0); h.set_mode(0o644);
            builder.append_data(&mut h,format!("GUI.app/Contents/Resources/{i}"),&[][..]).unwrap();
        }
        refuses(gzip(&builder.into_inner().unwrap()));
        println!("native-mac-bounds: entry/metadata size, count, truncation, CRC and trailing members");
    }
}
`);
    const result = spawnSync('cargo', ['test', '--offline', '--manifest-path', join(root, 'Cargo.toml'), 'candidate_', '--', '--nocapture'],
      { encoding: 'utf8', timeout: 120_000, env: { ...process.env, CARGO_TARGET_DIR: join(root, 'target') } });
    expect(result.status, nativeFailure(result)).toBe(0);
    expect(result.stdout).toContain('native-universal: both table widths, both targets, full artifact and all-slice refusal');
    expect(result.stdout).toContain('native-mac-archive: XML/binary plist, GNU long path, thin/universal, full archive binding');
    expect(result.stdout).toContain('native-mac-refusal: plist identity, aliases, traversal, links, types and unattributed inputs');
    expect(result.stdout).toContain('native-mac-bounds: entry/metadata size, count, truncation, CRC and trailing members');
    expect(result.stdout).toContain('native-mac-inflation: bound includes padding after tar end');
    if (process.platform !== 'win32') expect(result.stdout).toContain('native-mac-activation: real dual signatures, selected identity, current policy and no-effect refusals');
    if (process.platform !== 'win32') {
      expect(result.stdout).toContain('native-mac-handshake: actual duplex READY before quiescence');
      expect(result.stdout).toContain('native-mac-helper: fixed protected executable and bounded stalled pipe');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);

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
      ...archiveDependencies,
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
    expect(triple.status, nativeFailure(triple)).toBe(0);
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
    expect(result.status, nativeFailure(result)).toBe(0);
    expect(result.stdout).toContain('producer-proof: real Tauri ACLs');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 300_000);
