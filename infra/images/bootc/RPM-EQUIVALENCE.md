# P-304 — Ubuntu 24.04 → RPM-family (CentOS Stream 9) equivalence table

**Base verified against:** `quay.io/centos-bootc/centos-bootc:stream9` — `ID=centos VERSION_ID=9`,
the exact base the P-303 gate spike proved and the one D-254 targets.
**Method:** every row is an OBSERVATION from that base (a `podman run` probe), or a DERIVATION from
the rendered bootstrap / the r19 bundle's ELF headers. No row is a translation by guesswork.
**Measured:** 2026-09-03.

## How the assumption set was enumerated

Not from the plan item's "at minimum" list, and not by grepping TypeScript. The instrument
(`.papercusp/scratch/p304-derive-assumptions.ts`) **renders the real bootstrap**
(`buildWorkspaceHostBootstrap`, 330 lines, contract `papercusp-workspace-host-bootstrap-v2`) and
scans the emitted script, because that script is the artifact that actually runs on the host. A
source grep sees strings that may never reach a rendered script and misses ones assembled at render
time.

That mattered: the derivation surfaced **`groupadd`**, which the item's "at minimum" list omits.

## A. Base identity

| Ubuntu assumption | RPM equivalent | Verified how |
|---|---|---|
| `WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION = '24.04'` | `ID=centos`, `VERSION_ID=9` | Read `/etc/os-release` on the base. |
| `[[ $ID == 'ubuntu' && $VERSION_ID == '24.04' ]] \|\| die` (bootstrap:1117) | Must become an ID/VERSION_ID pair for the RPM family | The constant is **contract-load-bearing, not cosmetic**: it appears in the attestation (`ubuntuVersion`), in its validator (bootstrap:1652), in the image compatibility matrix (`workspace-host-image.ts:414`), and in the desktop pack (`:317`, `:424`). Renaming it is a **typed contract change across 4 modules**, not a string edit. |

## B. Identity, ACL and privilege primitives — all present, all at identical paths

Every one resolves to the **same absolute path** as on Ubuntu, so no path constant changes.

| Primitive | Ubuntu | CentOS Stream 9 | Verified how |
|---|---|---|---|
| `useradd` | `/usr/sbin/useradd` | `/usr/sbin/useradd` | `command -v` on base |
| `usermod` | `/usr/sbin/usermod` | `/usr/sbin/usermod` | `command -v` |
| `groupadd` *(derivation found this; item omitted it)* | `/usr/sbin/groupadd` | `/usr/sbin/groupadd` | `command -v` |
| `setfacl` / `getfacl` | `/usr/bin/setfacl` | `/usr/bin/setfacl` | `command -v`; pkg `acl` **INSTALLED** in base |
| `runuser` | `/usr/sbin/runuser` | `/usr/sbin/runuser` | `command -v` |
| `visudo` | `/usr/sbin/visudo` | `/usr/sbin/visudo` | `command -v`; `sudo` **INSTALLED** |
| `/usr/sbin/nologin` | present | present (`/sbin/nologin` also) | `test -e` |
| `sshd` | `/usr/sbin/sshd` | `/usr/sbin/sshd` | `command -v`; `openssh-server` **INSTALLED** |
| `systemctl` | `/usr/bin/systemctl` | `/usr/bin/systemctl` | `command -v` |
| `bwrap` *(added WI-10004636)* | `/usr/bin/bwrap` (pkg `bubblewrap`) | `/usr/bin/bwrap` (pkg `bubblewrap`, same name) | measured 2026-10-01 on a stock GCE `centos-stream-9` VM (kernel 5.14.0-741.el9, SELinux enforcing, no AppArmor): `dnf install bubblewrap` → `bubblewrap-0.6.3-1.el9`, mode `-rwxr-xr-x` (not setuid), `user.max_user_namespaces=62740`, and `runuser -u <nologin system user> -- bwrap … --unshare-user --unshare-pid --unshare-net true` **OK**. ⚠ A stock VM, not the bootc image: the booted host's `agent-sandbox-userns` bootstrap check is the proof for the image itself |

### Flag semantics — the exact flags the bootstrap passes

`useradd --system`, `useradd --no-create-home`, `useradd --shell`, `usermod --lock` — all
**SUPPORTED** (shadow-utils is common to both families).

### Live ACL behaviour — the class D-246 warns silently differs

This is the row that could not be answered by inspection, so it was **executed**:

