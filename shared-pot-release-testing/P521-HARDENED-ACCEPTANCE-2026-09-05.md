# P521 hardened-artifact acceptance — prepared 2026-09-05

Status: source preparation only; no packaged candidate or public GO is asserted. Work-item: WI-2144482. Governing authority: endgame D-016, D-022 and P-521. F3/F6 source-ready evidence is on WI-2144475 and WI-2144478; f54d accepted it for the single candidate on WI-2037678. P203 remains fa658's WI-2142873.

## Candidate admission

Use the ONE materialized candidate handed off on WI-2037678. Record its source revision, submodule revisions, runtime SHA256, dependency/migration/seed identities, separately hashed optional packs and reproducibility comparison. Record the full installer identity separately. Resolve each installed process back to those exact bytes before each journey and after a restart. A source digest, old e9f/0.0.18 artifact or a passing component suite cannot substitute for the new candidate.

Replace the manifest input's `pending-unified-candidate` and pending peer roles with the actual artifact identity and admitted device public keys. The owning hive key remains on its single owner; never replicate it to create a passing peer. Record stable hive/repository scope and each process's store generation/runtime identity. A required peer omitted from a query is missing evidence, even if the remaining population looks healthy.

## Required physical journeys

| Row | Execution and acceptance evidence |
| --- | --- |
| Discovery/join | Fresh supported install joins the pinned hive on two physical hosts. Record both device identities, discovery, admission and live data visibility. |
| Exact peer Git / F1–F2 | Drive new edits across both hosts. At one recorded watermark require the named peer set, fresh observations, signed repository/generation context and exact snapshot/ref equality. Preserve negative controls for absent/filtered peers, transient lag, replayed announcements and D-014's excluded legacy SQL population. An advancing or aged-out health result cannot pass this row. |
| Serving identity / F3 | Publish from a separate process using the serving owner's capability. Expire discovery and omit the owner advertisement; publication must become retryably unavailable. Restart the owner and replace the store generation: the old runtime capability must refuse, then a fresh matching capability must restore publication. Record before/after identities and actual signer/servable refs on both hosts. |
| Apply outage/replay / F4 | On the isolated test hive, cause a bounded target-apply outage. Preserve evidence of the unapplied operation and cursor, restore the target, replay and prove the exact write arrives. Retry exhaustion cannot permanently advance beyond the missing write. Reuse P515's source proof only as source evidence. |
| Trusted seats / F5 and P202 | Existing P202 driver on the pinned candidate: explicit host grant, one bounded headless member, fresh attributed first tool call, visible work, signed receipt, visible stop and revocation. Reconfirm workspace/repo/tool/credential/lifetime/concurrency/host ceiling restrictions. Run in registered rig custody. This is trusted host-agent delegation, with no billing or untrusted-sandbox claim. |
| Protected effects / F6 | Two hosts hold divergent advisory views at the same membership epoch. Only the owning hive may authorize canonical staging/release, GitHub, independent submodule-origin, fork and PR writes. Record target refs/effects before and after denied attempts. Repeat with missing/device-only/stale authority and with authority lost between push attempts. Local commits and device-head exchange remain permitted. Restore the owner and prove an authorized positive case. |
| GitHub bridge / P204 | Flip the TEST hive through its supported bridged path. Members stay commit-only for canonical refs; the owner-authorized bridge publishes the admitted exact ref. Submodule opt-in is still subject to the owner gate. |
| Full installer | Run the full offline-installer journey as a separate compatibility check against the same source and protocol contract. The minimal witness does not replace it. |

For every execution retain: exact artifact identity; scenario and result; expected/observed peers; scope/generation/runtime identities; timestamps and watermarks; command/tool exit status; artifact/log paths and SHA256; refusal side-effect checks; owner; approved exclusions. A skipped or unmeasured journey is never a pass. Keep failure evidence when a later run supersedes it.

## Computed interpretation and independent GO

The adjacent `p521-readiness-input-2026-09-05.json` is a preparation snapshot. Its artifact and physical peers are explicitly pending. Source tests are recorded as `source-tested`; all physical component verdicts remain `unknown`. The generated JSON and table use the EXISTING generic `evaluateReleaseProfile` and F8 `buildCurrentReadinessManifest` / `renderReadinessTable` adapter. They create no new evaluator, service or persistence scheme, and they cannot authorize GO.

On candidate handoff, retain this snapshot in history; supply actual execution evidence and matching lineage to the existing evaluator. Generate the current manifest, dependency graph and human table from that verdict. Obtain the independent non-implementer audit and signed GO through the existing release authority. Append the result to the signed readiness history; do not replace historical failures or turn a source-only result into a packaged pass.

## After GO

After the independent GO timestamp, complete the actual registered owner-freeze/recovery chaos exercise, evidence-based default Git-mode decision, portfolio closeout, completion audit and independent grade before marking the plans shipped. D-170/D-173 remove P-501 and every timed-soak prerequisite. D-179 permits the exact private candidate for this acceptance; public publication remains separately governed. D-022 supersedes automatic lease-failover claims: losing the single owner freezes protected effects; restoring that owner permits fresh authorized progress. Denied non-owner, device-only, missing, foreign and stale proofs must leave protected effects unchanged; recovery requires a fresh owner-countersigned monotonic advance, never automatic takeover.

Public v1 exclusions remain: retired generic work offers, untrusted public compute marketplace, billing/metering, universal memory federation, default-on optional media and 256-peer validation. Opt-in memory and optional media retain their own bounded support/trust/readiness claims. Recorded signing inputs remain pending; no new request to Avi is implied.

## Source evidence banked for this handoff

P517 source-set digest: `621c0a35c48adabca0ec4858d038d96f6dfc8e9e475babba17507855b6fa2f02` (SHA256 over sorted path + NUL + bytes + NUL; file list in `/tmp/p517-submodule-types-20260905.log`). This is NOT a package digest. Final types: clean, exit 0 at 2026-09-05T17:48:15Z. New submodule/retry and production wiring runs: `2549a41d-59b5-4f06-afba-920ffeeebdd4`, `68003c8d-c13f-4828-9af3-ac595960bd20`, `8c207b26-72c8-42f6-8bfb-ec83668f47c7`. Earlier pure and separate-OS-process proof remains on WI-2144478. P514 capability/runtime proof remains on WI-2144475.
