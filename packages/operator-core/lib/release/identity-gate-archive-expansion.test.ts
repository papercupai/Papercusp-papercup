/**
 * Recurrence guard for EI-20108164746219771 — the release identity gate must SEE
 * INSIDE a `.deb`, because a raw byte-grep on one cannot.
 *
 * WHAT WENT WRONG (measured, not hypothesised): the 0.0.15 SERVER `.deb` scored
 * 0 on a raw grep and 3 once decompressed. `bin/audit-release-bundle.py` owns an
 * archive-expansion pass built precisely for this, and its contract is explicit —
 * "an archive we cannot open is reported and FAILS: the whole point of this pass
 * is that 'not inspected' must stop reading as 'clean'". But `.deb` was missing
 * from ARCHIVE_SUFFIXES, so those files were never handed to the expander at all.
 * The gate printed `0 archive(s) expanded and scanned` and exited 0, and a bundle
 * carrying the owner's hostname, OS username and GitHub handle shipped green.
 *
 * The defect was therefore NOT in the machinery — it was one missing entry in a
 * suffix tuple, which is exactly the kind of omission a passing gate cannot
 * reveal about itself. That is what this guard exists to catch: it fails if
 * `.deb` ever leaves ARCHIVE_SUFFIXES again, and it proves end-to-end that a
 * literal hidden inside a compressed payload still reds the gate.
 *
 * WHY THE SENTINEL IS DERIVED, NEVER HARDCODED: `check-no-identity-literals`
 * scans superproject source for exactly these values, so writing one into this
 * file would red the green-checkpoint the tick it landed — the guard would break
 * the gate it guards. Reading the denylist out of the gate at runtime also means
 * a newly-added identity is covered automatically instead of drifting.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
/**
 * Overridable SO THAT THIS GUARD CAN BE PROVEN FALSIFIABLE without mutating the
 * shared tree. Point it at a copy of the gate with `.deb` removed from
 * ARCHIVE_SUFFIXES and every assertion below must FAIL — that run is what
 * demonstrates the test measures the fix rather than merely co-existing with it.
 * A tree-mutating probe is not an option here: git-sync sweeps the whole tree on
 * a timer and would commit the mutant even if nothing went wrong.
 */
const GATE =
  process.env.PAPERCUSP_IDENTITY_GATE_PATH ??
  path.join(REPO_ROOT, 'papercusp-desktop', 'bin', 'audit-release-bundle.py');

function gateSource(): string {
  return readFileSync(GATE, 'utf8');
}

/**
 * A SYNTHETIC owner name, asserted to the gate for every invocation below.
 *
 * `--scan-dir` refuses to certify unless an owner-name literal is ASSERTED
 * (`has_owner_name_literal` → `explicit_owner_values(OWNER_NAME_ENV)`), and it
 * deliberately ignores whatever git supplies, because a build box's git identity
 * names the COMMITTER — on an automated box, by construction not the owner. That
 * refusal is correct and is the whole point of the gate; it is simply a
 * PRECONDITION of the certify path, unrelated to what this file measures
 * (archive expansion of a cross-box denylist value).
 *
 * So the value is supplied here rather than inherited. This is what the env seam
 * exists for, and it makes these assertions independent of whichever identity the
 * build box happens to carry — the coupling that silently turned this file red
 * when the box's `user.name` moved to automation. It must stay SYNTHETIC: a real
 * identity in tracked source is the exact leak the gate is written to prevent.
 */
const SYNTHETIC_OWNER = 'Zzsynthetic Gateowner';
const GATE_ENV = { ...process.env, PAPERCUSP_RELEASE_OWNER_NAME: SYNTHETIC_OWNER };

