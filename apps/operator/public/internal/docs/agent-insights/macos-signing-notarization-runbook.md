# macOS signing and notarization — current release path and acceptance
URL: /internal/docs/agent-insights/macos-signing-notarization-runbook

The current release-local Mac leg cross-builds on Linux and consumes MAC_SIGN_P12_BASE64/PASSWORD through rcodesign. It does not perform notarization or stapling. This runbook distinguishes current certificate inputs, remaining finalization work, native validation, and the explicit native-Tauri alternate path.

The maintained desktop release path is `papercusp-desktop/bin/release-local.sh` → `build-mac-cross.sh`. It cross-compiles on Linux and signs with `rcodesign`. The native `mac-vm-build.sh` is retained for macOS testing and explicit native builds; it is not the current `WITH_MAC` release leg.

This distinction matters for public release. The cross producer accepts a real Apple signing certificate, but its current call sequence does not submit to Apple's notary service or staple a ticket. Supplying the native Tauri `APPLE_*` environment variables does not add those actions to this script. Treat certificate signing, notarization, native verification, and candidate acceptance as separate evidence.

## Current source contract

Default release-route contract checked on 2026-09-06; protected-helper signing and administrator delivery additions checked on 2026-11-05:

* `release-local.sh` selects `MAC_PRODUCER="$ROOT/bin/build-mac-cross.sh"` for `WITH_MAC=1`.
* `build-mac-cross.sh` decodes `MAC_SIGN_P12_BASE64` into a temporary PKCS#12 file. The protected update helper requires a genuine Apple Developer ID Application identity: an absent certificate refuses the build rather than producing a usable ad-hoc release. `stage_update_helper` signs with `rcodesign --for-notarization` and verifies the result; the option enforces the signing profile, not notarization submission.
* `sign_app` calls `rcodesign sign` with `entitlements.plist`, adding `--p12-file` and `--p12-password` only when the certificate is supplied. The immediate guard checks for the bundle's `_CodeSignature/CodeResources`; that guard alone is not a native trust assessment.
* Each role follows `sign_app` → `make_updater` → `make_dmg`. The producer contains no notarization submission, accepted-request check, or stapling step. Certificate-conditional DMG signing currently warns rather than fails if that signing command fails; check the final artifact.
* `PROVENANCE_SIGNED` reflects whether `MAC_CERT_P12` was populated. It does not record an Apple notary verdict, ticket validation, or Gatekeeper acceptance.

The root cause of the retired instructions was a release-route change: WI-5651 moved the default Mac leg to the cross producer, while this runbook still described the native Tauri producer as the default.

## Inputs for the maintained cross producer

| Input                                                                   | Meaning                                                                                                                     |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `MAC_SIGN_P12_BASE64`                                                   | Base64 PKCS#12 containing the intended Developer ID Application signing identity and private key.                           |
| `MAC_SIGN_P12_PASSWORD`                                                 | Password for that PKCS#12.                                                                                                  |
| `TAURI_SIGNING_PRIVATE_KEY_PATH` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Separate updater-signature inputs; follow the current producer's key-loading contract.                                      |
| `MAC_INSTALLER_SIGNING_IDENTITY`                                        | Native `Developer ID Installer` identity used by `--package-protected-app`; distinct from the Application signing identity. |
| Apple notary credentials                                                | An additional prerequisite for a selected notarization workflow; they are not consumed by the current cross producer.       |

Keep private keys and passwords in injected configuration outside the repository. A secret-store reference or machine/path can establish where inputs are managed without exposing their values. An environment-presence check in one agent process proves only that process's configuration; it cannot establish whether another builder or credential store has the inputs.

Do not describe the public-release gap as “only drop in credentials.” The remaining work includes selecting and verifying a maintained notarization/finalization path for the exact candidate, then proving its results. Extend the existing release producer/tooling; do not silently switch to the dormant VM build or create a second candidate. EI-22550966438205456 records this procedure correction; the P2P endgame P-523 checkpoint records the still-unverified signing inputs and final-candidate boundary.

## Protected administrator installation and update verification

The protected package path extends `mac-vm-build.sh` and `bin/lib/mac-protected-installer.sh`. The administrator must first deliver these tools through an independently trusted management channel, such as authenticated administrator SSH or MDM. Never execute a copy supplied by the candidate, or derive the expected helper/policy/package hashes or pinned Apple Team ID from that candidate.

The administrator entrypoints are:

