# Ongoing-work shipment: legacy package reconciliation proposal

## Current revision — 2026-10-12

This revision supersedes the dated preparation below where it differs. Plan D-006 now records the instruction to ship; the parent shipment lane is held by another agent. This session continues its owned WI-10007422 child under the original SELF route.

The actual selected legacy goal remains killed, with installed version 1.1.0, local user package 0.1.0, manual worklist declaration, and saved worklist version 5. No live configuration was changed. The bundled package is now **1.4.0**, with SHA-256 `ccc9ae22b451eca5ce54473920af9f9695e9e8fce55f331e2e4911c3871edfe3`. Its collection has **defaultSelected:false**: newly active plans are visible but require an owner pick. The old proposal's defaultSelected:true and automatic-selection wording must not be applied.

The required source preparation is implemented using existing surfaces:

- `goals:create` now accepts `standing`, `budgetWindowSec`, and the full validated `launchSettings` document. The existing holder policy validator still applies; a top-level holder changes only the holder key. The shared goal-row writer persists the fields atomically. Creation does not enter GOAL mode or launch a holder.
- The existing package-board fold now prefers an active instance, then a paused held instance, then an unstarted paused replacement ahead of terminal history. Terminal-only history keeps its prior readout; a package with only an unstarted stub keeps its Start behavior. Selecting a paused replacement is navigation, not activation.
- Canonical tests passed: **62 creation tests**, native receipt `21155111`, and **11 board tests**, native receipt `21155103`. Both are current working-tree proof, marked dirty in the ledger; neither certifies a released artifact. The earlier red creation receipt `21155084` demonstrates the formerly rejected fields. Receipt `21155099` retained a test-author mistake about the existing conditional mode attribution query; that test was corrected after reading the writer. All processes were drained and locks released.

The exact private proposal is [creation-review.json](../../.papercusp/scratch/wi-10007422/creation-review.json). It contains complete creation arguments, the old/new worklist-body section diff, all **71** saved plan refs from an untruncated authoritative read, source fingerprints, and executable rollout checks. It is **proposal-only**: no handler, goal creation, property write, package replacement, or start was invoked.

The proposed new record is paused and standing. It keeps the $500 / 7-day ceiling, nine complete role profiles, custom tripwire threshold without historical measurements, and the entire existing duty body except its worklist interface section. That change uses the current 1.4 owner-pick contract. The audit-before-placement section and the elected-holder instruction remain. The metadata records the customized body/tripwire through the existing package-instance override so later starts can preserve it. Existing killed records retain their spend, pause/kill history, identity, and property provenance. The proposal explicitly chooses holder loss behavior `deactivate`; no automatic respawn is introduced.

Live approval covers only creating this paused record and transferring the saved refs through the maintained versioned property writer. Before applying, re-read the complete old source and version, verify the serving creation schema and board source contain the changes, create once, read back the actual allocated id, then read the new property version before its CAS write. Require the actual collection to leave newly discovered plans unselected, and verify the old killed record remains unchanged. Agent activation is separate. Final released-artifact evidence, independent certification, author verdict, and shipment remain with the parent shipment lane.

The observations below are retained as **2026-10-08 history**, not current implementation instructions.

Prepared for Avi under WI-10007422, a child of WI-10007153. The approved SELF route continues. This proposal changes no goal, package, property value, agent, or live release.

## Decision needed

Choose the acceptance contract: retain the legacy manual worklist, or require 02C's active-plan collection and owner selection/order editor. For 02C, a separate paused standing record is the proposed target. The existing killed records remain historical records; this proposal does not authorize agent activation.

The previously suggested `cupboard:install-goal { skipSeed:true }` followed by `goals:apply-package-update` cannot reconcile the selected killed instance. This proposal withdraws that route.

## Measured state and supported boundaries

- `coord:whoami` confirmed the shipment session's identity. Recovery reads confirmed this session still holds WI-10007153, WI-10007156/P-004, WI-10007422, and EI-25380358224150209.
- The current `goals:get` read for `work-on-everything-070565` returns `status:killed`, installed package `1.1.0`, available package `0.1.0`, layer `user`, and `updateAvailable:false`. Its worklist declaration has no collection. Its saved worklist has version 5; its entries must not be reconstructed from a clipped response.
- The scoped pre-recovery instance receipt contains eight matching rows, all killed, with an untruncated positive control. Source `package-board.ts` selects the first active non-stub, otherwise the first non-stub of any status. Thus its `activeGoalId` can refer to a killed record; it does not prove a running agent.
- The workspace-local exported package shadows the bundled package by design. User goal manifest SHA-256: `05b77afcdcf0254de44ae30cd2bde8f77840450143faefabc2878120c26d745e`. Bundled goal manifest SHA-256: `597c5ea6662bd62d5962b13240d91ab23abd4c2f6d3d975cee0f75faa285a783`. Bundled listing version: `1.2.0`.
- Public `cupboard:search` with both the exact goal query and an unfiltered `kind:goal` returned no goal listings. The unfiltered response reported total 0 and goal facet 0 while other kinds were present. No public goal listing, mirror URL, or mirror version was verified.
- `planGoalPackageUpdate` checks the version first, then explicitly refuses `killed`/`achieved` with `terminal-instance`. Installing 1.2 would expose that second refusal rather than make this record eligible.
- `cupboard:install-goal` without `skipSeed` also refuses to seed a duplicate when any record carries the same package identity, including terminal records. `skipSeed` places the directory only. Starting from a package can mint a fresh instance but also launches its holder, so it is outside this proposal.
- `goals:create` supports a paused record, metadata, and property declarations, and does not enter GOAL mode. Its current arguments lack `standing`, budget window, and full launch settings. `goals:update` can set the latter two but cannot set `standing` or property declarations. Consequently the existing public verbs alone do not create a fully configured paused standing replacement.