/** A value the gate hunts unconditionally, read from its own denylist. */
function sentinelFromDenylist(): string {
  const block = gateSource().match(/KNOWN_SENSITIVE_IDENTITIES\s*=\s*\{([\s\S]*?)\}/)?.[1];
  if (!block) throw new Error('KNOWN_SENSITIVE_IDENTITIES not found — gate structure changed');
  // Values only; keys are the stable "known-sensitive:*" identifiers.
  const values = [...block.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
  const usable = values.filter((v) => v.length >= 6); // hunted as a plain substring
  if (usable.length === 0) throw new Error('no high-entropy sentinel available in denylist');
  return usable[0];
}

function have(bin: string): boolean {
  return (
    spawnSync('sh', ['-c', `command -v ${bin}`], {
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    }).status === 0
  );
}

describe('release identity gate: archive expansion (EI-20108164746219771)', () => {
  it('lists .deb in ARCHIVE_SUFFIXES', () => {
    const block = gateSource().match(/ARCHIVE_SUFFIXES\s*=\s*\(([\s\S]*?)\)/)?.[1];
    expect(block, 'ARCHIVE_SUFFIXES not found — gate structure changed').toBeTruthy();
    // The regression this pins: a .deb absent here is never expanded, so a leak
    // inside one is reported as CLEAN rather than caught.
    expect(block).toMatch(/"\.deb"/);
  });

  it('hunts identities that no build box owns (cross-identity backstop is populated)', () => {
    // identity_literals() resolves only the BUILDING machine, so a handle or a
    // sibling VM's user is invisible to it. The denylist is the only thing that
    // catches those, and an empty one fails open silently.
    const block = gateSource().match(/KNOWN_SENSITIVE_IDENTITIES\s*=\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const entries = [...block.matchAll(/"known-sensitive:[^"]+"\s*:/g)];
    expect(entries.length).toBeGreaterThanOrEqual(4);
  });

  it('FAILS on an identity literal hidden inside a compressed .deb payload', () => {
    if (!have('dpkg-deb') || !have('python3')) {
      // Not silently skipped: an unrunnable guard must say so, or its silence
      // reads as a pass — the same failure mode the gate itself is about.
      console.warn('[identity-gate guard] SKIPPED: dpkg-deb/python3 unavailable on this host');
      return;
    }
    const sentinel = sentinelFromDenylist();
    const dir = mkdtempSync(path.join(tmpdir(), 'pc-identity-gate-'));
    try {
      const pkg = path.join(dir, 'pkg');
      mkdirSync(path.join(pkg, 'DEBIAN'), { recursive: true });
      mkdirSync(path.join(pkg, 'usr/share/papercusp'), { recursive: true });
      writeFileSync(
        path.join(pkg, 'DEBIAN/control'),
        'Package: papercusp-gate-probe\nVersion: 0.0.1\nArchitecture: amd64\n' +
          'Maintainer: Test <test@example.invalid>\nDescription: identity gate probe\n',
      );
      writeFileSync(
        path.join(pkg, 'usr/share/papercusp/seedlike.txt'),
        `harmless\nhandle=${sentinel}\n`,
      );
      const deb = path.join(dir, 'probe.deb');
      // -Zxz so the payload is genuinely compressed; an uncompressed payload would
      // be caught by the raw grep and prove nothing about expansion.
      execFileSync('dpkg-deb', ['-Zxz', '--build', pkg, deb], {
        stdio: 'ignore',
        timeout: 120_000,
        killSignal: 'SIGKILL',
      });
      rmSync(pkg, { recursive: true, force: true }); // the .deb must stand ALONE

      // PRECONDITION: the raw bytes really are blind to the sentinel. Without this
      // the test could pass for the wrong reason (payload accidentally plaintext),
      // which would make it a guard that cannot fail.
      const raw = spawnSync('grep', ['-acF', sentinel, deb], {
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      });
      expect(raw.stdout.trim(), 'payload was not actually compressed').toBe('0');

      const run = spawnSync('python3', [GATE, '--scan-dir', dir], {
        encoding: 'utf8',
        env: GATE_ENV,
        timeout: 120_000,
        killSignal: 'SIGKILL',
      });
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toMatch(/expanding 1 archive\(s\)/);
      expect(out).toMatch(/CARRIES SENSITIVE IDENTITY/);
      expect(out).toMatch(/probe\.deb!/); // reported as archive!member
      expect(run.status, 'gate must EXIT NONZERO on a leak inside a .deb').not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 130_000);

  // WI-10005667. Measured on the P-012 AWS bake's rootfs: 14 man-page links such as
  // usr/share/man/man1/man.1.gz -> /etc/alternatives/man.1.gz were opened as archives, so
  // their ABSOLUTE targets resolved against the HOST, not the scanned tree. They dangled
  // and failed the gate; a target that existed on the host would have been read as
  // image content. A link's target string is scanned by the symlink-target phase, and
  // a target that ships is a regular file the walk reaches on its own.
  it('never expands a SYMLINKED archive, so a rootfs link is not resolved against the host', () => {
    if (!have('python3')) {
      console.warn('[identity-gate guard] SKIPPED: python3 unavailable on this host');
      return;
    }
    const sentinel = sentinelFromDenylist();
    const hostSide = mkdtempSync(path.join(tmpdir(), 'pc-identity-gate-host-'));
    const scanned = mkdtempSync(path.join(tmpdir(), 'pc-identity-gate-rootfs-'));
    try {
      // Bytes that exist only OUTSIDE the scanned tree, and would red the gate if read.
      const hostArchive = path.join(hostSide, 'host-only.1.gz');
      writeFileSync(hostArchive, gzipSync(Buffer.from(`handle=${sentinel}\n`)));

      const man1 = path.join(scanned, 'usr/share/man/man1');
      mkdirSync(man1, { recursive: true });
      // Positive control: a regular archive in the tree must still be expanded.
      writeFileSync(path.join(man1, 'real.1.gz'), gzipSync(Buffer.from('harmless man page\n')));
      symlinkSync(path.join(hostSide, 'missing', 'man.1.gz'), path.join(man1, 'dangling.1.gz'));
      symlinkSync(hostArchive, path.join(man1, 'host.1.gz'));

      const run = spawnSync('python3', [GATE, '--scan-dir', scanned], {
        encoding: 'utf8',
        env: GATE_ENV,
        timeout: 120_000,
        killSignal: 'SIGKILL',
      });
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toMatch(/expanding 1 archive\(s\)/);
      expect(out).not.toMatch(/cannot expand/);
      expect(out).not.toMatch(/CARRIES SENSITIVE IDENTITY/);
      expect(run.status, out).toBe(0);
    } finally {
      rmSync(scanned, { recursive: true, force: true });
      rmSync(hostSide, { recursive: true, force: true });
    }
  }, 130_000);
});
