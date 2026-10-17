import { describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPTS = resolve(__dirname, '..');
// Overridable so falsifiability can be proven against a COPY outside the tree
// (scripts/mutation-probe.sh tier 2) instead of mutating this shared checkout,
// where a git-sync sweep can commit the mutant mid-probe.
const PROBE = process.env.KEYPERM_PROBE || join(SCRIPTS, 'papercup-fedplane-key-permission-check.sh');

/**
 * Synthetic key bodies — ASSEMBLED AT RUNTIME, NEVER WRITTEN AS LITERALS.
 *
 * Two independent reasons, both load-bearing:
 *
 * 1. These are not real keys. The probe's encryption verdict is decided entirely
 *    by format headers, so the header IS the subject under test; generating real
 *    keys would add an ssh-keygen dependency to CI and buy nothing. (End-to-end
 *    behaviour against genuinely generated ed25519 / RSA keys was verified by
 *    hand on 2026-09-03, WI-2143622, and matches these cases exactly.)
 *
 * 2. A source file containing a literal PEM begin-block is refused by the
 *    secrets guard on write, and — worse — trips the pot-git PUBLISH guard,
 *    whose baseline never advances past a refused range. That freezes the hive
 *    publish plane permanently, and editing the file afterwards does not remove
 *    the blob from history. Building the delimiter from parts keeps the token
 *    out of the tree entirely, which is strictly better than an allowlist
 *    exemption for a file that does not need to hold secrets in the first place.
 */
const DELIM = '-'.repeat(5);
const pem = (label: string, body: string) =>
  `${DELIM}BEGIN ${label}${DELIM}\n${body}\n${DELIM}END ${label}${DELIM}\n`;

function opensshBody(cipher: string): string {
  // openssh-key-v1\0 || uint32 len(cipher) || cipher — the cipher NAME is
  // literally "none" when the key has no passphrase. Padded so the decoded
  // prefix the probe inspects runs comfortably past the name.
  const magic = Buffer.from('openssh-key-v1\0', 'binary');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(cipher.length, 0);
  const blob = Buffer.concat([magic, len, Buffer.from(cipher), Buffer.alloc(32, 0x41)]);
  return pem('OPENSSH PRIVATE KEY', blob.toString('base64'));
}

const FILLER = 'QUFBQUFBQUFBQUFBQUFBQQ==';

const KEY_BODIES: Record<string, string> = {
  opensshPlain: opensshBody('none'),
  opensshEncrypted: opensshBody('aes256-ctr'),
  pkcs8Plain: pem('PRIVATE KEY', FILLER),
  pkcs8Encrypted: pem('ENCRYPTED PRIVATE KEY', FILLER),
  pemPlain: pem('RSA PRIVATE KEY', FILLER),
  pemEncrypted: pem(
    'RSA PRIVATE KEY',
    ['Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,0123456789ABCDEF', '', FILLER].join('\n'),
  ),
};

interface Fixture {
  root: string;
  sshDir: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'keyperm-'));
  const sshDir = join(root, 'home', 'someone', '.ssh');
  mkdirSync(sshDir, { recursive: true });
  return { root, sshDir };
}

