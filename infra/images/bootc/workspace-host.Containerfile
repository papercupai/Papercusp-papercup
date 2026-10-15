# P-306 — the PRODUCT workspace-host bootc image (OS layer).
#
# This is the port. It replaces the `harden-os` phase of the generated bootstrap
# (`libs/generic/deployment-driver/src/workspace-host-bootstrap.ts`) — the
# `apt-get update` + `apt-get install` + `useradd` + `ufw` + `unattended-upgrades`
# sequence — with image layers.
#
# ⛔ NOT the P-303 spike. `Containerfile` in this directory is the frozen gate-spike
#    artifact that booted on real GCP; it is byte-identical to the copy that booted
#    and must stay that way. This file is written ALONGSIDE it, deliberately.
#
# ── Where the package set comes from ──────────────────────────────────────────
# `RPM-EQUIVALENCE.md` in this directory, which is a RE-DERIVATION from the RPM
# package DB (`dnf provides`) against this exact base — not a translation of the
# apt names. `WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES`' own comment forbids
# translating that list by guesswork, and the SONAME half of it is a readelf union
# over the release bundle. Every name below traces to a row in that table.
#
# Re-verify the table against the live base before editing this list:
#   sudo -n podman run --rm -i --entrypoint /bin/bash \
#     quay.io/centos-bootc/centos-bootc:stream10 -s < verify-rpm-equivalents.sh
# (the `-i` is load-bearing: without it the container exits 0 having run NOTHING.)
#
# ── What is NOT here, and why ─────────────────────────────────────────────────
# The three machine-local roots, workspace ACL, and sshd drop-in are applied ON
# EVERY BOOT by `papercusp-host-prepare.service`, not baked. `/srv` and `/home`
# are symlinks into machine-local `/var` on this base. The immutable `/opt`
# runtime is the opposite: POSIX ACL xattrs do not survive a container commit
# (WI-2143115), and the first real P-305 boot proved `/opt` cannot be mutated at
# boot. D-314 therefore bakes its access as ordinary group ownership and makes
# host prepare verify that metadata without writing to `/opt`.

FROM quay.io/centos-bootc/centos-bootc:stream10 AS workspace-host-os

# The image records the base it was built FROM, because a BOOTED host cannot
# otherwise answer that question about itself: `bootc status` reports the ref
# the host booted (this image), never what that image derives from, and image
# LABELs need a local copy of the image to inspect. Writing it under /usr makes
# it image content — read-only on a running bootc host, replaced atomically by
# an upgrade — so the attested `bootc-base-image` check is reading a fact the
# image carries rather than one the host was told.
ARG PAPERCUSP_BASE_IMAGE=quay.io/centos-bootc/centos-bootc:stream10
RUN install -d -m 0755 /usr/lib/papercusp \
 && printf '%s\n' "${PAPERCUSP_BASE_IMAGE}" > /usr/lib/papercusp/base-image \
 && chmod 0644 /usr/lib/papercusp/base-image

# Identity names are BUILD-TIME on the bootc model, where the generated bootstrap
# took them as per-host input. An image is one artifact shared by every host, so
# the names it bakes are fixed for all of them; a per-host name would have to be
# applied after deploy, which defeats the point of baking the identities at all.
# These defaults mirror DEFAULT_WORKSPACE_HOST_{SERVICE,WORKSPACE,AGENT}_USER.
ARG PAPERCUSP_SERVICE_USER=papercusp
ARG PAPERCUSP_SERVICE_GROUP=papercusp
ARG PAPERCUSP_WORKSPACE_USER=papercusp-workspace
ARG PAPERCUSP_WORKSPACE_GROUP=papercusp-workspace
ARG PAPERCUSP_AGENT_USER=papercusp-agent
ARG PAPERCUSP_AGENT_GROUP=papercusp-agent
ARG PAPERCUSP_RUNTIME_READ_GROUP=papercusp-runtime-read