## Exact package differences

| Field | User export 0.1.0 / current customization | Bundled 1.2.0 | Proposed preservation |
| --- | --- | --- | --- |
| title | Work on everything | Same | Keep |
| standing | true | true | Keep |
| budgetCents | 50000 | 10000 | Keep 50000 |
| budgetWindowSec | 604800 | Same | Keep |
| launchSettings | Claude Opus 5, xhigh; warm defaults; nine role overrides | Absent | Keep the complete current document; do not use scrubbed export account placeholders |
| tripwires | spend_cents threshold 50000 cents | Absent | Keep the threshold; old telemetry stays on the historical record |
| propertySchema.worklist | manual plan-ref-list, editable by both | Same datatype plus collection | Add the collection only if 02C is chosen |
| propertySchema.worklist_policy | Absent | Owner-only ordered-selection-policy | Add only if 02C is chosen |
| body: worklist instructions | Explicit owner-curated worklist | Active workspace plans plus saved owner choices | Replace only this section if 02C is chosen |
| body: audit-before-placement section | Present; quotes Avi's 2026-09-01 instruction | Absent | Preserve the entire section |

All remaining body sections are identical in the measured user/bundled diff. A wholesale copy would remove the audit instruction and retune the defaults. It is not the proposed operation.

The additive declaration for 02C is:

```json
{
  "worklist": {
    "datatype": "plan-ref-list",
    "default": [],
    "editable_by": "both",
    "collection": {
      "source": "active-workspace-plans",
      "policy": "worklist_policy",
      "order": "priority",
      "selectable": true,
      "defaultSelected": true
    }
  },
  "worklist_policy": {
    "datatype": "ordered-selection-policy",
    "default": { "order": [], "excluded": [] },
    "editable_by": "owner"
  }
}
```

The replacement worklist section uses the bundled 1.2 contract: active plans append after saved priorities; selected is not runnable; lifecycle approval, dependencies, ownership, and ceilings still gate admission; owner-only order/exclusions persist; unavailable collection/policy reads remain visible failures. The rest of the customized body, including audit-before-placement, remains intact.

## Concrete implementation choices after the decision

**Legacy contract:** preserve the existing records and manual worklist behavior. Use the shipped legacy detail/read-only journey as the acceptance target only after Avi explicitly chooses that scope. This does not certify the new 02C collection editor against real data.

**02C contract, paused replacement:** extend the existing creation surface by the minimum missing standing/default fields, validate through the same maintained goal validators, then prepare an exact paused-record creation payload. Reuse the existing package-board fold to prefer an eligible paused replacement over terminal history, with tests covering mixed paused/terminal instances. There is no new service, table, scheduler, or orchestration loop. Preserve the full custom body and operational tuning above; keep the old pause/kill history, spend, identity, and property provenance on the old records. Any transfer of saved entries requires a complete authoritative read and a separately reviewable value write. No holder is launched. The actual fresh record id is allocated by the existing creator, then read back before use.

This second choice needs source work before a live creation payload can be approved. It does not depend on an unverified Cupboard mirror and does not silently alter the shadowing user package. A public publish/install route would be a separate outward-facing choice.

## Verification and remaining shipment work

This turn performed content-bearing source, manifest, claim, and goal reads. It did not rerun the previously verified browser matrix. Existing source fixtures/current-build passes remain preparation evidence; they are not released-artifact acceptance.

After the contract choice and any required source work: run the maintained focused tests for creation, package selection, typed properties, and the actual 02C journey; retain exact native receipts and test-source identities; obtain the required independent certification and author verdict; verify R-12 on the exact released artifact. Final shipment remains unverified. This lane performs no live-gate operations, gate-status monitoring, deploy, repair-queue mutation, or parallel supervision.

## Evidence sources

- `packages/operator-core/lib/goals/package-update.ts`: version and terminal guards; update modes and preservation.
- `packages/operator-core/lib/cupboard/install-goal-io.ts`: package identity no-clobber and inactive seed behavior.
- `packages/operator-core/lib/cupboard/goal-package-store.ts`: user-over-bundled precedence.
- `packages/operator-core/lib/goals/package-board.ts`: instance selection writer.
- `packages/agent-mcp/src/tools/goals/create.ts` and `update.ts`: current supported creation/update arguments.
- `goal-packages/work-on-everything/goal.json` and `listing.json`: canonical bundled contract.
- `~/.papercusp-workspaces/papercusp-workspace/.papercusp/goal-packages/work-on-everything/goal.json` and `listing.json`: customized local export.
- `/tmp/ongoing-work-current-legacy-goal-detail.json` and `/tmp/ongoing-work-actual-package-instance-projection.json`: earlier scoped instance receipts; current narrow goal reads corroborate the selected instance's status, version, schema, budget, and launch settings.

Proposal only. No live reconciliation or activation has occurred.
