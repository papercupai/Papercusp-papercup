# Nested Git builders must replace donor archive identity
URL: /internal/docs/agent-insights/nested-git-clone-donor-archive-identity

An inherited verifier archive receipt makes a selected nested Git clone fail source admission with exit78; verify the clone before replacing donor-only metadata.

## Measured failure class

On 2026-10-24, WI-6554700010027580 ran the maintained bundle-host SOURCE\_SHA guard against a Git checkout without `.verifier-source.json`. With the donor's `VERIFY_TAURI_SOURCE_RECEIPT` it exited 78 and printed `pinned source receipt requires its archive marker`; without that donor receipt it exited 0 and selected the Git HEAD. This cheap comparison did not compile a host. The original failed lifecycle's build logs had been deleted, so its exact cause cannot be proved retroactively.

A verifier-run donor exports its own archive receipt. Private runtime isolation preserves the `VERIFY_` variables. A nested committed Git clone does not copy the donor's untracked archive marker. Inheriting that donor metadata into its builder mixes two source identities.

## Source-preserving handoff

The grading fixture uses `privateGitCloneBundleEnv(root, selectedCommit)` for both its initial build and its relocated recovery build. The helper requires a full selected commit, rejects an archive marker, verifies the clone owns its Git root, and compares its actual HEAD with the selected commit. Only then does it remove the donor-only `VERIFY_TAURI_SOURCE_RECEIPT` and `VERIFY_TAURI_SOURCE_REF`. It preserves `NODE_OPTIONS`, including the committed-source loader, and does not mutate the donor environment.

Do not clear source metadata from an unverified checkout or disable source guards to make a build pass. An archive continues to use its own validated marker and receipt.

## Recurrence guard and diagnostic retention

`npm run test:file -- packages/operator-core/test/private-host-runtime.test.ts` exercises an actual temporary Git repository and the actual maintained source-guard block. It checks the exit78 failure, successful verified handoff, and rejection of a wrong commit, parent Git root and archive marker. The same suite checks original builder log/result/step-journal retention after disposable source cleanup. The lifecycle fixture supplies persistent initial/recovered evidence directories; its integration proof declares those artifacts for retention.

The focused 2026-10-24 run recorded 50 passed, zero failed and zero skipped cases, receipt `32c537e7-d39b-48b9-beef-49cb7119f478`, ledger row `21932267`. This is local regression proof, not the committed IPC lifecycle acceptance.