# ── Layer 1: packages ─────────────────────────────────────────────────────────
#
# Replaces:
#   apt-get install -y --no-install-recommends $WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES
#
# `--setopt=install_weak_deps=False` is the dnf analogue of `--no-install-recommends`.
# Without it the two are not equivalent and the image silently gains a large
# recommends closure.
#
# EPEL carries exactly ONE package here: minisign. It is a TRANSITIONAL trust
# widening, not a permanent dependency — D-262 condition 4 forbids removing
# minisign until P-306 AND P-308 have both landed, because the bootstrap's whole
# trust story (`signatureVerified: true` in the attestation) rests on it and
# removing it first yields a host that verifies nothing while still attesting
# that it did. When P-308's registry signing is live and the tarball path is
# retired, minisign AND this EPEL repo are removed together, in that order.
# `cosign` is deliberately NOT the substitute here: it is not in base repos or
# EPEL (measured, RPM-EQUIVALENCE.md §G) — it is a Go binary used at BUILD time
# by P-308, which is a different machine and a different trust question.
#
# A raw bootc disk is a CUSTOM GCE image, not one of Google's managed CentOS
# images. It therefore does not inherit the Compute Engine guest environment:
# without the guest agent plus OS Login NSS/PAM modules, the VM reaches RUNNING
# and sshd listens, but `enable-oslogin=TRUE` can never authenticate a user.
# P-305 measured exactly that silent 15-minute failure. Install Google's
# maintained EL10 metapackage into the one signed image so the capability also
# survives bootc upgrade/rollback; patching only the rendered GCE disk would
# disappear on the first signed switch and violate P-307's one-image seam.
#
# Keep the provider repository disabled at runtime. On an image-based host OS
# packages advance only through a newly built, signed bootc image; dnf-automatic
# must not mutate /usr behind bootc's back. The metapackage deliberately omits
# google-osconfig-agent: OS Config is a separate VM Manager surface and is not
# required for the guest-agent-owned OS Login path exercised here.
#
# Two build-host traps are load-bearing here:
#   * google-compute-engine's %post runs bare `dracut --force`, which targets
#     `uname -r` (the CONTAINER HOST kernel) rather than this image's kernel.
#     Install its runtime dependencies with their normal scriptlets, suppress
#     only that metapackage scriptlet, then regenerate every IMAGE initramfs
#     explicitly and prove the GCE udev rule reached it.
#   * Buildah 1.33 on the supported builder uses fuse-overlayfs and its layer
#     diff loses in-place rewrites of the RPM SQLite DB and initramfs. The files
#     look correct inside RUN, then revert after COMMIT. Replace both with fresh
#     inodes in this same layer; the P-306 probe checks the committed image.
COPY papercusp-google-oslogin.conf /usr/lib/tmpfiles.d/papercusp-google-oslogin.conf
# GCE transport is skipped off GCE, as amazon-ssm-agent is off EC2 (WI-10005618).
COPY papercusp-google-guest-agent-gce-only.conf /usr/lib/systemd/system/google-guest-agent.service.d/papercusp-gce-only.conf
# AWS transport (WI-10005605): amazon-ssm-agent is the session/command channel the AWS
# provider and its connection profile require. AWS ships it as a standalone signed RPM,
# not from a dnf repository, so it is pinned by VERSION and by the SHA-256 of the exact
# bytes (measured 2026-10-02 from the HTTPS endpoint below; RPM header signed with AWS
# key id 88d19d46). Bumping the version means re-measuring the digest; a mismatch
# fails the build instead of baking unverified bytes. The drop-in skips the unit off
# EC2 and the tmpfiles entry replaces the RPM's /var/lib/amazon/ssm (see each file).
ARG AMAZON_SSM_AGENT_VERSION=3.3.5390.0
ARG AMAZON_SSM_AGENT_RPM_SHA256=85369679511b67f8f01824043ae17a679b6f21edd78229ccd1d5acd6c347f82f
COPY papercusp-amazon-ssm-agent-ec2-only.conf /usr/lib/systemd/system/amazon-ssm-agent.service.d/papercusp-ec2-only.conf
COPY papercusp-amazon-ssm-agent.tmpfiles.conf /usr/lib/tmpfiles.d/papercusp-amazon-ssm-agent.conf
# Azure transport/provisioning (WI-10005639): Stream 10's WALinuxAgent unit
# carries ConditionVirtualization=|microsoft, so systemd runs it only on Azure.
# Order its provisioning after the identities and roots created at every boot.
# Repository metadata changes independently of this source. Each bake supplies a
# fresh key so an old cached dnf upgrade cannot stand in for today's vendor fixes.
ARG PAPERCUSP_VENDOR_REFRESH
RUN set -eux; \
    test -n "$PAPERCUSP_VENDOR_REFRESH"; \
    printf '%s\n' \
      '[google-compute-engine]' \
      'name=Google Compute Engine' \
      'baseurl=https://packages.cloud.google.com/yum/repos/google-compute-engine-el10-x86_64-stable' \
      'enabled=0' \
      'gpgcheck=1' \
      'repo_gpgcheck=0' \
      'gpgkey=https://packages.cloud.google.com/yum/doc/rpm-package-key-v10.gpg' \
      `# EL10's rpm (sequoia) rejects rpm-package-key.gpg (F09C394C3E1BA8D5): its only binding` \
      `# signature is SHA-1, so dnf failed "Key import failed (code 3)" on google-guest-agent` \
      `# (WI-10005910 chain4, 2026-10-03). The el10 repo is signed by the v10 key (b64936f9).` \
      > /etc/yum.repos.d/google-cloud.repo; \
    dnf -y install --setopt=install_weak_deps=False epel-release; \
    `# Upgrade the BASE before installing (WI-10005681). dnf install never touches a package` \
    `# the base already carries, so without this the image ships whatever the base digest` \
    `# pinned: the P-012 AWS bake failed its trust report on 102 fixed high/critical findings` \
    `# in base packages (openssl, libevent, sqlite-libs, podman, skopeo, ...) for which newer` \
    `# Stream 9 builds were already published.` \
    dnf -y upgrade --refresh --setopt=install_weak_deps=False; \
    dnf -y install --setopt=install_weak_deps=False \
         --enablerepo=google-compute-engine \
         `# system packages — WORKSPACE_HOST_BOOTSTRAP_SYSTEM_APT_PACKAGES` \
         acl \
         `# Codex's sandbox runs every tool command through bwrap. Stream 9 has no AppArmor` \
         `# userns restriction, so the package is the whole fix here; the bootstrap's` \
         `# agent-sandbox-userns check proves it on the booted host (WI-10004636).` \
         bubblewrap \
         ca-certificates \
         curl \
         dracut \
         `# git <- the release's content bootstrap shallow-clones the first-party bundle with` \
         `# git (offline-content-bundle-install-io.ts gitCloneShallow). Stock Ubuntu ships git,` \
         `# so the apt contract never had to name it; Stream 9 bootc does not (WI-10005779).` \
         git-core \
         `# Keep the OS Login RPM scriptlets enabled: %post also enables its cache timer,` \
         `# refreshes the linker cache and labels OS Login paths. Its semodule install` \
         `# is retried against the booted host policy store by papercusp-host-prepare.` \
         google-compute-engine-oslogin \
         google-guest-agent \
         jq \
         nvme-cli \
         openssh-server \
         rsyslog \
         WALinuxAgent \
         sudo \
         shadow-utils \
         policycoreutils \
         `# ufw is NOT-IN-REPOS; nftables replaces it (see layer 4)` \
         nftables \
         `# unattended-upgrades is NOT-IN-REPOS; dnf-automatic replaces it (layer 5)` \
         dnf-automatic \
         `# minisign is NOT-IN-REPOS; EPEL 10 carries it (see note above)` \
         minisign \
         `# the bootstrap apt-get installs zstd ON DEMAND at runtime because stock` \
         `# Ubuntu ships no unzstd. Baking it removes that imperative install.` \
         zstd \
         `# native SONAME providers — WORKSPACE_HOST_BOOTSTRAP_NATIVE_RUNTIME_APT_PACKAGES,` \
         `# mapped through RPM-EQUIVALENCE.md §D. All 8 are kept: §F measured that only 4` \
         `# are load-bearing for r19 but explicitly refuses to act on that, because readelf` \
         `# sees link-time DT_NEEDED only and a runtime dlopen() is invisible to it.` \
         `# Over-installing is harmless; under-installing fails on a customer VM.` \
         alsa-lib      `# libasound.so.2  <- libasound2t64` \
         libatomic     `# libatomic.so.1  <- libatomic1` \
         libgcc        `# libgcc_s.so.1   <- libgcc-s1` \
         libstdc++     `# libstdc++.so.6  <- libstdc++6` \
         openssl-libs  `# libssl.so.3     <- libssl3` \
         lz4-libs      `# liblz4.so.1     <- liblz4-1` \
         `# EL10 ships libz.so.1 from zlib-ng in compat mode; the EL9 'zlib' name is gone (WI-10005910).` \
         zlib-ng-compat `# libz.so.1      <- zlib1g` \
         libzstd       `# libzstd.so.1    <- libzstd1` \
    && dnf -y install --setopt=install_weak_deps=False \
         --setopt=tsflags=noscripts \
         --enablerepo=google-compute-engine \
         google-compute-engine \
    && curl -fsSL --retry 3 -o /tmp/amazon-ssm-agent.rpm \
         "https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/${AMAZON_SSM_AGENT_VERSION}/linux_amd64/amazon-ssm-agent.rpm" \
    && printf '%s  %s\n' "$AMAZON_SSM_AGENT_RPM_SHA256" /tmp/amazon-ssm-agent.rpm | sha256sum -c - \
    && dnf -y install --setopt=install_weak_deps=False /tmp/amazon-ssm-agent.rpm \
    && rm -f /tmp/amazon-ssm-agent.rpm \
    && test "$(rpm -q --qf '%{VERSION}' amazon-ssm-agent)" = "$AMAZON_SSM_AGENT_VERSION" \
    && found_kernel=0 \
    && for modules_dir in /usr/lib/modules/*; do \
         test -d "$modules_dir" || continue; \
         found_kernel=$((found_kernel + 1)); \
         kernel_version="${modules_dir##*/}"; \
         initramfs="$modules_dir/initramfs.img"; \
         test -f "$initramfs"; \
         rebuilt="$(mktemp /tmp/papercusp-initramfs.XXXXXX.img)"; \
         listing="$(mktemp /tmp/papercusp-initramfs.XXXXXX.list)"; \
         dracut --force "$rebuilt" "$kernel_version"; \
         lsinitrd "$rebuilt" > "$listing"; \
         grep -Fq '65-gce-disk-naming.rules' "$listing"; \
         mode="$(stat -c %a "$initramfs")"; \
         rm -f "$initramfs"; \
         install -m "$mode" "$rebuilt" "$initramfs"; \
         rm -f "$rebuilt" "$listing"; \
       done \
    && test "$found_kernel" -gt 0 \
    && rpm -q google-compute-engine google-compute-engine-oslogin google-guest-agent \
    && rpm -q WALinuxAgent WALinuxAgent-udev azure-vm-utils \
    && grep -Fqx 'ConditionVirtualization=|microsoft' /usr/lib/systemd/system/waagent.service \
    && grep -Fxq 'Provisioning.Agent=auto' /etc/waagent.conf \
    && systemctl enable google-guest-agent.service google-oslogin-cache.timer \
    && systemctl enable waagent.service \
    && systemctl enable amazon-ssm-agent.service \
    && dnf clean all \
    `# Scrub dnf/subscription-manager residue from /var and /run.` \
    `# Not tidiness. bootc container lint fails three separate checks on it` \
    `# (var-log, var-tmpfiles, nonempty-run-tmp) and the reason is structural:` \
    `# /var is MACHINE-LOCAL state on a bootc host, seeded once, so image content` \
    `# there is not image content in any useful sense — it is either discarded or` \
    `# it shadows the host's own state. A dnf repo cache baked into /var/lib/dnf is` \
    `# the "looks present, is not deployed" class this port keeps running into.` \
    && rm -rf /var/cache/dnf /var/lib/dnf /var/google-users.d /var/lib/amazon \
              /var/log/dnf.* /var/log/hawkey.log \
              /var/log/rhsm /var/lib/rhsm /run/rhsm /var/cache/ldconfig \
    && test "$(rpm --eval '%{_dbpath}')" = /usr/share/rpm \
    && python3 -c 'import sqlite3; db = sqlite3.connect("/usr/share/rpm/rpmdb.sqlite"); result = db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone(); db.close(); assert result[0] == 0, result' \
    && cp --reflink=never /usr/share/rpm/rpmdb.sqlite /tmp/papercusp-rpmdb.sqlite \
    && rm -f /usr/share/rpm/rpmdb.sqlite \
              /usr/share/rpm/rpmdb.sqlite-shm \
              /usr/share/rpm/rpmdb.sqlite-wal \
    && install -m 0644 /tmp/papercusp-rpmdb.sqlite /usr/share/rpm/rpmdb.sqlite \
    && rm -f /tmp/papercusp-rpmdb.sqlite \
    && rpm -q minisign dnf-automatic alsa-lib libatomic git-core \
              google-compute-engine google-compute-engine-oslogin google-guest-agent \
              amazon-ssm-agent