/** Run the probe log-only against a fixture; returns its combined output. */
function runProbe(fx: Fixture, env: Record<string, string> = {}): string {
  const result = spawnSync('bash', [PROBE], {
    encoding: 'utf8',
    env: {
      ...process.env,
      KEYPERM_NO_FILE: '1',
      KEYPERM_DEEP: '0',
      KEYPERM_SSH_ROOTS: fx.root,
      KEYPERM_POSITIVE_CONTROL: join(fx.sshDir, 'control'),
      KEYPERM_STATE_DIR: join(fx.root, 'state'),
      ...env,
    },
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

async function waitForFile(path: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      readFileSync(path);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

/**
 * Every fixture gets a hardened control key, so the positive control passes and
 * a finding assertion is never secretly measuring the probe's self-validation.
 */
function withControl(fx: Fixture): Fixture {
  const control = join(fx.sshDir, 'control');
  writeFileSync(control, KEY_BODIES.opensshPlain);
  chmodSync(control, 0o600);
  chmodSync(fx.sshDir, 0o700);
  return fx;
}

function placeKey(fx: Fixture, name: string, body: string, mode: number): string {
  const p = join(fx.sshDir, name);
  writeFileSync(p, body);
  chmodSync(p, mode);
  return p;
}

describe('papercup-fedplane-key-permission-check.sh (WI-2143622)', () => {
  it('passes bash syntax validation', () => {
    const result = spawnSync('bash', ['-n', PROBE], { encoding: 'utf8' });
    expect(`${result.status} ${result.stderr ?? ''}`).toBe('0 ');
  });

  it('logs the source identity and hash supplied by the snapshot launcher', () => {
    const fx = withControl(fixture());
    const source = '/run/papercusp-script-snapshots/key-permission-check.sh';
    const sha256 = 'a'.repeat(64);
    const out = runProbe(fx, {
      PAPERCUSP_SCRIPT_SNAPSHOT_SOURCE_PATH: source,
      PAPERCUSP_SCRIPT_SNAPSHOT_SOURCE_SHA256: sha256,
    });

    expect(out).toContain(`run: source=${source} snapshot_sha256=${sha256}`);
  });

  it('keeps the systemd cap above all per-root deep-scan budgets', () => {
    const script = readFileSync(PROBE, 'utf8');
    const unit = readFileSync(join(SCRIPTS, 'systemd', 'papercup-fedplane-key-permission.service'), 'utf8');
    const roots = /^KEYPERM_DEEP_ROOTS=".*:-([^"]+)"/m.exec(script)?.[1] ?? '';
    const timeoutSeconds = Number(/^KEYPERM_DEEP_TIMEOUT_S=".*:-(\d+)"/m.exec(script)?.[1] ?? 0);
    const timeoutStartSeconds = Number(/^TimeoutStartSec=(\d+)$/m.exec(unit)?.[1] ?? 0);
    const defaultRootCount = roots.trim().split(/\s+/).filter(Boolean).length;

    expect(defaultRootCount).toBeGreaterThan(0);
    expect(timeoutStartSeconds).toBeGreaterThanOrEqual(defaultRootCount * timeoutSeconds + 900);
  });

  it('uses lowest best-effort I/O priority while keeping CPU priority mild', () => {
    const script = readFileSync(PROBE, 'utf8');
    const unit = readFileSync(join(SCRIPTS, 'systemd', 'papercup-fedplane-key-permission.service'), 'utf8');

    expect(script).toMatch(/timeout "\$KEYPERM_DEEP_TIMEOUT_S" nice -n 10 ionice -c 2 -n 7 bash -c/);
    expect(unit).toMatch(/^Nice=10$/m);
    expect(unit).toMatch(/^CPUWeight=50$/m);
    expect(unit).toMatch(/^IOSchedulingClass=best-effort$/m);
    expect(unit).toMatch(/^IOSchedulingPriority=7$/m);
  });

  it('filters tier-2 reads to modes that may be reported and tolerates vanished entries', () => {
    const script = readFileSync(PROBE, 'utf8');

    expect(script).toContain('find "$root" -ignore_readdir_race "$@" -perm /0077 -print0');
  });

  it('documents reloading and checking the manager after symlinked unit updates', () => {
    const readme = readFileSync(join(SCRIPTS, 'systemd', 'README.md'), 'utf8');

    expect(readme).toContain('After either symlinked unit file changes, rerun `systemctl --user daemon-reload`');
    expect(readme).toContain('systemd keeps the loaded definition until that command runs again.');
    expect(readme).toContain('systemctl --user show papercup-fedplane-key-permission.service -p Nice -p CPUWeight -p IOSchedulingClass -p IOSchedulingPriority');
  });

  it('prunes configured vendored directories from the tier-1 .ssh sweep', () => {
    const fx = withControl(fixture());
    const vendoredSsh = join(fx.root, 'vendor', '.ssh');
    mkdirSync(vendoredSsh, { recursive: true });
    const fixtureKey = join(vendoredSsh, 'id_exposed');
    writeFileSync(fixtureKey, KEY_BODIES.opensshPlain);
    chmodSync(fixtureKey, 0o664);

    const out = runProbe(fx);
    expect(out).toContain('positive control: passed');
    expect(out).toContain('no exposed private keys found');
    expect(out).not.toContain('vendor/.ssh');
    expect(out).not.toContain('id_exposed');
  });

  it('refuses to run at all when red-marker.sh is missing, rather than silently deduping on age', () => {
    // The library supplies the state-aware dedup gate (EI-22240553542994017). A
    // probe that degraded to age-only suppression would assert "already tracked"
    // about a dropped item while a usable private key sits world-readable, so
    // absence of the library must be fatal, not a fallback.
    const dir = mkdtempSync(join(tmpdir(), 'keyperm-nolib-'));
    const copy = join(dir, 'probe.sh');
    writeFileSync(copy, execFileSync('cat', [PROBE], { encoding: 'utf8' }));
    const result = spawnSync('bash', [copy], { encoding: 'utf8', env: { ...process.env } });
    expect(result.status).toBe(2);
    expect(`${result.stderr}`).toContain('refusing to run with age-only dedup');
  });

  // ── The exposure shape this probe was built for ────────────────────────────
  // EI-22240449643643994: /mnt/data/back/Debug/.ssh/id_ed25519, mode 0664 inside
  // a 0775 directory, no passphrase.
  it('reports BOTH an over-permissive .ssh directory and an over-permissive key inside it', () => {
    const fx = withControl(fixture());
    chmodSync(fx.sshDir, 0o775);
    placeKey(fx, 'id_ed25519', KEY_BODIES.opensshPlain, 0o664);

    const out = runProbe(fx);
    expect(out).toMatch(/DIR {2}mode=775 .*\.ssh \(expected 700\)/);
    expect(out).toMatch(/KEY {2}mode=664 .*id_ed25519/);
  });

  // ⛔ THE REGRESSION GUARD. The first implementation asked
  // `ssh-keygen -y -P '' -f <key>` whether a key was unencrypted. ssh-keygen
  // REFUSES a key whose permissions are too open ("Permissions 0664 ... are too
  // open", exit 255) — which is true of EVERY key this probe flags, by
  // definition. So it answered "not unencrypted" for every finding and reported
  // unencrypted world-readable keys as passphrase-protected: severity understated
  // in exactly the reassuring direction. Anyone reverting to ssh-keygen fails here.
  it('still identifies an UNENCRYPTED key when its permissions are too open for ssh-keygen to load', () => {
    const fx = withControl(fixture());
    placeKey(fx, 'id_exposed', KEY_BODIES.opensshPlain, 0o664);

    const out = runProbe(fx);
    expect(out).toMatch(/KEY {2}mode=664 .*id_exposed — UNENCRYPTED/);
    expect(out).not.toMatch(/id_exposed — passphrase-protected/);
  });

  it.each([
    ['opensshPlain', 'UNENCRYPTED'],
    ['pkcs8Plain', 'UNENCRYPTED'],
    ['pemPlain', 'UNENCRYPTED'],
    ['opensshEncrypted', 'passphrase-protected'],
    ['pkcs8Encrypted', 'passphrase-protected'],
    ['pemEncrypted', 'passphrase-protected'],
  ])('classifies %s correctly regardless of file mode', (kind, expected) => {
    const fx = withControl(fixture());
    placeKey(fx, `k_${kind}`, KEY_BODIES[kind], 0o664);
    expect(runProbe(fx)).toContain(`k_${kind} — ${expected}`);
  });

  it('reports nothing for a correctly hardened .ssh directory and key', () => {
    const fx = withControl(fixture());
    placeKey(fx, 'id_ed25519', KEY_BODIES.opensshPlain, 0o600);

    const out = runProbe(fx);
    expect(out).toContain('no exposed private keys found');
    expect(out).not.toMatch(/^KEY /m);
    expect(out).not.toMatch(/^DIR /m);
  });

  it('ignores public keys, known_hosts, config and authorized_keys', () => {
    const fx = withControl(fixture());
    for (const name of ['id_ed25519.pub', 'known_hosts', 'config', 'authorized_keys']) {
      const p = join(fx.sshDir, name);
      writeFileSync(p, 'ssh-ed25519 AAAAC3Nza not-a-private-key\n');
      chmodSync(p, 0o664);
    }
    expect(runProbe(fx)).toContain('no exposed private keys found');
  });

  // ⛔ REGRESSION GUARD. The first implementation grepped for the bare phrase
  // "PRIVATE KEY", and the first full live sweep immediately flagged Python
  // SOURCE FILES that merely mention it — cryptography's serialization/ssh.py,
  // pyjwt's utils.py, joserfc's security.py — because any library that PARSES
  // PEM contains the string in a constant or regex. Dozens of confident false
  // positives per run is how a detector gets muted, so the predicate anchors on
  // a line that IS the delimiter.
  it('ignores source code that merely MENTIONS private keys', () => {
    const fx = withControl(fixture());
    const p = join(fx.sshDir, 'pem_parser.py');
    writeFileSync(
      p,
      [
        '# Handles PEM encoding of private key material.',
        'PRIVATE_KEY_HEADER = "PRIVATE KEY"',
        'def is_private_key(blob):',
        '    return "PRIVATE KEY" in blob  # matches BEGIN RSA PRIVATE KEY etc.',
      ].join('\n'),
    );
    chmodSync(p, 0o664);

    const out = runProbe(fx);
    expect(out).not.toContain('pem_parser.py');
    expect(out).toContain('no exposed private keys found');
  });

  it('ignores a world-readable file that is not actually a private key', () => {
    // Constraint (1): content-match, never filename. `id_*` matches locale files
    // such as /usr/share/i18n/locales/id_ID, which are not keys.
    const fx = withControl(fixture());
    const p = join(fx.sshDir, 'id_ID');
    writeFileSync(p, 'escape_char /\ncomment_char %\n');
    chmodSync(p, 0o664);
    expect(runProbe(fx)).toContain('no exposed private keys found');
  });

  // ── Constraint (3): an empty result is not automatically a clean result ────
  describe('self-validation', () => {
    it('declares its result INDETERMINATE when a real control key exists but the sweep never reaches it', () => {
      const fx = withControl(fixture());
      const outside = join(fx.root, 'outside');
      mkdirSync(outside, { recursive: true });
      const control = join(outside, 'control');
      writeFileSync(control, KEY_BODIES.opensshPlain);
      chmodSync(control, 0o600);

      const out = runProbe(fx, {
        KEYPERM_POSITIVE_CONTROL: control,
        KEYPERM_SSH_ROOTS: join(fx.root, 'home'),
      });
      expect(out).toContain('positive control: FAILED');
      expect(out).toContain('cannot validate itself');
      expect(out).toContain('INDETERMINATE, not clean');
    });

    // A configured control that does not exist is the misconfiguration most
    // likely to happen silently (a stale path, a moved key). Treating it as a
    // skip would let the probe print "no exposed private keys found" forever
    // while validating nothing — a false clean manufactured by the safety
    // mechanism itself, which is worse than having no control at all.
    it('treats a CONFIGURED BUT MISSING control as a failure, not a skip', () => {
      const fx = withControl(fixture());
      const out = runProbe(fx, { KEYPERM_POSITIVE_CONTROL: join(fx.root, 'nowhere', 'control') });
      expect(out).toContain('positive control: ABSENT');
      expect(out).toContain('cannot validate itself');
    });

    it('allows a deliberate opt-out for a host that genuinely holds no key', () => {
      const fx = withControl(fixture());
      const out = runProbe(fx, { KEYPERM_POSITIVE_CONTROL: '' });
      expect(out).toContain('UNVALIDATED by design');
      expect(out).not.toContain('cannot validate itself');
    });

    it('passes its positive control when the control key is inside a swept root', () => {
      const out = runProbe(withControl(fixture()));
      expect(out).toContain('positive control: passed');
      expect(out).not.toContain('cannot validate itself');
    });

    it('names an unreadable root as a BLIND SPOT instead of counting it as clean', () => {
      const fx = withControl(fixture());
      const blind = join(fx.root, 'blind');
      mkdirSync(blind, { recursive: true });
      chmodSync(blind, 0o000);
      try {
        const out = runProbe(fx, { KEYPERM_SSH_ROOTS: `${fx.root} ${blind}` });
        expect(out).toContain('BLIND SPOT, not a clean result');
      } finally {
        chmodSync(blind, 0o700);
      }
    });
  });

  // ── Constraint (2): vendored trees, or the probe gets ignored ──────────────
  describe('tier-2 content sweep', () => {
    it('excludes vendored dependency trees but reports a loose key beside them', () => {
      // Measured 2026-09-03: 755 group/world-readable private keys existed under
      // /mnt/data and every one was published third-party test material. A probe
      // that reports those is a probe nobody reads.
      const fx = withControl(fixture());
      const deep = join(fx.root, 'deep');
      const vendored = join(deep, 'app', 'node_modules', 'ssh2', 'test', 'fixtures');
      const loose = join(deep, 'app', 'config');
      mkdirSync(vendored, { recursive: true });
      mkdirSync(loose, { recursive: true });
      for (const p of [join(vendored, 'id_rsa'), join(loose, 'deploy.pem')]) {
        writeFileSync(p, KEY_BODIES.opensshPlain);
        chmodSync(p, 0o664);
      }

      const out = runProbe(fx, { KEYPERM_DEEP: '1', KEYPERM_DEEP_ROOTS: deep });
      expect(out).toMatch(/FILE mode=664 .*config\/deploy\.pem/);
      expect(out).not.toContain('node_modules');
    });

    it('excludes dependency-generation temp trees with suffixed node_modules names', () => {
      const fx = withControl(fixture());
      const deep = join(fx.root, 'deep');
      const vendored = join(deep, 'node_modules', 'ssh2', 'test', 'fixtures');
      const deployTemp = join(deep, 'node_modules.deploy-tmp.1592326.generation-tmp.1592326', 'ssh2', 'test', 'fixtures');
      const deployOld = join(deep, 'node_modules.deploy-old.1592326', 'ssh2', 'test', 'fixtures');
      const generationTemp = join(deep, 'node_modules.generation-tmp.1592326', 'ssh2', 'test', 'fixtures');
      const generationOld = join(deep, 'node_modules.generation-old.1592326', 'ssh2', 'test', 'fixtures');
      const loose = join(deep, 'app', 'config');
      for (const directory of [vendored, deployTemp, deployOld, generationTemp, generationOld, loose]) {
        mkdirSync(directory, { recursive: true });
      }
      for (const path of [
        join(vendored, 'id_rsa'),
        join(deployTemp, 'id_ecdsa'),
        join(deployOld, 'ssh_host_rsa_key'),
        join(generationTemp, 'id_dsa'),
        join(generationOld, 'ssh_host_ecdsa_key'),
        join(loose, 'deploy.pem'),
      ]) {
        writeFileSync(path, KEY_BODIES.opensshPlain);
        chmodSync(path, 0o664);
      }

      const out = runProbe(fx, { KEYPERM_DEEP: '1', KEYPERM_DEEP_ROOTS: deep });
      expect(out).toMatch(/FILE mode=664 .*config\/deploy\.pem/);
      expect(out).not.toContain('node_modules/');
      expect(out).not.toContain('node_modules.deploy-tmp.');
      expect(out).not.toContain('node_modules.deploy-old.');
    });

    it('prunes generated Android intermediates while still reporting a loose workspace key', () => {
      const fx = withControl(fixture());
      const deep = join(fx.root, 'deep');
      const generated = join(deep, 'app', 'build', 'intermediates', 'merged_res');
      const loose = join(deep, 'app', 'config');
      mkdirSync(generated, { recursive: true });
      mkdirSync(loose, { recursive: true });
      const generatedFixture = join(generated, 'generated-test-key.pem');
      const looseFixture = join(loose, 'deploy.pem');
      for (const path of [generatedFixture, looseFixture]) {
        writeFileSync(path, KEY_BODIES.opensshPlain);
        chmodSync(path, 0o664);
      }

      const out = runProbe(fx, { KEYPERM_DEEP: '1', KEYPERM_DEEP_ROOTS: deep });
      expect(out).toContain('FILE mode=664 ' + looseFixture + ' (content-matched private key outside .ssh)');
      expect(out).not.toContain('generated-test-key.pem');
    });

    it('prunes generated Android Rust dependency sources while reporting a loose workspace key', () => {
      const fx = withControl(fixture());
      const deep = join(fx.root, 'deep');
      const generated = join(deep, 'app', 'build', 'outputs', 'papercusp-rust-dependencies', 'ring-0.17.14');
      const loose = join(deep, 'app', 'config');
      mkdirSync(generated, { recursive: true });
      mkdirSync(loose, { recursive: true });
      const generatedFixture = join(generated, 'generated-test-key.pem');
      const looseFixture = join(loose, 'deploy.pem');
      for (const path of [generatedFixture, looseFixture]) {
        writeFileSync(path, KEY_BODIES.opensshPlain);
        chmodSync(path, 0o664);
      }

      const out = runProbe(fx, { KEYPERM_DEEP: '1', KEYPERM_DEEP_ROOTS: deep });
      expect(out).toContain('FILE mode=664 ' + looseFixture + ' (content-matched private key outside .ssh)');
      expect(out).not.toContain('papercusp-rust-dependencies');
      expect(out).not.toContain('generated-test-key.pem');
    });

    it('prunes temporary JNA configure and native source trees while reporting a loose workspace key', () => {
      const fx = withControl(fixture());
      const deep = join(fx.root, 'deep');
      const configure = join(deep, 'app', 'build', 'outputs', 'papercusp-jna-configure-run-1', 'source');
      const native = join(deep, 'app', 'build', 'outputs', 'papercusp-jna-native-run-1', 'libffi', 'src');
      const loose = join(deep, 'app', 'config');
      mkdirSync(configure, { recursive: true });
      mkdirSync(native, { recursive: true });
      mkdirSync(loose, { recursive: true });
      const generatedFixtures = [
        join(configure, 'generated-configure-test-key.pem'),
        join(native, 'generated-native-test-key.pem'),
      ];
      const looseFixture = join(loose, 'deploy.pem');
      for (const path of [...generatedFixtures, looseFixture]) {
        writeFileSync(path, KEY_BODIES.opensshPlain);
        chmodSync(path, 0o664);
      }

      const out = runProbe(fx, { KEYPERM_DEEP: '1', KEYPERM_DEEP_ROOTS: deep });
      expect(out).toContain('FILE mode=664 ' + looseFixture + ' (content-matched private key outside .ssh)');
      expect(out).not.toContain('papercusp-jna-configure-');
      expect(out).not.toContain('papercusp-jna-native-');
      expect(out).not.toContain('generated-configure-test-key.pem');
      expect(out).not.toContain('generated-native-test-key.pem');
    });

    it('keeps grep process count bounded for large candidate batches', () => {
      const fx = withControl(fixture());
      const deep = join(fx.root, 'deep');
      const bin = join(fx.root, 'bin');
      const counter = join(fx.root, 'grep-invocations');
      mkdirSync(deep, { recursive: true });
      mkdirSync(bin, { recursive: true });

      const configText = 'ordinary configuration data with no key material\n'.repeat(4);
      for (let i = 0; i < 1001; i += 1) {
        writeFileSync(join(deep, `config-${i}.txt`), configText);
      }

      // Count only xargs batches; the probe's other grep calls have fewer than
      // ten arguments. Keep using the real grep for matching behavior.
      const grepShim = join(bin, 'grep');
      writeFileSync(
        grepShim,
        '#!/usr/bin/env bash\nif [ "$#" -gt 10 ]; then printf x >> "$KEYPERM_GREP_COUNTER"; fi\nexec /usr/bin/grep "$@"\n',
      );
      chmodSync(grepShim, 0o755);

      runProbe(fx, {
        KEYPERM_DEEP: '1',
        KEYPERM_DEEP_ROOTS: deep,
        KEYPERM_GREP_COUNTER: counter,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      });

      expect(readFileSync(counter, 'utf8').length).toBeLessThanOrEqual(2);
    });

    it('does not content-read a file whose mode cannot produce a group/other finding', () => {
      const fx = withControl(fixture());
      const deep = join(fx.root, 'deep');
      const bin = join(fx.root, 'bin');
      mkdirSync(deep, { recursive: true });
      mkdirSync(bin, { recursive: true });

      const protectedFile = join(deep, 'protected.conf');
      writeFileSync(protectedFile, 'private configuration data\n'.repeat(8));
      chmodSync(protectedFile, 0o000);

      const grepShim = join(bin, 'grep');
      writeFileSync(
        grepShim,
        [
          '#!/usr/bin/env bash',
          'for arg in "$@"; do',
          '  if [ "$arg" = "-laIE" ]; then',
          '    printf "unexpected content read\\n" >&2',
          '    exit 2',
          '  fi',
          'done',
          'exec /usr/bin/grep "$@"',
        ].join('\n'),
      );
      chmodSync(grepShim, 0o755);

      const out = runProbe(fx, {
        KEYPERM_DEEP: '1',
        KEYPERM_DEEP_ROOTS: deep,
        PATH: bin + ':' + (process.env.PATH ?? ''),
      });

      expect(out).toContain('tier2: root result root=' + deep + ' status=0');
      expect(out).not.toContain('unexpected content read');
      expect(out).toContain('no exposed private keys found');
    });

    it('does not double-report a .ssh key already reported by tier 1', () => {
      const fx = withControl(fixture());
      placeKey(fx, 'id_ed25519', KEY_BODIES.opensshPlain, 0o664);
      const out = runProbe(fx, { KEYPERM_DEEP: '1', KEYPERM_DEEP_ROOTS: fx.root });
      expect(out.match(/id_ed25519/g)?.length).toBe(1);
    });

    it('treats a timed-out bounded deep sweep as INDETERMINATE rather than clean', () => {
      // A killed find prints nothing and looks exactly like a clean one. Keep
      // the fixture bounded: test the timeout path with a delayed shim, never
      // by walking the host's entire filesystem.
      const fx = withControl(fixture());
      const slowRoot = join(fx.root, 'slow-root');
      const bin = join(fx.root, 'bin');
      mkdirSync(slowRoot, { recursive: true });
      mkdirSync(bin, { recursive: true });
      const findShim = join(bin, 'find');
      writeFileSync(
        findShim,
        [
          '#!/usr/bin/env bash',
          'case " $* " in *"$KEYPERM_TEST_SLOW_ROOT"*) exec /usr/bin/sleep 3 ;; esac',
          'exec /usr/bin/find "$@"',
        ].join('\n'),
      );
      chmodSync(findShim, 0o755);

      const out = runProbe(fx, {
        KEYPERM_DEEP: '1',
        KEYPERM_DEEP_ROOTS: slowRoot,
        KEYPERM_DEEP_TIMEOUT_S: '1',
        KEYPERM_TEST_SLOW_ROOT: slowRoot,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      });
      expect(out).toContain('INDETERMINATE');
      expect(out).toMatch(/TIMED OUT|timed out/);
      expect(out).toContain(slowRoot);
    });

    it('logs periodic progress for a slow bounded root', () => {
      const fx = withControl(fixture());
      const slowRoot = join(fx.root, 'slow-root');
      const bin = join(fx.root, 'bin');
      mkdirSync(slowRoot, { recursive: true });
      mkdirSync(bin, { recursive: true });
      const findShim = join(bin, 'find');
      writeFileSync(
        findShim,
        [
          '#!/usr/bin/env bash',
          'case " $* " in *"$KEYPERM_TEST_SLOW_ROOT"*) /usr/bin/sleep 2 ;; esac',
          'exec /usr/bin/find "$@"',
        ].join('\n'),
      );
      chmodSync(findShim, 0o755);

      const out = runProbe(fx, {
        KEYPERM_DEEP: '1',
        KEYPERM_DEEP_ROOTS: slowRoot,
        KEYPERM_DEEP_TIMEOUT_S: '6',
        KEYPERM_TEST_SLOW_ROOT: slowRoot,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      });

      expect(out).toContain(`tier2: scan still running root=${slowRoot}`);
      expect(out).toContain(`tier2: root result root=${slowRoot} status=0`);
    });

    it('reaps the progress sleeper when the scanner receives TERM', async () => {
      const fx = withControl(fixture());
      const slowRoot = join(fx.root, 'slow-root');
      const bin = join(fx.root, 'bin');
      const findReady = join(fx.root, 'find-ready');
      const findRelease = join(fx.root, 'find-release');
      const sleepPidFile = join(fx.root, 'progress-sleep.pid');
      mkdirSync(slowRoot, { recursive: true });
      mkdirSync(bin, { recursive: true });

      const findShim = join(bin, 'find');
      writeFileSync(
        findShim,
        [
          '#!/usr/bin/env bash',
          'case " $* " in',
          '  *"$KEYPERM_TEST_DEEP_ROOT"*)',
          '    : > "$KEYPERM_TEST_FIND_READY"',
          '    while [ ! -e "$KEYPERM_TEST_FIND_RELEASE" ]; do /usr/bin/sleep 0.05; done',
          '    ;;',
          'esac',
          'exec /usr/bin/find "$@"',
        ].join('\n'),
      );
      chmodSync(findShim, 0o755);

      const sleepShim = join(bin, 'sleep');
      writeFileSync(
        sleepShim,
        [
          '#!/usr/bin/env bash',
          'printf "%s\\n" "$$" > "$KEYPERM_TEST_SLEEP_PID_FILE"',
          'exec /usr/bin/sleep "$@"',
        ].join('\n'),
      );
      chmodSync(sleepShim, 0o755);

      const child = spawn('bash', [PROBE], {
        env: {
          ...process.env,
          KEYPERM_NO_FILE: '1',
          KEYPERM_DEEP: '1',
          KEYPERM_DEEP_ROOTS: slowRoot,
          KEYPERM_DEEP_TIMEOUT_S: '12',
          KEYPERM_SSH_ROOTS: fx.root,
          KEYPERM_POSITIVE_CONTROL: join(fx.sshDir, 'control'),
          KEYPERM_STATE_DIR: join(fx.root, 'state'),
          KEYPERM_TEST_DEEP_ROOT: slowRoot,
          KEYPERM_TEST_FIND_READY: findReady,
          KEYPERM_TEST_FIND_RELEASE: findRelease,
          KEYPERM_TEST_SLEEP_PID_FILE: sleepPidFile,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
      });
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      const closed = new Promise<number | null>((resolveClose, rejectClose) => {
        child.once('error', rejectClose);
        child.once('close', resolveClose);
      });

      try {
        await waitForFile(sleepPidFile);
        await waitForFile(findReady);
        expect(child.kill('SIGTERM')).toBe(true);
        await new Promise((resolveWait) => setTimeout(resolveWait, 30));
        writeFileSync(findRelease, 'continue\n');

        let timer: NodeJS.Timeout | undefined;
        const timedOut = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('scanner did not exit after TERM')), 4_000);
        });
        const status = await Promise.race([closed, timedOut]);
        if (timer) clearTimeout(timer);
        expect(status).toBe(143);

        const sleepPid = Number(readFileSync(sleepPidFile, 'utf8').trim());
        expect(Number.isInteger(sleepPid)).toBe(true);
        let sleeperAlive = false;
        try {
          process.kill(sleepPid, 0);
          sleeperAlive = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        expect(sleeperAlive).toBe(false);
        // TERM is sent as soon as the progress sleeper starts, before the
        // progress interval elapses. The adjacent slow-root case verifies the
        // progress line; this case verifies cleanup without requiring one.
      } finally {
        writeFileSync(findRelease, 'cleanup\n');
        if (child.exitCode === null) child.kill('SIGKILL');
        try {
          const sleepPid = Number(readFileSync(sleepPidFile, 'utf8').trim());
          if (Number.isInteger(sleepPid)) process.kill(sleepPid, 'SIGKILL');
        } catch {
          // The source's cleanup already reaped the recorded child.
        }
      }
    });

    it('reports a bounded path-free grep error class and keeps the deep sweep INDETERMINATE', () => {
      const fx = withControl(fixture());
      const candidate = join(fx.root, 'public-candidate.conf');
      const bin = join(fx.root, 'bin');
      const hiddenPath = '/private/config/credential-name';
      mkdirSync(bin);
      writeFileSync(candidate, 'ordinary public configuration data\n'.repeat(8));
      chmodSync(candidate, 0o644);
      const grepShim = join(bin, 'grep');
      writeFileSync(
        grepShim,
        [
          '#!/usr/bin/env bash',
          'for arg in "$@"; do',
          '  if [ "$arg" = "-laIE" ]; then',
          `    printf 'grep: ${hiddenPath}: Permission denied\\n' >&2`,
          '    exit 2',
          '  fi',
          'done',
          'exec /usr/bin/grep "$@"',
        ].join('\n'),
      );
      chmodSync(grepShim, 0o755);

      const out = runProbe(fx, {
        KEYPERM_DEEP: '1',
        KEYPERM_DEEP_ROOTS: fx.root,
        PATH: bin + ':' + (process.env.PATH ?? ''),
      });

      expect(out).toContain('scan command failed');
      expect(out).toContain(`tier2: stderr diagnostics root=${fx.root} source=grep`);
      expect(out).toContain('permission_denied=1');
      expect(out).not.toContain(hiddenPath);
      expect(out).toContain('INDETERMINATE');
      expect(out).not.toContain('no exposed private keys found');
    });

    it('keeps non-race find errors INDETERMINATE', () => {
      const fx = withControl(fixture());
      const deep = join(fx.root, 'deep');
      const bin = join(fx.root, 'bin');
      mkdirSync(deep, { recursive: true });
      mkdirSync(bin, { recursive: true });

      const findShim = join(bin, 'find');
      writeFileSync(
        findShim,
        [
          '#!/usr/bin/env bash',
          'case " $* " in',
          '  *"$KEYPERM_TEST_DEEP_ROOT"*)',
          '    printf "find: synthetic: No such file or directory\\n" >&2',
          '    exit 1',
          '    ;;',
          'esac',
          'exec /usr/bin/find "$@"',
        ].join('\n'),
      );
      chmodSync(findShim, 0o755);

      const out = runProbe(fx, {
        KEYPERM_DEEP: '1',
        KEYPERM_DEEP_ROOTS: deep,
        KEYPERM_TEST_DEEP_ROOT: deep,
        PATH: bin + ':' + (process.env.PATH ?? ''),
      });

      expect(out).toContain('tier2: stderr diagnostics root=' + deep + ' source=find');
      expect(out).toContain('no_such_file=1');
      expect(out).toContain('tier2: root result root=' + deep + ' status=1');
      expect(out).toContain('result INDETERMINATE, not clean');
    });

    it('accepts only verified vanished descendants when find reports a traversal race', () => {
      const fx = withControl(fixture());
      const deep = join(fx.root, 'deep');
      const vanished = join(deep, 'transient-build');
      const bin = join(fx.root, 'bin');
      mkdirSync(vanished, { recursive: true });
      mkdirSync(bin, { recursive: true });

      const findShim = join(bin, 'find');
      writeFileSync(
        findShim,
        [
          '#!/usr/bin/env bash',
          'if [[ " $* " == *"$KEYPERM_TEST_DEEP_ROOT"* ]]; then',
          '  /usr/bin/find "$@" || exit $?',
          '  rmdir "$KEYPERM_TEST_VANISHED_DIR" || exit 97',
          '  printf "find: \'%s\': No such file or directory\\n" "$KEYPERM_TEST_VANISHED_DIR" >&2',
          '  exit 1',
          'fi',
          'exec /usr/bin/find "$@"',
        ].join('\n'),
      );
      chmodSync(findShim, 0o755);

      const out = runProbe(fx, {
        KEYPERM_DEEP: '1',
        KEYPERM_DEEP_ROOTS: deep,
        KEYPERM_TEST_DEEP_ROOT: deep,
        KEYPERM_TEST_VANISHED_DIR: vanished,
        PATH: bin + ':' + (process.env.PATH ?? ''),
      });

      expect(out).toContain('ignored 1 verified vanished descendant(s) under unchanged root=' + deep);
      expect(out).toContain('tier2: root result root=' + deep + ' status=0');
      expect(out).toContain('no exposed private keys found');
      expect(out).not.toContain('result INDETERMINATE, not clean');
    });

    it('retains every failed root in the deep-sweep report', () => {
      const fx = withControl(fixture());
      const firstRoot = join(fx.root, 'deep-first');
      const secondRoot = join(fx.root, 'deep-second');
      const bin = join(fx.root, 'bin');
      const capture = join(fx.root, 'request.json');
      mkdirSync(firstRoot, { recursive: true });
      mkdirSync(secondRoot, { recursive: true });
      mkdirSync(bin, { recursive: true });

      const configText = 'ordinary configuration data without key material\n'.repeat(4);
      writeFileSync(join(firstRoot, 'first.cfg'), configText);
      writeFileSync(join(secondRoot, 'second.cfg'), configText);

      const findShim = join(bin, 'find');
      writeFileSync(
        findShim,
        [
          '#!/usr/bin/env bash',
          'case " $* " in *"$KEYPERM_SLOW_ROOT"*) exec sleep 3 ;; esac',
          'exec /usr/bin/find "$@"',
        ].join('\n'),
      );
      chmodSync(findShim, 0o755);

      const grepShim = join(bin, 'grep');
      writeFileSync(
        grepShim,
        [
          '#!/usr/bin/env bash',
          'for arg in "$@"; do if [ "$arg" = "-laIE" ]; then exit 2; fi; done',
          'exec /usr/bin/grep "$@"',
        ].join('\n'),
      );
      chmodSync(grepShim, 0o755);

      const curlShim = join(bin, 'curl');
      writeFileSync(
        curlShim,
        [
          '#!/usr/bin/env bash',
          'while [ "$#" -gt 0 ]; do',
          '  if [ "$1" = "-d" ]; then',
          '    shift',
          '    printf "%s" "$1" > "$KEYPERM_CAPTURE_FILE"',
          '    exit 0',
          '  fi',
          '  shift',
          'done',
          'exit 0',
        ].join('\n'),
      );
      chmodSync(curlShim, 0o755);

      runProbe(fx, {
        KEYPERM_DEEP: '1',
        KEYPERM_DEEP_ROOTS: firstRoot + ' ' + secondRoot,
        KEYPERM_DEEP_TIMEOUT_S: '1',
        KEYPERM_SLOW_ROOT: firstRoot,
        KEYPERM_CAPTURE_FILE: capture,
        KEYPERM_NO_FILE: '0',
        PATH: bin + ':' + (process.env.PATH ?? ''),
      });

      const request = readFileSync(capture, 'utf8');
      expect(request).toContain('status=ERROR');
      expect(request).toContain(firstRoot + ': status 124 (timeout)');
      expect(request).toContain(secondRoot + ': command status 123');
    });
  });
});
