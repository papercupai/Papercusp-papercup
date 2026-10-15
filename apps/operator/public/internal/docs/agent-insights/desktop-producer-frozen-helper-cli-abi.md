# A new desktop producer can misroute an old npm helper CLI
URL: /internal/docs/agent-insights/desktop-producer-frozen-helper-cli-abi

D181 current tooling versus frozen product: unsupported cache-lock CLI becomes npm install. Reuse the target's existing exported cache lease, preflight before assembly, preserve source-first refusals.

## Symptom

A separately pinned current desktop producer targeting frozen monorepo source fails at serve bundling with `npm error EINVALIDTAGNAME` on `--platform=node`. The log shows `npm install --exec-under-cache-lock -- npx ...`, not an esbuild invocation. An unsupported leading flag can be normalized into npm-install arguments: do not retry it as an esbuild fault.

## Measured cause and durable fix

WI-10007067 Linux task0muxrdk used producer21662 with frozen product7bc7/desktop371a under D-181. Importing the exact frozen helper and calling `parseCliArgs` proved that the cache-lock flag produced `npmArgs` beginning `install`; the older reader flag produced `commandArgs`. That same frozen helper already exports `withPackageCacheReadLease`. The producer now calls that existing host-wide lease API around the package child, preserving argv, working directory and exit status. It never falls back to bare npx or a repo-only reader: those do not protect the global npm cache from its writer/janitor.

The API preflight runs before SPA/build/npm work, but after source identity and dirty-source refusals. The initial regression run exposed three source-identity tests masked by an earlier cache preflight; correcting the order kept their original oracles. Final four registered Node suites passed94 with zero failures/skips/cancellations; actual nonmutating execution against frozen7bc7 passed. Scoped defect EI-25303483644209158; committed tested producer097a61dcf419641fc649786242633bb7985cc7f1.

## Recovery and proof boundary

Keep product and tooling identities separate in provenance. Execute only a clean immutable tested producer; do not patch frozen product code, its gitlink or a prior tooling bank. Preserve an unaccepted failed stage/evidence; phase=assembling is not eligible for completed-assembly resume. Revalidate product inputs and dependency guards before a fresh attempt. Local API and regression proof does not certify a final sidecar, installer, Intel model inference or independent GO. Those remain on the candidate work-item.

Source-bound proof: `~/.local/state/verification-harness/release-local/wi10007067-private-native-20261007T0615Z/cache-abi-repair-proof.json`; registered guards live in the cited workspace-install/native/provenance/lock suites. No parallel cache implementation or new builder was added.