# WALinuxAgent's upgrade scriptlet removes its service drop-in directory, so
# copy our ordering edge only after the DNF upgrade/install transaction above.
COPY papercusp-waagent-host-prepare.conf /usr/lib/systemd/system/waagent.service.d/papercusp-host-prepare.conf

# ── Layer 2: the three identities (D-043 / D-248 / D-251) ─────────────────────
#
# Replaces the groupadd/useradd/usermod block of `harden-os` with a sysusers.d
# declaration. See `papercusp-sysusers.conf` for why the uid/gid numbers are
# PINNED there rather than allocated by `useradd` — in short, `useradd` counts
# down from 999 in package install order, `/var` persists across `bootc upgrade`
# while `/etc/passwd` comes from the image, and a renumbering upgrade therefore
# orphans the agent's credential home while every signal still reads healthy.
#
# The third identity is the load-bearing one: it exists so exactly one account
# both reads the signed runtime and holds the agent credentials, and that account
# is NOT the customer's SSH login. Do not collapse it back into the workspace user
# — that is the D-246 regression D-248 exists to undo.
#
# `systemd-sysusers` is invoked explicitly so the entries exist in THIS image
# rather than only on first boot; the file stays in /usr/lib/sysusers.d so systemd
# also re-applies it on the deployed host.
#
# The `if` guards assert the two memberships the bootstrap REFUSES, so a bad edit
# fails the BUILD instead of shipping a host with the isolation contract quietly
# inverted. $SERVICE_GROUP would hand the agent runtime $STATE_ROOT (embedded PG
# plus every delivered credential); $WORKSPACE_GROUP would let the SSH account
# reach the agent's 0700 credential home through the group bits.
#
# ⚠ That is why this block carries no inline `# …` shell comments the way layer 1
# does. A Containerfile RUN collapses to ONE line, so a backtick-comment is a
# command substitution expanding to nothing — harmless between words in a package
# list, but placed before a compound statement it leaves `<empty> if …` with no
# separator and the shell fails to parse. Keep prose for this layer up here.
COPY papercusp-sysusers.conf /usr/lib/sysusers.d/papercusp.conf
RUN set -eux; \
    systemd-sysusers /usr/lib/sysusers.d/papercusp.conf; \
    getent passwd "$PAPERCUSP_SERVICE_USER" "$PAPERCUSP_WORKSPACE_USER" "$PAPERCUSP_AGENT_USER"; \
    getent group "$PAPERCUSP_RUNTIME_READ_GROUP"; \
    test "$(id -u "$PAPERCUSP_SERVICE_USER")"   = 910; \
    test "$(id -g "$PAPERCUSP_SERVICE_USER")"   = 910; \
    test "$(id -u "$PAPERCUSP_AGENT_USER")"     = 911; \
    test "$(id -g "$PAPERCUSP_AGENT_USER")"     = 911; \
    test "$(id -u "$PAPERCUSP_WORKSPACE_USER")" = 1500; \
    test "$(id -g "$PAPERCUSP_WORKSPACE_USER")" = 1500; \
    test "$(getent group "$PAPERCUSP_RUNTIME_READ_GROUP" | cut -d: -f3)" = 912; \
    id -nG "$PAPERCUSP_SERVICE_USER" | tr ' ' '\n' | grep -Fx "$PAPERCUSP_RUNTIME_READ_GROUP"; \
    id -nG "$PAPERCUSP_AGENT_USER" | tr ' ' '\n' | grep -Fx "$PAPERCUSP_RUNTIME_READ_GROUP"; \
    if id -nG "$PAPERCUSP_WORKSPACE_USER" | tr ' ' '\n' | grep -Fx "$PAPERCUSP_SERVICE_GROUP"; then \
      echo 'FATAL: workspace SSH user must not belong to the runtime service group' >&2; exit 1; \
    fi; \
    if id -nG "$PAPERCUSP_AGENT_USER" | tr ' ' '\n' | grep -Fx "$PAPERCUSP_SERVICE_GROUP"; then \
      echo 'FATAL: agent user must not belong to the runtime service group' >&2; exit 1; \
    fi; \
    if id -nG "$PAPERCUSP_WORKSPACE_USER" | tr ' ' '\n' | grep -Fx "$PAPERCUSP_RUNTIME_READ_GROUP"; then \
      echo 'FATAL: workspace SSH user must not belong to the immutable runtime-read group' >&2; exit 1; \
    fi

