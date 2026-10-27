---
rel_path: "evidence/bg-host-p001-fire65-output-transaction-consult-20261025.md"
updated_at: 1792935579249
_body: "content"
---

Answer (current-source review; first-principles, not grounded expertise): the closest existing maintained mechanism is the caller-owned **producer bank/output binding**, not an argv-observed context issuer.

Concrete entrypoint: `papercusp-desktop/bin/build-linux-local.sh --producer-bank <absolute-bank> <preflight>` (around lines 119-170), backed by `papercusp-desktop/bin/lib/release-artifacts.sh::release_artifacts_assert_producer_output` (around lines 34-51). It binds an absolute existing bank plus safe fixed leaf into readonly `PAPERCUSP_PRODUCER_BANK`, `PAPERCUSP_PRODUCER_OUTPUT`, and `RUN`; asserts the output is absent before effects; reasserts after sourced preflight; then creates it exactly once. It also checks a nominated preparation packet binds that output, maintained producer script digest, baked identity, and source identity before production. This is the maintained precedent for caller custody/no ambient fallback.

For atomic whole-tree publication, the maintained equivalent is `papercusp-desktop/bin/build-desktop-sidecar.sh`: it fixes `SIDECAR_FINAL_DIR` and a caller-owned staged sibling `SIDECAR_TMP_DIR="$SIDECAR_FINAL_DIR.tmp.$$"` before build effects, holds a build lock for the producer/evidence transaction, builds/verifies entirely in the stage, takes a short publish lock, and renames stage→final (roughly lines 600-725 and 5271-5525). It re-verifies the final path while still holding publication custody. That is the stronger model for the full main/worker/spawner artifact set.

I would therefore reuse/generalize those two existing contracts: have the outer caller nominate one absent absolute transaction bank/stage before invoking `bundle-host.sh`; bind the maintained recipe/toolchain/config/env and the complete logical output population to that bank before any compiler acquisition or write; let the recipe derive PID-bearing temporary leaf names only *inside that already-bound bank*; execute all main/worker/spawner compiles there; qualify the completed set; then atomically publish the set. Preserve the original exact executed argv as evidence, but do not use compiler-observed argv to mint authority.

Current `scripts/source-preview.mjs::prepareBgVerifierBuildContexts` is not yet that transaction mechanism. Its `bg-build-contexts-v1` validates separate exact argv and unique outputs and `compileBgVerifierInvocation` uses `write:false` then exclusive writes, but context authority is still indexed by complete argv. Since `bundle-host.sh` and common workers synthesize `.tmp.$$` / `.new.$$`, that API cannot author the whole recipe before effects unless the caller first owns the namespace in which those volatile names are derived. Also, `qualifyBgVerifierOutput` qualifies one entry/manifest, not the whole recipe publication.

So: **yes, reuse the producer-bank + staged atomic publication pattern; no, do not issue contexts from observed compiler argv.** I found no ready-made `bundle-host.sh`-specific whole-recipe transaction function that can simply be called today; it appears to need an adapter/generalization using those maintained entrypoints.
