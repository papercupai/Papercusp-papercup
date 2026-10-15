# Syft installer tmpfs source skip runbook
URL: /internal/docs/agent-insights/syft-installer-tmpfs-source-skip-runbook

Diagnose zero-package installer scans on /run or /dev tmpfs, keep license coverage fail-closed, and scan the exact unchanged installer with the maintained checker.

Syft 1.51.0 skips directory trees on tmpfs beneath /run, /dev, /var/run, /var/lock and /sys. This happens in syft/internal/fileresolver/path\_skipper.go at directory indexing, before package catalogers run. An explicitly selected JavaScript cataloger and a relative cwd source do not override the skip.

WI-10007689 reproduced one identical npm fixture: home storage returned one npm package; /run/user scratch returned zero with exit 0. Syft -vv reported `ignoring path based on mountpoint filesystem type condition=/run fs=tmpfs mountpoint=/run/user/1000`. The original D218 finalization used an expanded installer tree under that path. Empty coverage correctly remained UNDETERMINED, but the hint to inspect cataloger selection did not identify this mount exclusion.

1. Read the original retained SBOM descriptor and its source path; verify selected catalogers and filesystem type. A missing cataloger is a separate hypothesis.
2. Reproduce with a bounded fixture under the same scratch source and an ordinary storage control. Do not repeat a multi-GiB artifact scan only to reconstruct evidence.
3. Use `node scripts/check-licenses.mjs --strict --installer-tree <expanded-tree>`. Its existing runSyft seam detects the excluded tmpfs source, stages the exact tree in inspectable private temporary storage, preserves relative symlinks, and cleans the stage on success or failure. A genuinely empty result still returns UNDETERMINED.
4. Bind the result to the exact final installer hash and unchanged signature. Preserve a nonempty SBOM and license output; do not infer candidate acceptance, broader security qualification or GO from a license pass.

Registered guard: packages/operator-core/lib/license-gate.test.ts tests exact copied bytes, relative symlinks, cleanup and zero-result fail-closed behavior. Actual unchanged D218 final deb a7c38f60 / signature493a2045 subsequently produced 584 Syft components (295 npm) and strict LICENSE\_GATE\_RESULT status=pass. Evidence is on WI-10007689 and under the retained verification artifact referenced from WI-10007689. The product bytes were neither rebuilt nor resigned.