# ── Layer 3: the container signature policy (D-262 condition 1) ───────────────
#
# `release-signature-policy.json` is PROVEN enforced and fail-closed on this base
# (D-279: paired probe, signed ACCEPT / unsigned REJECT / base-default ACCEPT).
# This layer is what puts it on the host, which is the half that was missing —
# the policy existed as an artifact and was installed nowhere.
#
# It is a TEMPLATE and it fails CLOSED: `<RELEASE_REGISTRY_NAMESPACE>` is P-307's
# to establish and `/etc/pki/papercusp/release-signing.pub` is populated from the
# public half of P-308's signing key. A specialised build refuses to proceed unless
# both are present; an unspecialised build keeps the non-matching namespace and no
# key, so it refuses a release rather than accepting an unsigned one.
# ⛔ The policy is INERT WITHOUT the registries.d fragment beside it (D-287). On the
# docker: transport containers/image does not LOOK for a cosign signature unless the
# registry carries `use-sigstore-attachments: true`, and without it a correctly signed
# image is refused with the SAME message an unsigned one gets ("A signature was
# required, but no signature exists"). Fail-closed, and totally opaque. Ship both.
#
# P-307 substitutes `<RELEASE_REGISTRY_NAMESPACE>` HERE, at build time, from a build arg —
# the files stay templates in the repo so the DEFAULT build still fails closed exactly as
# D-262 condition 1 requires (and `p306-image-build-probe.sh` still asserts the placeholder
# survives an unparameterised build).
#
# MEASURED by `p307-registries-d-scope-probe.sh` (2026-09-04), which decides the two rules
# below. Both were open questions this layer used to get wrong:
#
#   * ONE STRING SERVES BOTH FILES. containers-registries.d(5) keys accept the same scope
#     ladder policy.json uses — the probe accepted a repository path (A), a repository
#     namespace (A2) and a bare host (B). The claim previously carried in
#     release-registries.d.yaml, that this file "takes only the host part", is FALSE, and
#     acting on it would have split one value across two files for no reason.
#   * THE PORT IS PART OF THE SCOPE. A port-less hostname does NOT match a registry reached
#     on an explicit port (probe D) — and the resulting refusal is BYTE-IDENTICAL to the
#     unsigned-image message ("A signature was required, but no signature exists"). So a
#     value that drops a non-default port produces an image that cannot pull its own
#     release and blames the signature for it. Pass the port if the registry uses one.
#
# The substitution is all-or-nothing across BOTH files. A half-substituted image is the
# worst outcome available here: the policy would name the real registry while registries.d
# still named the placeholder, so containers/image would never look for the attachment and
# would refuse every upgrade with that same unsigned-looking string. Checking it at BUILD
# time turns an opaque runtime failure into a loud one.
ARG RELEASE_REGISTRY_NAMESPACE=
ARG RELEASE_STORAGE_DRIVER=
ARG RELEASE_SIGNING_PUBKEY_B64=
COPY release-signature-policy.json /etc/containers/policy.json
COPY release-registries.d.yaml /etc/containers/registries.d/papercusp-release.yaml
RUN set -eu; \
    POL=/etc/containers/policy.json; \
    RD=/etc/containers/registries.d/papercusp-release.yaml; \
    PUB=/etc/pki/papercusp/release-signing.pub; \
    install -d -m 0755 /etc/pki/papercusp; \
    if [ -n "${RELEASE_REGISTRY_NAMESPACE}" ]; then \
      case "${RELEASE_REGISTRY_NAMESPACE}" in \
        *'<'*|*'>'*|*' '*|*'"'*) \
          echo "FATAL: RELEASE_REGISTRY_NAMESPACE='${RELEASE_REGISTRY_NAMESPACE}' is not a registry scope" >&2; exit 1;; \
        */) echo "FATAL: RELEASE_REGISTRY_NAMESPACE must not end in '/'" >&2; exit 1;; \
        *.*|*:*|localhost*) ;; \
        *) echo "FATAL: RELEASE_REGISTRY_NAMESPACE='${RELEASE_REGISTRY_NAMESPACE}' has no registry host — a bare repository name is not a scope" >&2; exit 1;; \
      esac; \
      case "${RELEASE_STORAGE_DRIVER}" in \
        ''|*[!A-Za-z0-9_-]*) echo "FATAL: RELEASE_STORAGE_DRIVER is required and must name one containers/storage graph driver" >&2; exit 1;; \
      esac; \
      [ -n "${RELEASE_SIGNING_PUBKEY_B64}" ] || { \
        echo "FATAL: RELEASE_SIGNING_PUBKEY_B64 is required when RELEASE_REGISTRY_NAMESPACE is set" >&2; exit 1; }; \
      sed -i "s|<RELEASE_REGISTRY_NAMESPACE>|${RELEASE_REGISTRY_NAMESPACE}|g" "$POL" "$RD"; \
      CS_SCOPE="[${RELEASE_STORAGE_DRIVER}@/var/lib/containers/storage]${RELEASE_REGISTRY_NAMESPACE}"; \
      OSBUILD_CS_SCOPE='[overlay@/run/osbuild/containers/storage2]'; \
      POL_TMP="$(mktemp)"; \
      jq --arg scope "$CS_SCOPE" --arg osbuild_scope "$OSBUILD_CS_SCOPE" \
        '.transports["containers-storage"] = { \
          ($scope): [{"type":"insecureAcceptAnything"}], \
          ($osbuild_scope): [{"type":"insecureAcceptAnything"}] \
        }' \
        "$POL" > "$POL_TMP"; \
      cp -f "$POL_TMP" "$POL"; \
      rm -f "$POL_TMP"; \
      jq -e --arg scope "$CS_SCOPE" \
        '.transports["containers-storage"][$scope][0].type == "insecureAcceptAnything"' \
        "$POL" >/dev/null || { echo "FATAL: scoped containers-storage policy was not installed" >&2; exit 1; }; \
      jq -e --arg scope "$OSBUILD_CS_SCOPE" \
        '.transports["containers-storage"][$scope][0].type == "insecureAcceptAnything"' \
        "$POL" >/dev/null || { echo "FATAL: osbuild private-store policy was not installed" >&2; exit 1; }; \
      printf '%s' "${RELEASE_SIGNING_PUBKEY_B64}" | base64 -d > "$PUB" \
        || { echo "FATAL: RELEASE_SIGNING_PUBKEY_B64 is not valid base64" >&2; exit 1; }; \
      [ -s "$PUB" ] && openssl pkey -pubin -in "$PUB" -noout >/dev/null 2>&1 \
        || { echo "FATAL: RELEASE_SIGNING_PUBKEY_B64 does not encode a valid public key" >&2; exit 1; }; \
      chmod 0644 "$PUB"; \
      for f in "$POL" "$RD"; do \
        if grep -qF '<RELEASE_REGISTRY_NAMESPACE>' "$f"; then \
          echo "FATAL: placeholder survived substitution in $f" >&2; exit 1; \
        fi; \
        if ! grep -qF "${RELEASE_REGISTRY_NAMESPACE}" "$f"; then \
          echo "FATAL: $f does not name the release registry after substitution" >&2; exit 1; \
        fi; \
      done; \
      install -d -m 0755 /usr/lib/papercusp; \
      printf '%s\n' "${RELEASE_REGISTRY_NAMESPACE}" > /usr/lib/papercusp/release-registry-namespace; \
    else \
      if [ -n "${RELEASE_STORAGE_DRIVER}" ] || [ -n "${RELEASE_SIGNING_PUBKEY_B64}" ]; then \
        echo "FATAL: release storage driver/public key require RELEASE_REGISTRY_NAMESPACE" >&2; exit 1; \
      fi; \
      for f in "$POL" "$RD"; do \
        grep -qF '<RELEASE_REGISTRY_NAMESPACE>' "$f" || { \
          echo "FATAL: $f lost its fail-closed placeholder without a substitution value" >&2; exit 1; }; \
      done; \
    fi; \
    chmod 0644 "$POL" "$RD"