```sh
# Run from the independently trusted administrator copy on the target Mac.
sudo /bin/bash /trusted/bin/mac-vm-build.sh --bootstrap-protected-verifier \
  /approved/helper /approved/managed-policy.json \
  "$APPROVED_HELPER_SHA256" "$APPROVED_POLICY_SHA256" "$PINNED_APPLE_TEAM_ID"
sudo /bin/bash /trusted/bin/mac-vm-build.sh --install-protected-package \
  /candidate/application.pkg "$APPROVED_OUTER_PACKAGE_SHA256" "$PINNED_APPLE_TEAM_ID"
```

Bootstrap establishes the first root-owned helper and managed policy and refuses an existing or aliased baseline. It hashes private staged copies and checks the helper's Apple Developer ID Application identity and Team before publishing. It is separate trust establishment; a candidate cannot approve its own baseline.

Package installation hashes the same private copied outer package that Installer will execute, checks its package signature and Gatekeeper installer assessment against the pinned Developer ID Installer Team, then invokes Installer. Outer-package approval includes the root Installer scripts; approval of only an inner app/archive cannot authorize those scripts. Package scripts invoke the already installed verifier, whose current independent approval and monotonic-floor transaction still governs app/helper replacement. These explicit hash arguments express administrator authorization; they do not create authenticated author/reviewer provenance.

`install-and-relaunch-verify.sh` accepts a matching GUI/Server `.pkg` pair with `--mac-protected-installer`, `--mac-package-sha256`, `--mac-server-package-sha256`, and `--mac-team-id`. The remote installer path names an already provisioned administrator copy of `mac-vm-build.sh`; this verifier never uploads or bootstraps it. It checks root ownership, permissions, aliases, ACLs and ancestry for that script and its sourced library before invoking it through noninteractive sudo. Both approved packages must install successfully before the existing split-role relaunch, exact build flip and sticky-port assertions. Custom install commands are refused in this mode. The supplied hashes are separate approvals, not values automatically trusted from build provenance.

Linux fixture tests of these checks do not establish actual Apple signing, native macOS 10.15 installation, administrator-channel authenticity, native ACL behavior, authenticated source authors, independent review, SEC acceptance or final signed installed-artifact qualification. Those holds remain until the corresponding exact native evidence is collected.

## Public notarization and final artifact evidence

Apple's distribution guidance requires the appropriate Developer ID signature and hardened runtime for notarization. Keep the accepted notary response and inspect its log; a successful signing command is insufficient. Apple documents submission and ticket attachment in [Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow) and signature/runtime failures in [Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues).

For a finalization workflow, establish the signing identity, nested executable coverage, entitlements, hardened runtime and timestamp, successful notarization, and ticket attachment before accepting the distribution. If finalization changes the app or container, regenerate downstream archives, updater signatures, hashes and provenance through the maintained packaging path; previous receipts identify the previous bytes.

Validate the exact finalized app on a native Mac, repeating for every shipped app role:

```sh
APP=/absolute/path/to/the/finalized.app
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dvv "$APP" 2>&1
spctl --assess --type execute --verbose "$APP"
xcrun stapler validate "$APP"
```

Record command exit status directly, the intended certificate authority/team, the Gatekeeper result, and the ticket-validation result. Validate the actual distributed container too. A real download/install/launch journey with quarantine intact is separate acceptance evidence; do not remove quarantine or override Gatekeeper and call that public-release acceptance. An ad-hoc signature, a nonempty CodeResources file, or an updater `.sig` is insufficient proof.

## Native Tauri path: explicit alternate workflow only

`papercusp-desktop/bin/mac-vm-build.sh` remains a native build entrypoint. Its Tauri signing configuration may use `APPLE_SIGNING_IDENTITY` or `APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD`, with separately configured Apple ID or App Store Connect notarization credentials. These are native-tooling inputs, not aliases for `MAC_SIGN_P12_BASE64`. Verify the installed Tauri version's contract and the remote process environment if choosing this path; local exports do not automatically cross SSH.

Do not infer that the certificate is installed, the keychain is usable, or a notarization request succeeded from this reference. An explicitly chosen native build must satisfy the same exact-candidate custody, provenance, independent acceptance and final artifact checks as the default producer.

## Packaging caveats retained

The cross-build header documents the optional native Swift TermShim and source-archive paths. Follow their current opt-in contracts and exercise them on the final app when included; neither is proven by a signing check. The assembled Darwin sidecar, GUI/Server role separation, seed/migration provenance and offline install journey keep their existing acceptance requirements. Updater signing remains a separate mechanism from Apple code signing and notarization.

For P2P public release, this runbook is preparation evidence only. It does not open candidate-ready, physical acceptance, independent GO, the actual 72-hour post-GO canary, or shipment.