- created a real system user with a nologin shell → uid 992
- `setfacl -m u:p304probe:rx` → **OK**; `getfacl` shows `user:p304probe:r-x` with `mask::r-x`
- `setfacl -d -m` (default/inherited ACL) → **OK**
- `runuser -u p304probe -- /bin/true` (explicit argv, nologin shell) → **OK**

⚠ **Scope of that evidence:** this ran in a *container* on an overlayfs. It proves the tooling and
mask semantics, **not** the on-disk behaviour of the real image filesystem. P-305 owns re-proving it
on a booted bootc host, and this result is a positive signal for P-305, not a substitute for it.

## C. sshd drop-in model

| Ubuntu | CentOS Stream 9 | Verified how |
|---|---|---|
| `/etc/ssh/sshd_config.d/60-papercusp-workspace.conf` | works unchanged | `/etc/ssh/sshd_config.d` exists; the shipped `sshd_config` carries `Include /etc/ssh/sshd_config.d/*.conf` **at line 15 of 130** — i.e. early, so drop-ins win. |

## D. Native SONAME providers — RE-DERIVED, never translated

The source comment forbids changing these without re-running the readelf union. Both halves were
re-run: the **needed set** from the r19 bundle's ELF headers, and the **providers** from the RPM
package DB (`dnf provides`).

| SONAME | Ubuntu apt provider | CentOS Stream 9 RPM provider | Needed by r19? |
|---|---|---|---|
| `libasound.so.2` | `libasound2t64` | `alsa-lib-1.2.13-1.el9` | **YES** |
| `libatomic.so.1` | `libatomic1` | `libatomic-11.5.0-7.el9` | **YES** |
| `libgcc_s.so.1` | `libgcc-s1` | `libgcc-11.5.0-7.el9` | **YES** |
| `libstdc++.so.6` | `libstdc++6` | `libstdc++-11.5.0-7.el9` | **YES** |
| `libssl.so.3` | `libssl3` | `openssl-libs-1:3.5.5-3.el9` | **no — bundle-internal** |
| `liblz4.so.1` | `liblz4-1` | `lz4-libs-1.9.3-5.el9` | **no — unused** |
| `libz.so.1` | `zlib1g` | `zlib-1.2.11-35.el9` | **no — unused** |
| `libzstd.so.1` | `libzstd1` | `libzstd-1.5.0-2.el9` | **no — unused** |

Every one has a real RPM provider, so the mapping ports cleanly whichever subset is kept.

### The re-derivation itself produced a finding — see §F

## E. glibc baseline

All 8 baseline SONAMEs (`ld-linux-x86-64.so.2`, `libc.so.6`, `libdl.so.2`, `libm.so.6`,
`libpthread.so.0`, `librt.so.1`, `libutil.so.1`, `libresolv.so.2`) are **PRESENT** in the base's
`ldconfig` cache. `ld-linux-aarch64.so.1` is the arm64 variant and was not probed on this x86_64
base.

## F. Finding: the apt package contract over-installs relative to what r19 actually needs

Derived from **all 83 ELF files** in the r19 bundle (executables included, not just `*.node`),
classifying each NEEDED SONAME against the bundle's own declared SONAMEs and the glibc baseline:

- **True external set is 4**: `libasound.so.2`, `libatomic.so.1`, `libgcc_s.so.1`, `libstdc++.so.6`.
- **Bundle-internal (24 declared SONAMEs)** include `libssl.so.3`, `libcrypto.so.3`, `libpq.so.5`,
  `libecpg.so.6`, `libecpg_compat.so.3`, `libpgtypes.so.3`, `libonnxruntime.so.1`,
  `libvips-cpp.so.8.18.6` — the bundle ships its own OpenSSL and Postgres client libraries.
- **Neither needed nor internal**: `liblz4.so.1`, `libz.so.1`, `libzstd.so.1`.

So `WORKSPACE_HOST_BOOTSTRAP_NATIVE_RUNTIME_APT_PACKAGES` installs **8** packages where **4** are
load-bearing for r19.

⛔ **This is REPORTED, NOT ACTED ON.** Do not trim the list on the strength of this table alone.
Over-installing is harmless; under-installing fails at *runtime on a customer VM*, which is the
expensive direction. Whether the other four are deliberate headroom (a future addon, a
`dlopen` that no ELF header can show) is a question this derivation **cannot** answer — `readelf`
sees link-time `DT_NEEDED` only, and a runtime `dlopen("libz.so.1")` is invisible to it. Establish
that before removing anything.