# ── Layer 4: firewall — ufw is NOT-IN-REPOS, nftables replaces it ─────────────
#
# The bootstrap's five ufw invocations are a POLICY, not a package name, so this
# is a behavioural rewrite (RPM-EQUIVALENCE.md §G says so explicitly). The policy
# being reproduced, verbatim from `harden-os`:
#     ufw default deny incoming
#     ufw default allow outgoing
#     ufw allow 22/tcp
#     ufw --force enable
#
# nftables over firewalld, deliberately: nftables is already INSTALLED in the base
# (firewalld is only AVAILABLE), it needs no dbus/polkit running, and it takes a
# declarative ruleset file — which is the right shape for an immutable image,
# where a sequence of imperative `firewall-cmd` calls has nowhere correct to run.
# The established connection clause is not in the ufw list because ufw supplies it
# implicitly; stated explicitly here, a default-deny input chain without it drops
# the replies to the host's own outbound traffic and the host is unreachable.
#
# ⚠ The ruleset is NOT syntax-checked here, and cannot be: `nft --check` still
# initializes a netlink cache, which the build sandbox denies
# (`cache initialization failed: Operation not permitted`) — a build container has
# no CAP_NET_ADMIN. Requiring `podman build --cap-add=NET_ADMIN` would push that
# onto P-307's pipeline as an easily-forgotten flag.
#
# It is checked in TWO places instead, and the second is the one that matters:
#   * `p306-image-build-probe.sh` runs `nft --check` with a negative control, so a
#     malformed ruleset fails the probe;
#   * `papercusp-host-prepare.sh` asserts on the BOOTED host that the table is
#     actually loaded.
# The boot-time assertion is not redundant. If nftables.service fails to start,
# a default-deny design does not fail closed — it loads NO rules at all and the
# host is wide open, while sshd and the service still come up healthy. Syntax was
# never the risk worth guarding; "the rules are absent" is.
COPY papercusp-firewall.nft /etc/nftables/papercusp-workspace-host.nft
RUN set -eux; \
    NFTABLES_CONFIG=/etc/sysconfig/nftables.conf; \
    NFTABLES_CONFIG_TMP="$(mktemp --tmpdir=/etc/sysconfig .nftables.conf.XXXXXX)"; \
    printf 'include "/etc/nftables/papercusp-workspace-host.nft"\n' \
      > "$NFTABLES_CONFIG_TMP"; \
    chmod 0600 "$NFTABLES_CONFIG_TMP"; \
    mv -f -- "$NFTABLES_CONFIG_TMP" "$NFTABLES_CONFIG"; \
    [ "$(cat "$NFTABLES_CONFIG")" = 'include "/etc/nftables/papercusp-workspace-host.nft"' ]; \
    systemctl enable nftables.service

# ── Layer 5: unattended security updates ──────────────────────────────────────
#
# Replaces `systemctl enable --now unattended-upgrades.service`.
#
# ⚠ Scope narrowed on purpose, and this is a real behavioural difference from the
# Ubuntu host rather than a rename. On a bootc host the OS is an image: applying
# package updates in place would write to `/usr`, which is read-only, and would
# put the running system out of step with the image it claims to be. The OS half
# of "unattended upgrades" belongs to `bootc upgrade` (the update path this port
# introduces), not to dnf. dnf-automatic is configured for DOWNLOAD-ONLY so that
# metadata and the security feed stay warm without mutating the deployment.
RUN set -eux; \
    sed -i 's/^upgrade_type *=.*/upgrade_type = security/' /etc/dnf/automatic.conf; \
    sed -i 's/^download_updates *=.*/download_updates = yes/' /etc/dnf/automatic.conf; \
    sed -i 's/^apply_updates *=.*/apply_updates = no/'       /etc/dnf/automatic.conf; \
    grep -q '^apply_updates = no' /etc/dnf/automatic.conf; \
    systemctl enable dnf-automatic.timer

# ── Layer 6: per-boot host preparation ────────────────────────────────────────
#
# Everything that CANNOT be baked. See `papercusp-host-prepare.sh` for what and why.
#
# ⚠ It runs on EVERY boot, not just the first, and that is not belt-and-braces.
# After a `bootc upgrade` the host reboots into a NEW deployment root, so the
# ACLs applied to `/opt/papercusp` are gone with the deployment that carried
# them — while `/var` and `/srv` state persists. A once-only unit would leave
# every host that ever takes an update with an unreadable runtime root, and the
# update path is the whole point of this port.
COPY papercusp-host-prepare.sh /usr/libexec/papercusp/host-prepare.sh
COPY papercusp-host-prepare.service /usr/lib/systemd/system/papercusp-host-prepare.service
RUN chmod 0755 /usr/libexec/papercusp/host-prepare.sh \
    && systemctl enable papercusp-host-prepare.service