### Two instrument errors I hit, both in the under-reporting direction

Recorded because either would have produced a confident, wrong table:

1. **Filename ≠ SONAME.** Classifying bundle-internal libraries by *filename* reported `libpq.so.5`,
   `libecpg.so.6` and `libpgtypes.so.3` as external dependencies needing RPM packages. They are
   shipped in the bundle — `libpq.so.5.16` on disk *declares* SONAME `libpq.so.5`. Fix: read the ELF
   `SONAME` tag, never the filename.
2. **Scanning `*.node` and `*.so` only.** That missed the bundle's ELF **executables** and
   under-reported the external set as 3; `libasound.so.2` only appears once executables are
   included. Fix: scan every ELF in the bundle.

Both are the same shape — an instrument whose scope was narrower than the claim it was being used to
support, whose output looks complete either way.

## G. The three genuine substitutions

| Ubuntu package | Status on Stream 9 | Replacement | Verified how |
|---|---|---|---|
| `ufw` | **NOT-IN-REPOS** | `firewalld` (**AVAILABLE**) or `nftables` (**INSTALLED** in base) | `dnf list` |
| `unattended-upgrades` | **NOT-IN-REPOS** | `dnf-automatic` (**AVAILABLE**) | `dnf list` |
| `minisign` | **NOT-IN-REPOS** | ⚠ see below — the one hard gap | `dnf list` |

Not a substitution, but a gap this table's method missed: `git` was never in the apt contract,
because stock Ubuntu images ship it, yet the release's content bootstrap shallow-clones the
first-party bundle with it. The Stream 9 bootc image booted without git and the bootstrap died in
`install-runtime` with `spawn git ENOENT` (WI-10005779). `git` is now in the apt contract and the
image installs `git-core`; `bootc-guest-tool-contracts.test.ts` maps every apt contract package to
the RPM the Containerfile installs, so a new apt name without an RPM row fails there.

`ufw` and `unattended-upgrades` are behavioural rewrites, not package renames: the bootstrap emits
5 `ufw` invocations and enables `unattended-upgrades` as a unit, so P-306 must re-express both
policies, not substitute names.

### `minisign` is the load-bearing gap

It is not a convenience: minisign verifies the **release bundle signature**, and the bootstrap's
whole trust story (`signatureVerified: true` in the attestation) rests on it.

**Measured availability** (second probe, EPEL enabled on the base):

| tool | in base repos | in EPEL 9 |
|---|---|---|
| `minisign` | no | **YES — available** |
| `signify` | no | yes |
| `cosign` | no | **no — not in either** |
| `openssl`, `gnupg2` | — | yes |

That result cuts against the obvious recommendation, so state it plainly: **cosign is not a
`dnf install` answer either.** It ships as a Go binary from sigstore, not an RPM.

Routes, re-argued against the measurement:

1. **Let bootc verify the image itself — the strongest form of route 1.** A bootc host *is* an OCI
   artifact, and container signature verification is native to the podman/bootc policy mechanism
   (`policy.json` + sigstore). If the signed tarball bundle goes away with the migration, the
   bootstrap's minisign step goes away *with* it — no host-side verification binary of any kind.
   This is the only route where the gap dissolves instead of being filled, and it composes with
   **P-308**, which already plans cosign for signing/attestation at *build* time (where a Go binary
   is unproblematic). ⚠ Not free: it moves trust to the registry + policy configuration, which is a
   real design change, not a substitution.
2. **Add EPEL and keep minisign** — now known to *work*, and by far the smallest diff. Cost is
   widening the customer VM's trust base to a community repo for one tool. Viable as an interim if
   the bundle format survives the migration.
3. **Vendor the minisign binary into the signed bundle** — circular for the bundle's own
   verification (verifying the bundle with a tool from inside it), so viable only for a
   *second-stage* artifact, never the first.

Whichever route is chosen, this is a **cross-lane ruling** — it changes P-306's bootstrap, P-308's
supply chain, and the attestation's `signatureVerified` semantics — so it belongs to a Decision, not
to whoever reaches P-306 first.

## Artifacts

- Derivation instrument: `papercusp/.papercusp/scratch/p304-derive-assumptions.ts`
- Verification probe: `~/.papercusp/p304/verify-rpm-equivalents.sh`
- Raw probe output: `~/.papercusp/p304/rpm-equivalents.out`
- Derived SONAME sets: `~/.papercusp/p304/{needed-all-elf,soname-all-elf,external-sonames-final}.txt`