# ── Layer 7: runtime root ─────────────────────────────────────────────────────
#
# `/opt` is a REAL directory on this base while `/srv` and `/home` are symlinks
# into machine-local `/var` (measured 2026-09-04). That is the "new model" the
# base's own tmpfiles dropin describes, in which OSTree commit content is allowed
# in `/opt` — and it is what makes baking the release tree here possible at all.
#
# ⚠ NOT PROVEN AT CONTAINER LEVEL, and the first-boot unit asserts it rather than
# assuming it: that same dropin
# (`/usr/lib/tmpfiles.d/rpm-ostree-0-integration-opt-usrlocal.conf`) says in its
# own comment that it "implements the old model", where `/opt` is a link to
# `/var/opt`. If the deployed host resolves `/opt` to machine-local storage, a
# release tree baked here is simply ABSENT after deploy — and every container-level
# signal, this build included, still reads healthy. That is the same shape as
# WI-2143115 (ACLs silently dropped by the container commit). The booted
# assertion belongs to P-305, which already has to boot a VM for D-279's
# `bootc upgrade` refusal.
RUN install -d -o root -g "$PAPERCUSP_RUNTIME_READ_GROUP" -m 0750 \
      /opt/papercusp /opt/papercusp/releases

# ── Layer 8: /usr/local is machine-local (WI-10005830) ────────────────────────
#
# On this base `/usr/local` is a real directory inside `/usr` (MEASURED
# 2026-10-03: `ls -ld /usr/local` in quay.io/centos-bootc/centos-bootc:stream9 is
# a directory, not a link), so it is read-only on a booted host. The workspace-host
# bootstrap installs into it at runtime — the privileged SSH conduits, native OMP,
# the ollama runtime and the customer agent toolchain — and the first AWS clean
# room to get past install-runtime died there:
#   install: cannot create regular file '/usr/local/bin/papercusp-workspace-host-initialize': Read-only file system
# Linking it to machine-local `/var/usrlocal` is the traditional OSTree layout; the
# base's own `rpm-ostree-0-integration-opt-usrlocal.conf` already creates
# `/var/usrlocal` for it, and papercusp-usrlocal.conf creates the subdirectories.
# The bootstrap's validate-host phase asserts this link before its first write
# (WORKSPACE_HOST_BOOTC_USR_LOCAL_TARGET).
#
# The base's `/usr/local` holds only empty directories from the `filesystem` RPM.
# Refuse to build if anything earlier in this file put a FILE there: removing it
# would silently drop that content from the image.
COPY papercusp-usrlocal.tmpfiles.conf /usr/lib/tmpfiles.d/papercusp-usrlocal.conf
RUN set -eu; \
    leftover="$(find /usr/local -mindepth 1 -not -type d -print -quit)"; \
    if [ -n "$leftover" ]; then echo "refusing to replace /usr/local: it carries image content ($leftover)" >&2; exit 1; fi; \
    rm -rf /usr/local; \
    ln -s ../var/usrlocal /usr/local; \
    [ "$(readlink /usr/local)" = ../var/usrlocal ]

# ── Lint ──────────────────────────────────────────────────────────────────────
# `bootc container lint` validates that this image can actually be deployed as a
# host (kernel + bootloader shape, ostree-incompatible layout). It catches the
# common errors at BUILD time rather than at install time on a customer VM.
RUN bootc container lint

# ── Optional P-305 release layer ─────────────────────────────────────────────
#
# The P-306/P-307 product build deliberately remains the default final target:
# it proves the OS image independently of any one vm-release.  A deployable
# workspace host, however, must carry one immutable versioned runtime in the
# same ostree deployment.  `bake-cloud-images.sh --release-root …
# --release-version …` selects this target and supplies the already-verified
# extracted release as the named `papercusp-release` build context.  Keeping the
# payload outside the ordinary context avoids copying a multi-GiB release into
# the repository merely to build it.
#
# The source release is produced with developer-friendly group/world modes.
# Normalize it to root:$PAPERCUSP_RUNTIME_READ_GROUP before committing it to the
# image. Ordinary uid/gid/mode metadata survives the commit and bootc deployment,
# unlike the named-user ACL that D-314 replaces. Host prepare only verifies it.
#
# Executable files retain read/execute for all classes because embedded-postgres
# checks all 0555 bits before starting. The release and its parent directories
# remain inaccessible to identities outside the runtime-read group.
#
# Podman 4.9/Buildah can omit metadata-only upperdir entries for hardlinked files
# copied from a named context: chown/chmod read correctly inside this RUN, then
# COMMIT falls through to the original lower-layer metadata. Resolve every alias,
# snapshot the hardlinked paths before changing any link counts, and atomically
# replace each with a same-directory fresh inode so the normalized metadata has a
# durable upper-layer entry. The NUL-delimited snapshot keeps arbitrary paths safe.
#
# A direct COPY to the final release path first records its destination directory
# as root:root:0755 and only corrects it in the following RUN layer. The OCI merge
# view looks right, but bootc/osbuild's container-to-OSTree conversion can retain
# that earlier directory header. Mount the named context read-only instead: this
# ONE RUN instruction first creates the final path, copies the payload, breaks
# hardlinks, and applies every final uid/gid/mode before the layer is committed.
# No earlier layer contains the version directory. D-334 / EI-23087105300112185.
FROM workspace-host-os AS workspace-host-release
ARG PAPERCUSP_RUNTIME_READ_GROUP=papercusp-runtime-read
ARG PAPERCUSP_RELEASE_VERSION
RUN --mount=type=bind,from=papercusp-release,source=/,target=/run/papercusp-release,ro \
    set -eux; \
    case "${PAPERCUSP_RELEASE_VERSION}" in \
      [A-Za-z0-9]*) ;; \
      *) echo "FATAL: PAPERCUSP_RELEASE_VERSION must start with an alphanumeric" >&2; exit 1;; \
    esac; \
    case "${PAPERCUSP_RELEASE_VERSION}" in \
      *[!A-Za-z0-9._+-]*) echo "FATAL: PAPERCUSP_RELEASE_VERSION contains unsafe characters" >&2; exit 1;; \
    esac; \
    [ "${#PAPERCUSP_RELEASE_VERSION}" -le 128 ] \
      || { echo "FATAL: PAPERCUSP_RELEASE_VERSION is longer than 128 characters" >&2; exit 1; }; \
    RELEASE_DIR="/opt/papercusp/releases/${PAPERCUSP_RELEASE_VERSION}"; \
    install -d -o root -g "$PAPERCUSP_RUNTIME_READ_GROUP" -m 0750 "$RELEASE_DIR"; \
    cp -a /run/papercusp-release/. "$RELEASE_DIR"/; \
    find "$RELEASE_DIR" -mindepth 1 -print -quit | grep -q . \
      || { echo "FATAL: named papercusp-release build context is empty" >&2; exit 1; }; \
    find "$RELEASE_DIR" -type f -exec stat -c '%i' -- {} + >/dev/null; \
    HARDLINK_PATHS="$(mktemp)"; \
    find "$RELEASE_DIR" -type f -links +1 -print0 > "$HARDLINK_PATHS"; \
    xargs -0 -r sh -eu -c 'for path do fresh="$(mktemp --tmpdir="${path%/*}" .papercusp-fresh-inode.XXXXXX)"; cp --reflink=never --preserve=mode,timestamps -- "$path" "$fresh"; mv -f -- "$fresh" "$path"; done' sh < "$HARDLINK_PATHS"; \
    rm -f "$HARDLINK_PATHS"; \
    [ -z "$(find "$RELEASE_DIR" -type f -links +1 -print -quit)" ]; \
    chown -R "root:${PAPERCUSP_RUNTIME_READ_GROUP}" "$RELEASE_DIR"; \
    chmod -R o-rwx "$RELEASE_DIR"; \
    find "$RELEASE_DIR" -type d -exec chmod g+rx {} +; \
    chmod 0750 "$RELEASE_DIR"; \
    find "$RELEASE_DIR" -type f -exec chmod g+r {} +; \
    find "$RELEASE_DIR" -type f -perm /111 -exec chmod a+rx {} +; \
    [ "$(stat -c '%u:%g:%a' "$RELEASE_DIR")" = '0:912:750' ]; \
    [ -z "$(find "$RELEASE_DIR" \( ! -uid 0 -o ! -gid 912 \) -print -quit)" ]; \
    [ -z "$(find "$RELEASE_DIR" -type d ! -perm -0050 -print -quit)" ]; \
    [ -z "$(find "$RELEASE_DIR" -type f ! -perm -0040 -print -quit)" ]; \
    [ -z "$(find "$RELEASE_DIR" -type f -links +1 -print -quit)" ]; \
    ln -s "releases/${PAPERCUSP_RELEASE_VERSION}" /opt/papercusp/current; \
    [ "$(readlink -f /opt/papercusp/current)" = "$RELEASE_DIR" ]; \
    bootc container lint

# Default output for every existing invocation.  `--target
# workspace-host-release` is explicit, so P-306/P-307 builds neither require nor
# accidentally inherit a vm-release named context.
FROM workspace-host-os AS workspace-host
