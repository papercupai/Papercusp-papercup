---
rel_path: "evidence/p536-fire66-assembly9-primary-mcp-pg-shutdown-20261025-v1.json"
updated_at: 1792912097642
_body: "content"
---

{
  "schemaVersion": "p536-assembly9-private-primary-control-fire66-v1",
  "workItem": "WI-6554700010026987",
  "nativeTask": "0mvngulkt1d3j9h91bx",
  "nativeStatus": "completed",
  "nativeExit": 0,
  "run": "/tmp/p2p-p536-48ad-20261024-U1aLGd",
  "qualification": {
    "schemaVersion": "p537-artifact-qualification-v1",
    "sourceCommit": "ea7f90bca42b357aedc80a0f01770a8bd1674f47",
    "desktopPin": "96ff0d4663b13b724dc022dd6d7a1b02dd911855",
    "root": "/tmp/pcv/papercusp-lint-as-committed-ea7f90bca4-x5XVpZ",
    "artifact": "/tmp/48ad-p537-build9-Xt4F7n/run/artifact",
    "assemblyReceipt": "/tmp/48ad-p537-build9-Xt4F7n/run/assembly.json",
    "assemblyReceiptSha256": "afc7f6d75cb181aca25fd134300c78d5e6d19c0431f749d0f7e28e67cc6b0845",
    "sourceSha": "ea7f90bca4",
    "sourceCensusStable": true,
    "artifactCensus": {
      "files": 22309,
      "bytes": 4515823883,
      "links": 0,
      "sha256": "360e797a82df826f4c8df33ab3997f1712912186519d9a1b00c5d4b595fdcc81"
    },
    "artifactCensusAlgorithm": "depth-first fs.readdirSync(dir).sort(); JSON.stringify([relativePath,stat.mode&0o777,SHA256(bytes)])",
    "primarySha256": "288cff11c5267447c5757d5d4ab55d81c33ac5e2ec272d361033f32a0da8d5d4",
    "baked": {
      "serve.mjs": {
        "sha256": "288cff11c5267447c5757d5d4ab55d81c33ac5e2ec272d361033f32a0da8d5d4",
        "sourceSha": "ea7f90bca4",
        "occurrences": 1,
        "context": "ge_version||\"0.0.0\",bakedSha=opts.bakedSha!==void 0?opts.bakedSha?.trim()||null:\"ea7f90bca4\"?.trim()||null;if(bakedSha)return{sha:bakedSha,version:version17};let envSha=env4.PAPERCUSP_BUILD_SH"
      },
      "spawner-sidecar.mjs": {
        "sha256": "2712f8de1ddf156be5fcc59d32675c0298d53a616b87fb62f2ae1d214e184da4",
        "sourceSha": "ea7f90bca4",
        "occurrences": 1,
        "context": "ge_version||\"0.0.0\",bakedSha=opts.bakedSha!==void 0?opts.bakedSha?.trim()||null:\"ea7f90bca4\"?.trim()||null;if(bakedSha)return{sha:bakedSha,version:version15};let envSha=env4.PAPERCUSP_BUILD_SH"
      }
    },
    "processGroup": 2610504,
    "processGroupAbsent": true,
    "elapsedMs": 226270,
    "retention": {
      "verified": true,
      "artifact": "/tmp/48ad-p537-build9-Xt4F7n/run/artifact"
    },
    "controlStatus": "not-run",
    "physicalStatus": "not-qualified"
  },
  "authority": {
    "decision": {
      "ok": true,
      "results": [
        {
          "ok": true,
          "slug": "p2p-public-release-endgame-2026-09-01",
          "harness": "papercusp",
          "archived": false,
          "legacy": false,
          "frontmatter": {
            "title": "P2P public release — endgame: drive every lane to a signed GO and shipped plans",
            "slug": "p2p-public-release-endgame-2026-09-01",
            "status": "ready",
            "created": "2026-09-01",
            "updated": "2026-10-25",
            "owner": "aviynw@gmail.com"
          },
          "contentHash": "c5b1c2cf9f5fde34e52aa6211786c79352ead90fac902442f4738125139311b6",
          "version": 580,
          "forcedPast": null,
          "counts": {
            "items": 44,
            "decisions": 337,
            "sections": 20
          },
          "decisions": [
            {
              "id": "D-337",
              "title": "Replace missing-root assembly8 with measured and retained assembly9; preserve original P536 controls",
              "body": "Date: 2026-10-25\nPromoted-From: [{\"kind\":\"decision\",\"ref\":\"p2p-public-release-endgame-2026-09-01#D-336\"},{\"kind\":\"work-item\",\"ref\":\"EI-26927660010348056\"},{\"kind\":\"work-item\",\"ref\":\"EI-26916706826486032\"}]\n\nMeasured: original56361 refused D336/spec8 before copying because the exact retained source root had been swept; EI-26927660010348056. The committed verification used --keep without later artifact retention. Maintained re-materialization of exact ea7f90bca42b357aedc80a0f01770a8bd1674f47 at /tmp/pcv/papercusp-lint-as-committed-ea7f90bca4-x5XVpZ retains artifact dependencies through retainCommittedWorkRoot. Exact16 provider bytes and desktop/tooldef gitlinks match, but complete prepared-source census differed, so artifact8 was NOT relabeled. A fresh maintained assembly9 completed226270ms<600000 with equal before/after source census, dependency/native pruning checks and absent process group2610504. Exact /tmp/48ad-p537-assembly9-qualification.json: verified source retention against /tmp/48ad-p537-build9-Xt4F7n/run/artifact; receiptSHA afc7f6d75cb181aca25fd134300c78d5e6d19c0431f749d0f7e28e67cc6b0845; canonical byte/mode census360e797a82df826f4c8df33ab3997f1712912186519d9a1b00c5d4b595fdcc81 (22309files/4515823883bytes/0symlinks). PRIMARY/spawner hashes and baked source identity equal qualified assembly8; no runtime control inferred.\n\nAfter exact fixture9 readback and activation delta audit including THIS decision, original independent56361 may resume the SAME D336 test-only private fixture route using ONLY new exact assembly9/source root. Recheck verifyCommittedWorkRoot with exact artifact dependency, receipt, byte/mode census and immutable copy/closure before startup. Missing source or mismatched census refuses before copy; retain this lifecycle guard for any successor input. D336 assembly8 fixture selection is superseded by exact9; every original namespace, resource/time/teardown ceiling, actual loaded provider/standing/conformance/grant requirement, original oracle/frozen/source-admission gate and D331/D332 owner-only gist wall remain. Gate p536-private-source-restored-48ad-20261025 opens only after audit/readback. No physical/custody/candidate/signedGO/default/shipment grant.\nRelated: P-536, P-537, P-403",
              "date": "2026-10-25",
              "itemRefs": [
                "P-536",
                "P-537",
                "P-403"
              ],
              "affects": [],
              "lineNumber": 4851
            }
          ],
          "decisionSelection": {
            "requested": [
              "D-337"
            ],
            "matched": [
              "D-337"
            ],
            "missing": []
          }
        }
      ],
      "counts": {
        "ok": 1,
        "failed": 0
      }
    },
    "spec": {
      "ok": true,
      "slug": "p2p-public-release-endgame-2026-09-01",
      "harnessSlug": "papercusp",
      "specs": [
        {
          "planSlug": "p2p-public-release-endgame-2026-09-01",
          "specId": "ENDGAME-P536-private-fixture-and-freeze",
          "sourceValId": null,
          "currentRevision": 9,
          "revision": 9,
          "planItemId": "P-536",
          "behavior": "Prospective TEST-ONLY envelope for existing original author su-56361318-8122-4c67-be9f-325d9f4f8bf0, independent of sole source actor48ad and actual WI26007/WI16971/WI2144482 history. New test paths ONLY packages/operator-core/lib/agent-tools/capability/vm-copy-installed-authority.integration.test.ts and, only if needed, packages/operator-core/lib/agent-tools/capability/__fixtures__/vm-copy-installed-authority.ts. Reuse existing maintained isolated runtime/setup helpers without editing them. Existing frozen vm-copy/physical/oracle files are immutable. Author holds a distinct test work-item, never claims the implementation WI. No test-only action is admitted by this draft; scoped admission and current final lineage check precede authoring/setup.\nExact private namespace selected prospectively: workspace test-runtime-p2p-vmcopy-p536-48ad-20261024, concrete harness p536-vmcopy, local pot p536-installed-copy, class p536.installed-copy@1.0.0; per-run root is mkdtemp under /tmp with prefix p2p-p536-48ad-20261024-, mode0700. Host-selected state root=<run>/state; artifact root=<run>/artifact; VM root=<run>/state/vms; evidence=<run>/evidence; private HOME/config/keychain/PG/listeners under run state. For the maintained private preflight, child HOME=<run>/state/home, PAPERCUSP_WORKSPACES_ROOT=<run>/state/workspaces and TMPDIR=<run>/state/tmp. Its deterministic test-runtime-p2p-vmcopy-p536-48ad-20261024-foreign registry companion is confined to that disposable registry; it adds no primary, DB, pot, provider, worker or VM resource. Runtime HOME changes are ordinary existing fixture configuration in child processes, not product selectors or alteration of the agent's shell HOME. No shared3170/3070 database writes, shared state/signing keys or service restarts. Use maintained private current-build PRIMARY startup with fresh disposable DB and actual bound loopback ephemeral port, not a request-only server, mocked API, manual namespace insertion or fabricated primary receipt. Readiness and teardown retain exact child/kernel/port/DB/run-root identities.\nBefore any product expectation, create the private pot/workspace/member/device through maintained canonical setup, resolve exact FederatedPotScope, require member bindingStatus verified and matching real device attestation, and read the complete scoped roster/revoked union. Missing/unreadable or unmatched standing is setup failure. Exact provider is DERIVED from actual projected capability:inspect and actual required execution tool descriptor ownership/version/schemas/revision. Define class from those actual schemas, validate via maintained registry, persist actual conformance, bind to private pot, compile/apply normal identity/grant and read back exact class/package/version/kind/registry/binding/conformance/grant/applied revisions. No invented pluginVersion/pass literal/operation-to-tool coercion. Incompatible real tools are a fixture blocker. Provider tuple values are measured outputs, not caller-selected allow evidence.\nRegister ONLY linux-test-vm:p536-src and linux-test-vm:p536-dst within disposable private lock database, stamp their canonical domain kind before private exclusive leases, read back both canonical domains and exact lock/fence/owner/expiry. Host map owns source=<VMroot>/run/p536-src/overlay.qcow2 and destination=<VMroot>/run/p536-dst/overlay.qcow2; names/path/domain are resolved by trusted installation/bootstrap association, not request/custody prose. Fictional image bytes remain private data; no image/VM/device/physical action beyond fixture files. Both are disjoint from any existing resource/VM. Freeze strict internal v2 input before normal actual native birth, bind actual original launch/task/adv/applied/control and keep accepted bytes unchanged. Real authenticated MCP and actual observer/protected writers/reader exercise distinct phase/challenge with strict external v1 full subject/kernel assertions.\nSetup ceilings: one primary+one direct-native managed worker, one disposable DB with required locks database, at most4 ephemeral loopback listeners, two VM resource registrations/exclusive leases, manifest remaining leaseLifetimeSec300 (strict per-phase horizon)/operation timeoutSec120; each of the same two original private exclusive acquisition ttlSec900 maximum under D334, with independently measured exact current custody >=300s remaining at each phase and elapsed <=599s from the earlier acquisition; no heartbeat, refresh, replacement fence or re-acquisition of accepted custody; no model-provider billing/network VM/SSH/container/physical action. Build uses maintained default240000ms checkpoint and at most900000ms only with retained genuine completed-step progress per maintained builder, readiness60000ms, fixture setup after build180000ms, phase request15000ms, total test run1200000ms, teardown30000ms with exact-child graceful/forced-exit evidence. Resource/census bound failures are explicit setup failures, not assertion-red; revising a ceiling requires recorded evidence/spec revision.\nOnce independent real setup controls PASS, obtain a genuine clean committed assertion-red at the intended installed allow against current intentional installed-binding-unavailable. Use existing production entry/transport, no missing-export/import/collection/compile/setup/teardown/dirty/synthetic red. Canonical native reporter must record full failedCaseTitles, zero skips/collection failure, clean named committed test/helper bytes and same workspace/harness test_runs sink/receipt. Original eligible author then makes current manual test-ONLY spec measurement pin with identical sourcePaths/testPaths and registers original-author frozen manifest revision1 on WI26007 via work_items:update frozenTests; no reuse of P521 binding67598. Only AFTER exact readback, sole48ad source admission and activation re-audit D315-D318/new P536/specs may occur. Source fixture success gives no candidate/custody/cut/seed/migration/restart/physical/GO/default/shipment credit.\nQualified P537 fixture input (retained committed builtin-provider assembly9 under D337): use only source commit ea7f90bca42b357aedc80a0f01770a8bd1674f47 and desktop gitlink 96ff0d4663b13b724dc022dd6d7a1b02dd911855, retained source /tmp/pcv/papercusp-lint-as-committed-ea7f90bca4-x5XVpZ. Prepared closed artifact /tmp/48ad-p537-build9-Xt4F7n/run/artifact; receipt /tmp/48ad-p537-build9-Xt4F7n/run/assembly.json SHA256 afc7f6d75cb181aca25fd134300c78d5e6d19c0431f749d0f7e28e67cc6b0845; PRIMARY SHA256 288cff11c5267447c5757d5d4ab55d81c33ac5e2ec272d361033f32a0da8d5d4; complete artifact census SHA256 360e797a82df826f4c8df33ab3997f1712912186519d9a1b00c5d4b595fdcc81 (22309 regular files, 4515823883 bytes, zero symlinks). Baked sourceSha ea7f90bca4 is present in PRIMARY and spawner-sidecar.mjs resolveBuildInfo path; spawner SHA256 2712f8de1ddf156be5fcc59d32675c0298d53a616b87fb62f2ae1d214e184da4. Complete measured qualification /tmp/48ad-p537-assembly9-qualification.json. Historical assembly6 is superseded for fixture use because its authenticated catalog refused unknown baked identity. No runtime env identity workaround is permitted. The census is exact: recurse depth first into each directory, iterating fs.readdirSync(dir).sort() with JavaScript default ordering. For each regular file update the outer SHA256 with JSON.stringify([path.relative(artifact,file), stat.mode & 0o777, SHA256(file bytes).digest('hex')]); the final outer hex digest is the fingerprint. Reject symlinks or special files. Qualification details and the actual source before/after census are retained; qualification details are /tmp/48ad-p537-assembly9-qualification.json and actual source before/after census. Before use verify retained source commit/gitlink, exact receipt and artifact fingerprint; reject missing, changed or stale inputs. Treat this source artifact as read-only. The original independent author may copy this qualified tree into its fresh disposable <run>/artifact, verify identical bytes/modes/census there and repeat maintained dependency closure against that copied root before any startup. Do not use donor node_modules links, prior failed/partial artifacts, alter the source artifact, hand-roll an alternate assembler, rebuild product sources or modify any maintained helper. Keep original exact runtime namespace, child HOME/state/DB/listener controls and setup/teardown ceilings; only the explicit private acquisition TTL ceiling is revised to900s under D334; every other resource/work ceiling is unchanged. Artifact import is setup only. Every product/runtime/provider/identity/grant/VM/domain/lease/accepted-input control and genuine intended assertion-red, original author manual test-only binding/frozen manifest revision1, later independent sole48ad source admission and activation re-audit remain required. This revision grants no action by itself; a recorded scoped fixture-use admission and current activation audit must precede original-author use.\nRetained-source lifecycle guard: source materialized by maintained lint:as-committed at the same exact committed SHA; retainCommittedWorkRoot links this root to the exact extant assembly9 artifact, and verifyCommittedWorkRoot(root,sha,requiredPaths,artifact) must pass again immediately before import. A missing root invalidates fixture use; do not relabel a prior artifact to a newly materialized source whose complete prepared-source census differs. Artifact8 is withdrawn for fixture use because its retained source disappeared; artifact9 is a new measured assembly, not inferred equivalence.",
          "behaviorClass": "boundary",
          "requiredEvidence": [
            "Genuine committed intended allow assertion-red, canonical test_runs/native receipts, original-author current manual test-only binding and frozen manifest revision1 for owning WI26007/P536.",
            "Original author eligibility measured against complete actual current/terminal/released/worked history with maintained lineage in same canonical authority scope; server registration rechecks.",
            "Separate real setup-control receipts for primary/authenticated MCP, normal real launch and immutable accepted input, exact standing/provider/grant, both VM/domain/lease maps, actual dependency population and cost, plus teardown."
          ],
          "requiredTestLayers": [
            "integration"
          ],
          "mutationRequired": true,
          "lifecycleStatus": "draft",
          "supersedes": null,
          "exemption": null,
          "falsifier": {
            "observation": "A setup/collection error is called assertion-red; fake provider/host/task observation or caller roots substitute for real positive; source is edited before original enrollment/activation readmission; physical/shipment authority inferred from private tests.",
            "probeMethod": "Independently inspect retained canonical setup/control, native/test_runs and freeze receipts before source admission; reject any missing gate or altered existing frozen bytes."
          },
          "contentHash": "cffba39f41b62b0d568527cbd55c52431b541591022ea33ba9e951e84ab59daf",
          "createdBy": "su-48ad7866-4ca5-48f1-90e7-5c5c4572e6d6",
          "createdAt": "2026-10-25T05:38:02.901Z",
          "acceptedBy": null,
          "acceptedAt": null,
          "acceptanceRef": null,
          "sourceBar": null
        }
      ],
      "count": 1,
      "mode": "current"
    },
    "meta": {
      "ok": true,
      "results": [
        {
          "ok": true,
          "slug": "p2p-public-release-endgame-2026-09-01",
          "harness": "papercusp",
          "archived": false,
          "legacy": false,
          "title": "P2P public release — endgame: drive every lane to a signed GO and shipped plans",
          "status": "ready",
          "startStatus": null,
          "lifecycle": {
            "verdict": "active",
            "disposition": "agreed",
            "contradiction": null,
            "text": "11 of 44 items are still live (0 wip, 7 blocked, 0 needs-human), last activity 0 days ago.",
            "counts": {
              "total": 44,
              "done": 32,
              "dropped": 1,
              "nonTerminal": 11,
              "wip": 0,
              "blocked": 7,
              "needsHuman": 0
            },
            "liveItems": [
              {
                "id": "P-401",
                "effectiveStatus": "blocked"
              },
              {
                "id": "P-403",
                "effectiveStatus": "blocked"
              },
              {
                "id": "P-404",
                "effectiveStatus": "blocked"
              },
              {
                "id": "P-502",
                "effectiveStatus": "blocked"
              },
              {
                "id": "P-503",
                "effectiveStatus": "blocked"
              }
            ],
            "grinding": [
              {
                "itemId": "P-537",
                "workItemId": "WI-6554700010027150",
                "triggers": [
                  "distinct-failures"
                ],
                "fingerprints": [
                  "exit:608d73f8c68b",
                  "exit:c54e258bc7d3"
                ]
              }
            ],
            "iterations": [
              {
                "itemId": "P-403",
                "workItemIds": [
                  "WI-2037678"
                ],
                "attempts": 2,
                "attemptsUntilPass": 2,
                "passed": true,
                "failed": {
                  "product": 0,
                  "harness": 0,
                  "environment": 0,
                  "unclassified": 1
                },
                "cancelled": 0,
                "running": 0,
                "budget": null,
                "overBudget": false
              },
              {
                "itemId": "P-521",
                "workItemIds": [
                  "WI-2144482"
                ],
                "attempts": 8,
                "attemptsUntilPass": 1,
                "passed": true,
                "failed": {
                  "product": 0,
                  "harness": 0,
                  "environment": 0,
                  "unclassified": 1
                },
                "cancelled": 0,
                "running": 0,
                "budget": null,
                "overBudget": false
              },
              {
                "itemId": "P-532",
                "workItemIds": [
                  "WI-6554700010020422"
                ],
                "attempts": 5,
                "attemptsUntilPass": 1,
                "passed": true,
                "failed": {
                  "product": 0,
                  "harness": 0,
                  "environment": 0,
                  "unclassified": 3
                },
                "cancelled": 0,
                "running": 0,
                "budget": null,
                "overBudget": false
              },
              {
                "itemId": "P-535",
                "workItemIds": [
                  "WI-6554700010020424"
                ],
                "attempts": 1,
                "attemptsUntilPass": 1,
                "passed": true,
                "failed": {
                  "product": 0,
                  "harness": 0,
                  "environment": 0,
                  "unclassified": 0
                },
                "cancelled": 0,
                "running": 0,
                "budget": null,
                "overBudget": false
              },
              {
                "itemId": "P-537",
                "workItemIds": [
                  "WI-6554700010027150"
                ],
                "attempts": 4,
                "attemptsUntilPass": null,
                "passed": false,
                "failed": {
                  "product": 0,
                  "harness": 0,
                  "environment": 0,
                  "unclassified": 4
                },
                "cancelled": 0,
                "running": 0,
                "budget": null,
                "overBudget": false
              }
            ],
            "liveItemsTruncated": true,
            "idleDays": 0,
            "stalledAfterDays": 30,
            "unmeasured": [],
            "acceptance": {
              "rubricActive": true,
              "rubricRef": "acceptance-p2p-public-release-endgame-2026-09-01"
            },
            "freshness": {
              "lastActivityAt": "2026-10-25T05:38:06.822Z",
              "sources": [
                {
                  "source": "plan-write",
                  "at": "2026-10-25T05:38:06.822Z"
                },
                {
                  "source": "linked-work-item",
                  "at": null
                }
              ],
              "now": "2026-10-25T06:03:18.575Z"
            }
          },
          "frontmatter": {
            "raw": {
              "title": "P2P public release — endgame: drive every lane to a signed GO and shipped plans",
              "slug": "p2p-public-release-endgame-2026-09-01",
              "status": "ready",
              "created": "2026-09-01",
              "updated": "2026-10-25",
              "owner": "aviynw@gmail.com",
              "frozenTests": "pilot"
            },
            "title": "P2P public release — endgame: drive every lane to a signed GO and shipped plans",
            "slug": "p2p-public-release-endgame-2026-09-01",
            "status": "ready",
            "created": "2026-09-01",
            "updated": "2026-10-25",
            "owner": "aviynw@gmail.com"
          },
          "now": {
            "state": "⚠ BAR READINESS BLOCKED (2026-10-24, after decision-added): bar_snapshot_evidence_plane_unmet, bar_snapshot_proof_stale, bar_snapshot_grading_missing, bar_snapshot_proof_missing, bar_snapshot_clause_not_accepted, bar_snapshot_proof_inadequate. Next repair: Accept the mapped clause: plans:get-specs, then plans:set-specs with lifecycleStatus:\"active\", expectedRevision set to its current revision, and every other field unchanged (keep the sourceBar pin and acceptanceRef; omitting either rides the prior value forward). That provenance-only promotion carries the bound proof and work-item contracts forward: confirm the result reports evidenceCarriedForward > 0 on a clause that had proof. If it is absent, another field changed and the proof must be re-bound at the new revision. Do NOT re-prove or amend the rubric on this code: the proof is not stale, the clause was never accepted. (R-11). (re-evaluated in the same write by the scope-write cascade, P-030/P-031)\n\nP-521 remains todo: its declared prerequisite items are done, while integrated exact-artifact acceptance is not complete. P-401 is blocked by P-521 and P-403 by P-401. Existing inspector EI-26144665755980386 is done; WI-6554700010016971 is DONE/COMMITTED with all10accepted source pins verified, and D266 telemetry/fixture is source-accepted under D-268. Those source dependencies are not a reason to keep waiting or rerun tests. Current production vm-copy entrypoints still explicitly refuse installed-host-binding-unavailable: trusted installed host/key/scope mapping, actual applied provider/capability binding, canonical custody resource/process adapters and independent installed composition qualification remain unavailable. D250/D252 preserve original D249 evidence and acceptance HOLD; D253 permits independent source/private current-build preparation without expanding target authority.",
            "next": "Leader WI-6554700010016282 records the measured installed-composition gap and preserves P-521 acceptance HOLD; any next source-only composition unit must name its existing typed seams, owning tests, scope/provenance and execution ceiling before handoff. Do not reopen completed inspector/bridge units, arm stale source waits, touch the original failed target, rerun J8, or claim P-401 GO/shipment.",
            "raw": "**State:** ⚠ BAR READINESS BLOCKED (2026-10-24, after decision-added): bar_snapshot_evidence_plane_unmet, bar_snapshot_proof_stale, bar_snapshot_grading_missing, bar_snapshot_proof_missing, bar_snapshot_clause_not_accepted, bar_snapshot_proof_inadequate. Next repair: Accept the mapped clause: plans:get-specs, then plans:set-specs with lifecycleStatus:\"active\", expectedRevision set to its current revision, and every other field unchanged (keep the sourceBar pin and acceptanceRef; omitting either rides the prior value forward). That provenance-only promotion carries the bound proof and work-item contracts forward: confirm the result reports evidenceCarriedForward > 0 on a clause that had proof. If it is absent, another field changed and the proof must be re-bound at the new revision. Do NOT re-prove or amend the rubric on this code: the proof is not stale, the clause was never accepted. (R-11). (re-evaluated in the same write by the scope-write cascade, P-030/P-031)\n\nP-521 remains todo: its declared prerequisite items are done, while integrated exact-artifact acceptance is not complete. P-401 is blocked by P-521 and P-403 by P-401. Existing inspector EI-26144665755980386 is done; WI-6554700010016971 is DONE/COMMITTED with all10accepted source pins verified, and D266 telemetry/fixture is source-accepted under D-268. Those source dependencies are not a reason to keep waiting or rerun tests. Current production vm-copy entrypoints still explicitly refuse installed-host-binding-unavailable: trusted installed host/key/scope mapping, actual applied provider/capability binding, canonical custody resource/process adapters and independent installed composition qualification remain unavailable. D250/D252 preserve original D249 evidence and acceptance HOLD; D253 permits independent source/private current-build preparation without expanding target authority.\n\n**Next:** Leader WI-6554700010016282 records the measured installed-composition gap and preserves P-521 acceptance HOLD; any next source-only composition unit must name its existing typed seams, owning tests, scope/provenance and execution ceiling before handoff. Do not reopen completed inspector/bridge units, arm stale source waits, touch the original failed target, rerun J8, or claim P-401 GO/shipment.",
            "lineNumber": 2,
            "nextDerivation": {
              "disposition": "ratified",
              "storedNext": "Leader WI-6554700010016282 records the measured installed-composition gap and preserves P-521 acceptance HOLD; any next source-only composition unit must name its existing typed seams, owning tests, scope/provenance and execution ceiling before handoff. Do not reopen completed inspector/bridge units, arm stale source waits, touch the original failed target, rerun J8, or claim P-401 GO/shipment.",
              "staleStoredRefs": [],
              "contradictions": [],
              "itemId": "P-532",
              "effectiveStatus": "todo",
              "reason": "actionable",
              "candidates": [
                {
                  "id": "P-401",
                  "effectiveStatus": "blocked",
                  "needsHuman": false
                },
                {
                  "id": "P-521",
                  "effectiveStatus": "blocked",
                  "needsHuman": false
                },
                {
                  "id": "P-532",
                  "effectiveStatus": "todo",
                  "needsHuman": false
                },
                {
                  "id": "P-533",
                  "effectiveStatus": "todo",
                  "needsHuman": false
                },
                {
                  "id": "P-403",
                  "effectiveStatus": "blocked",
                  "needsHuman": false
                }
              ],
              "candidatesTruncated": true,
              "blockedOn": [],
              "counts": {
                "total": 44,
                "done": 32,
                "dropped": 1,
                "nonTerminal": 11
              }
            }
          },
          "contentHash": "c5b1c2cf9f5fde34e52aa6211786c79352ead90fac902442f4738125139311b6",
          "version": 580,
          "promotePolicy": {
            "policy": null,
            "warnings": []
          },
          "forcedPast": null,
          "sectionIndex": [
            {
              "heading": "Now",
              "level": 2,
              "chars": 2284
            },
            {
              "heading": "Promoted",
              "level": 2,
              "chars": 9404
            },
            {
              "heading": "Boundaries (read before claiming anything)",
              "level": 2,
              "chars": 1210
            },
            {
              "heading": "Background",
              "level": 2,
              "chars": 954
            },
            {
              "heading": "Existing infrastructure reused",
              "level": 2,
              "chars": 2163
            },
            {
              "heading": "Third-party libraries",
              "level": 2,
              "chars": 564
            },
            {
              "heading": "Requirements",
              "level": 2,
              "chars": 94981
            },
            {
              "heading": "Conformance",
              "level": 2,
              "chars": 24838
            },
            {
              "heading": "Design",
              "level": 2,
              "chars": 2877
            },
            {
              "heading": "Phase 0 — Rig lane + custody (unblock the physical path)",
              "level": 2,
              "chars": 2648
            },
            {
              "heading": "Phase 1 — Pinned witness candidate",
              "level": 2,
              "chars": 868
            },
            {
              "heading": "Phase 2 — Witnesses + live acceptance on the pinned candidate",
              "level": 2,
              "chars": 2540
            },
            {
              "heading": "Phase 3 — Evidence settlement (mostly rig-independent; parallelize)",
              "level": 2,
              "chars": 2319
            },
            {
              "heading": "Phase 4 — GO/NO-GO + ship",
              "level": 2,
              "chars": 2063
            },
            {
              "heading": "Phase 5 — POST-GO canary (explicitly after GO, per D-158)",
              "level": 2,
              "chars": 1302
            },
            {
              "heading": "Appendix — the p2p ship audit (2026-08-31, embedded verbatim content)",
              "level": 2,
              "chars": 9764
            },
            {
              "heading": "Phase 6 — Pre-public contract hardening and integrated acceptance",
              "level": 2,
              "chars": 8920
            },
            {
              "heading": "Phase 7 — Parallel release preparation",
              "level": 2,
              "chars": 2157
            },
            {
              "heading": "Phase 6b — Design-review hardening (owner #2082)",
              "level": 2,
              "chars": 3103
            },
            {
              "heading": "Decisions",
              "level": 2,
              "chars": 729538
            }
          ],
          "counts": {
            "items": 44,
            "decisions": 337,
            "sections": 20
          }
        }
      ],
      "counts": {
        "ok": 1,
        "failed": 0
      }
    }
  },
  "auditReadback": {
    "auditSeq": 124,
    "auditedRevisionSeq": 577,
    "contentHash": "c5b1c2cf9f5fde34e52aa6211786c79352ead90fac902442f4738125139311b6",
    "currentPlanVersion": 580,
    "mappingId": "M-337001",
    "unresolvedBlockers": []
  },
  "lineage": {
    "author": "su-56361318-8122-4c67-be9f-325d9f4f8bf0",
    "ids": [
      "WI-6554700010026007",
      "WI-6554700010016971",
      "WI-2144482"
    ],
    "builders": [
      "su-91da9045-7e4d-49e3-ac9d-08282b9a79b1",
      "su-d30d099f-6213-4052-9e0e-bd62fa818281",
      "su-315c424d-0ca8-4108-aede-41a6d84a6c1d",
      "su-2144a300-1b3d-43a4-acb1-fb88335ea239",
      "su-3ee17ad9-e8f0-4145-bce5-732819d9ea4e",
      "su-respawn-1098f25e5c5f19468aa45d669d968c08",
      "su-32c78573-727f-415f-a3f9-4bf96246b9d1",
      "su-75676c8f-ed12-4217-b88d-57bd6f4043aa",
      "su-168c326a-5a79-452d-aaa0-7167c779fc47",
      "su-3633bdcb-453b-4177-a7fc-dfa2ed6c8ff9",
      "su-48ad7866-4ca5-48f1-90e7-5c5c4572e6d6"
    ],
    "related": [],
    "eligible": true,
    "checkedAt": "2026-10-25T06:11:32.217Z"
  },
  "records": {
    "import.json": {
      "schemaVersion": "p536-qualified-import-v1",
      "retention": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-ea7f90bca4-x5XVpZ",
        "sha": "ea7f90bca42b357aedc80a0f01770a8bd1674f47"
      },
      "run": "/tmp/p2p-p536-48ad-20261024-U1aLGd",
      "source": "/tmp/48ad-p537-build9-Xt4F7n/run/artifact",
      "donor": "/tmp/pcv/papercusp-lint-as-committed-ea7f90bca4-x5XVpZ",
      "commit": "ea7f90bca42b357aedc80a0f01770a8bd1674f47",
      "desktopPin": "96ff0d4663b13b724dc022dd6d7a1b02dd911855",
      "sha256": "360e797a82df826f4c8df33ab3997f1712912186519d9a1b00c5d4b595fdcc81",
      "files": 22309,
      "bytes": 4515823883,
      "objects": 24668,
      "sourceCensusMs": 42112,
      "copiedCensusMs": 33171,
      "totalMs": 81790,
      "closure": "✓ runtime dependency closure resolved inside sidecar (359 packages checked)",
      "runtime": "not-started",
      "product": "not-run",
      "fixtureRevision": 9
    },
    "namespace.json": {
      "workspace": "test-runtime-p2p-vmcopy-p536-48ad-20261024",
      "foreignWorkspace": "test-runtime-p2p-vmcopy-p536-48ad-20261024-foreign"
    },
    "primary-identity.json": {
      "pid": 1861363,
      "exe": "/home/marsh-office/.local/node25/bin/node",
      "stat": "1861363 (node) R 1854639 1805881 1805881 0 -1 4194304 89 0 0 0 0 0 0 0 20 0 1 0 6211319 111161344 0 18446744073709551615 7835648 50332677 140734001472848 0 0 0 0 0 0 0 0 0 17 72 0 0 0 0 0 111405576 111703872 936697856 140734001473791 140734001473887 140734001473887 140734001475534 0\n",
      "httpPort": 43877,
      "pgPort": 45937,
      "run": "/tmp/p2p-p536-48ad-20261024-U1aLGd",
      "spawnedAt": "2026-10-25T06:49:38.385Z"
    },
    "readiness.json": {
      "base": "http://127.0.0.1:43877",
      "pid": 1861363,
      "mallocArenaMax": "2",
      "nodeOptions": "",
      "exitCode": null,
      "signalCode": null,
      "elapsedMs": 30622,
      "attempts": 122,
      "probes": [
        {
          "elapsedMs": 24650,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 24901,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 25152,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 25404,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 25655,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 25906,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 26157,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 26408,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 26659,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 26910,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 27161,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 27412,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 27663,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 27916,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 28167,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 28418,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 28669,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 28921,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 29172,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 29424,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 29676,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 29928,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 30179,
          "error": "TypeError: fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:43877"
        },
        {
          "elapsedMs": 30620,
          "status": 200,
          "service": "papercusp-operator"
        }
      ]
    },
    "authenticated-mcp.json": {
      "authenticated": true,
      "workspaceId": "test-runtime-p2p-vmcopy-p536-48ad-20261024",
      "ownerId": "p536-independent-private-setup",
      "catalogNames": [
        "harness:list",
        "harness:get",
        "harness:status",
        "tasks:list",
        "tasks:get",
        "features:get",
        "features:history",
        "features:search",
        "features:list_related",
        "features:tag_vocabulary",
        "goals:list",
        "goals:get",
        "goals:create",
        "goals:propose",
        "goals:update",
        "blender:attach-goal-evidence",
        "goals:attach-pot",
        "goals:detach-pot",
        "goals:pots",
        "audit:list",
        "intel:spawn_tree",
        "intel:artifacts",
        "papercusp:list_workspaces",
        "pending_events:list",
        "search:query",
        "artifacts:load",
        "artifacts:save",
        "artifacts:append",
        "artifacts:delete",
        "testing:run",
        "testing:runs",
        "watch:create",
        "fleet:assignments",
        "scheduler:get_next",
        "plans:transfer-owner",
        "orchestrate:inspect",
        "reports:publish",
        "reports:get",
        "graph:query",
        "docs:author",
        "docs:get",
        "goals:start",
        "lsp:query",
        "lsp:apply",
        "code:structural",
        "locks:queue",
        "code:pack",
        "code:run",
        "orchestrate:search",
        "orchestrate:run",
        "code:tools",
        "recipes:list",
        "recipes:get",
        "recipes:revise",
        "recipes:search",
        "recipes:run",
        "recipes:candidates",
        "recipes:merge",
        "recipes:sweep",
        "meta:define-datatype",
        "datatypes:list",
        "datatypes:get",
        "people:search",
        "people:get",
        "people:merge",
        "datatypes:install",
        "datatypes:summary",
        "classes:define",
        "classes:list",
        "classes:get",
        "classes:validate",
        "tools:scaffold",
        "meta:define-tool",
        "tools:find",
        "tools:invoke",
        "operator:stats",
        "operator:converse",
        "papercup:converse",
        "architect:chat",
        "brainstorm:chat",
        "oracle:chat",
        "agent_chats:chat",
        "operator:audit",
        "operator:nudge",
        "operator:standing_approvals_list",
        "operator:standing_approvals_decide",
        "operator:standing_approval_mark_shown",
        "operator:voice_utterance_log",
        "operator:voice_debug",
        "operator:voice_prefs",
        "operator:conv_voice",
        "operator:voice_spend_summary",
        "voice:channels",
        "voice:join",
        "voice:leave",
        "voice:status",
        "voice:agent",
        "voice:transcript",
        "ui:dispatch",
        "voice:say",
        "voice:delegate_deep",
        "conversation:recent",
        "conversation:append",
        "consult:get_feedback",
        "consult:reply",
        "consult:decline",
        "consult:close",
        "consult:routing-health",
        "roles:list",
        "roles:get",
        "roles:firing_on",
        "roles:known",
        "hooks:known",
        "agent_tools:list",
        "ui:list_clients",
        "ui:get_state",
        "tui:dispatch",
        "coord:inbox",
        "coord:glance",
        "activity:report",
        "activity:bash-substitution-report",
        "activity:recent",
        "activity:mix",
        "activity:tool-log",
        "journal:record-turn",
        "journal:recent",
        "journal:push-utilization",
        "journal:peer-brief",
        "curation:feed",
        "curation:change-feed",
        "curation:state-of-pot",
        "discovery:pots",
        "discovery:set_pot",
        "pot:declare-wake",
        "pot:wake",
        "pot:status",
        "pot:mug_efficiency",
        "pot:start",
        "pot:pause",
        "pot:set-steering",
        "pot:get-steering",
        "pot:list",
        "pot:get",
        "pot:create",
        "pot:add-member",
        "pot:create_from_repo",
        "platform:enable",
        "platform:contribute",
        "platform:fork_gc",
        "platform:dogfood_verify",
        "pot:dissolve",
        "pot:obliterate",
        "pot:leave",
        "pot:update",
        "pot:cross_grant",
        "pot:beacon_consent",
        "pot:ask",
        "pot:request_work",
        "pot:asks",
        "pot:membership_pending",
        "pot:membership_decide",
        "pot:report",
        "pot:moderation_queue",
        "pot:moderation_resolve",
        "pot:takedown",
        "pot:ban_member",
        "network:board",
        "chat:ask_choice",
        "search:fulltext",
        "search:semantic",
        "personal:search",
        "personal:ask",
        "personal:purge",
        "personal:privacy-rules",
        "personal:declassify",
        "personal:open-sealed",
        "documents:search",
        "documents:read",
        "documents:subscriptions",
        "mail:draft",
        "mail:reply",
        "mail:send",
        "mail:send-draft",
        "calendar:propose",
        "calendar:update",
        "calendar:delete",
        "chat:reply",
        "ticket:file",
        "social:delete",
        "social:post",
        "blog:post",
        "notify:send",
        "social:read",
        "social:reply",
        "social:search",
        "chat:post",
        "memory:remember",
        "memory:search",
        "memory:list",
        "memory:get",
        "facts:assert",
        "facts:retract",
        "claims:retract",
        "facts:list",
        "conventions:governing",
        "probe:emit",
        "probe:get",
        "gates:canary-check",
        "gates:degenerate-check",
        "goals:start-from-package",
        "goals:set-schedule",
        "goals:arm-schedule",
        "goals:set-input-schema",
        "goals:set-output-schema",
        "goals:set-property",
        "goals:apply-package-update",
        "knowledge_packs:list",
        "knowledge_packs:install",
        "knowledge_packs:uninstall",
        "knowledge_packs:set_enabled",
        "knowledge_packs:upgrade",
        "knowledge_packs:sweep",
        "knowledge_packs:export",
        "knowledge_packs:publish",
        "knowledge_packs:candidates",
        "knowledge_packs:decide_candidate",
        "memory:forget",
        "memory:update",
        "memory:sweep",
        "memory:recover-from-transcripts",
        "autoloop:status",
        "autoloop:control",
        "loop:arm",
        "loop:checkpoint",
        "loop:end",
        "loop:session-audit",
        "loop:soak-report",
        "routines:set",
        "loop:standdown-all",
        "loop:status",
        "loop:transfer",
        "logs:read",
        "orders:record",
        "orders:capture",
        "orders:clear",
        "orders:summarize",
        "orders:disposition",
        "orders:reopen",
        "orders:list",
        "orders:get",
        "operator:dedup_check",
        "wiki:backlinks",
        "harness:phase_path",
        "harness:markdown_index",
        "harness:escalation",
        "harness:overview",
        "harness:pending_reviews",
        "harness:health",
        "harness:list_features",
        "harness:membership",
        "deploy:harness",
        "deploy:teardown",
        "harness:migrate-config-json",
        "deploy:status",
        "deploy:pot",
        "deploy:teardown_pot",
        "deploys:vintage",
        "accounts:register",
        "accounts:list",
        "accounts:remove",
        "accounts:status",
        "accounts:reset-rate",
        "accounts:scale_out",
        "accounts:link-start",
        "accounts:link-complete",
        "accounts:link-status",
        "accounts:set-session-override",
        "accounts:get-session-override",
        "accounts:test-egress",
        "egress:provision",
        "egress:list",
        "egress:release",
        "egress:health",
        "accounts:probe-capacity",
        "gateway:status",
        "accounts:pin",
        "accounts:unpin",
        "gateway:reload",
        "gateway:owner_report",
        "gateway:egress_mode",
        "gateway:local_backend_register",
        "gateway:local_backend_list",
        "gateway:local_backend_remove",
        "provisioner:detect_hardware",
        "provisioner:recommend",
        "provisioner:plan_install",
        "provisioner:install",
        "cert:run",
        "cert:catalog",
        "behaviour:run",
        "behaviour:catalog",
        "cross_harness:docs_outline",
        "cross_harness:docs_get",
        "cross_harness:docs_search",
        "cross_harness:plans_list",
        "cross_harness:plans_get",
        "cross_harness:plans_search",
        "actions:recent",
        "notifications:recent",
        "notifications:send_owner",
        "harness:create",
        "instance:capture",
        "instance:boot",
        "instance:clone",
        "operator:preview_prompt",
        "operator:decisions",
        "agents:list",
        "operator:budget",
        "operator:paused",
        "operator:trigger_state",
        "operator:preferences",
        "operator:rate_limit_config",
        "omp:config",
        "omp:sessions",
        "operator:multi_workspace",
        "operator:credentials_status",
        "projects:list",
        "projects:get",
        "projects:spec_revisions",
        "projects:spec_revision",
        "operator:notes",
        "cross_harness:supervisor_notes",
        "cross_harness:recent_activity",
        "plugins:runtime_status",
        "plugins:invoke_action",
        "plugins:fire_event",
        "plugins:tui_panes",
        "tasks:create",
        "tasks:ops",
        "tasks:todo_write",
        "tasks:update_plan",
        "agent_chats:list",
        "agent_chats:get",
        "agent_chats:create",
        "agent_chats:send_message",
        "agent_chats:archive",
        "dev:harnesses",
        "dev:telemetry",
        "dev:code_run_adoption",
        "dev:limit_failure_rate",
        "dev:orient_dedup_rate",
        "dev:audit",
        "dev:sessions",
        "dev:activity",
        "dev:pg_health",
        "dev:pg_active_queries",
        "dev:pg_hot_queries",
        "dev:pg_table_sizes",
        "dev:pg_mutate",
        "dev:pg_query",
        "dev:cache_stats",
        "dev:embed_latency",
        "dev:build_status",
        "dev:pipeline_position",
        "dev:gate_ownership",
        "release:trace",
        "dev:why",
        "dev:coord_categorize",
        "dev:advisory_bet_signal",
        "dev:dogfood_substrate_status",
        "dev:own_log_fork_recover",
        "dev:ipc_echo",
        "dev:state_counter",
        "dev:event_emitter",
        "dev:processes",
        "dev:listening_ports",
        "dev:session_detail",
        "dev:resolve_owner",
        "dev:tool_cooccurrence",
        "processes:kill",
        "processes:list",
        "processes:freeze",
        "processes:limit",
        "turn:interrupt",
        "dev:omp_session",
        "dev:claude_session",
        "flags:list",
        "flags:get",
        "flags:set",
        "flags:attest",
        "autonomy:policy_get",
        "autonomy:policy_set",
        "autonomy:decide",
        "autonomy:record_disposition",
        "autonomy:tripwire_list",
        "autonomy:tripwire_revert",
        "autonomy:graduation_status",
        "trust:list",
        "trust:add",
        "trust:remove",
        "trust:comms",
        "saved_prompts:list",
        "backup:snapshot_create",
        "backup:snapshot_list",
        "backup:restore",
        "backup:restore_clone_cleanup",
        "backup:diff",
        "backup:promote",
        "backup:rollback",
        "backup:settings_get",
        "backup:settings_set",
        "setup:status",
        "setup:set_git_identity",
        "setup:set_telemetry",
        "setup:set_update_channel",
        "setup:save_key",
        "setup:save_integration_key",
        "setup:complete",
        "setup:set_tutorial_progress",
        "docs:outline",
        "docs:search",
        "harness_docs:record",
        "harness_docs:list",
        "harness_docs:anchor",
        "harness_docs:verify",
        "harness_docs:set_overlay",
        "harness_docs:regenerate",
        "harness_docs:ingest",
        "harness_docs:retire",
        "locks:acquire",
        "locks:release",
        "locks:heartbeat",
        "locks:cancel_wait",
        "locks:acquire_resource",
        "locks:register_resource",
        "locks:release_resource",
        "locks:heartbeat_resource",
        "locks:acquire_granular",
        "locks:release_granular",
        "locks:list",
        "locks:check_command",
        "capability:inspect",
        "capability:bash",
        "capability:bash_output",
        "capability:bash_kill",
        "capability:pty_open",
        "capability:pty_write_stdin",
        "capability:pty_resize",
        "capability:pty_read_screen",
        "capability:pty_kill",
        "capability:terminal",
        "mode:set",
        "capability:launch-agent",
        "capability:read",
        "capability:list",
        "capability:write",
        "capability:edit",
        "capability:patch",
        "capability:notebook_edit",
        "capability:git",
        "capability:fetch",
        "capability:computer",
        "computer:provision_desktop",
        "computer:release_desktop",
        "computer:list_desktops",
        "computer:observe",
        "computer:click_element",
        "computer:record",
        "dev:restart",
        "dev:service_health",
        "supervision:annotate-pause",
        "supervision:announce-quiesce",
        "dev:rate_governor_status",
        "dev:stall_waker_status",
        "db:migrate",
        "db:check_drift",
        "db:migrations",
        "issues:list",
        "db:next-migration",
        "testing:prune-orphan-runs",
        "testing:flakiness",
        "testing:case-categories",
        "testing:record-run",
        "testing:run-status",
        "testing:verdict_diff",
        "testing:coverage",
        "build:typecheck",
        "fleet:create",
        "fleet:list",
        "fleet:status",
        "fleet:join",
        "fleet:leave",
        "fleet:take-leadership",
        "fleet:wind-down",
        "fleet:resume",
        "fleet:pause",
        "fleet:supersede",
        "fleet:launch-on-plan",
        "fleet:headcount-target",
        "fleet:request_remote_spawn",
        "fleet:recolor",
        "fleet:reconfigure-member",
        "fleet:kill",
        "fleet:respawn-member",
        "coord:whoami",
        "coord:rebind-identity",
        "coord:presence",
        "coord:roster",
        "coord:declare-intent",
        "coord:goal",
        "coord:wake-mode",
        "coord:wake-queue",
        "coord:walls",
        "events:status",
        "coord:orient",
        "mode:list",
        "mode:get",
        "slash:dispatch",
        "coord:send",
        "coord:supersede",
        "coord:dispatch",
        "coord:wake",
        "coord:message-agent",
        "coord:await-inbox",
        "inbox:triage",
        "inbox:bulk-run-manifest",
        "inbox:bulk-run-act",
        "inbox:bulk-run-report",
        "inbox:bulk-run-settle",
        "inbox:automation-policy",
        "coord:emit",
        "coord:conditions",
        "coord:ack",
        "coord:focus-window",
        "coord:mark-terminal",
        "coord:couple",
        "coord:decouple",
        "coord:thread",
        "coord:read",
        "coord:escalate",
        "coord:escalations",
        "coord:resolve",
        "coord:handoff",
        "coord:handoffs",
        "coord:feed",
        "coord:catch-up",
        "coord:retract",
        "fleet:delivery",
        "new_subagent:request",
        "new_subagent:approve",
        "topics:list",
        "topics:create",
        "topics:unsubscribe",
        "topics:merge",
        "topics:tag",
        "topics:feed",
        "conversations:post",
        "conversations:answer",
        "conversations:resolve",
        "conversations:join",
        "conversations:list",
        "conversations:get",
        "conversations:promote",
        "conversations:supersede",
        "conversations:withdraw",
        "improvements:capture",
        "improvements:agent-review",
        "improvements:digest",
        "improvements:filing-classes",
        "improvements:triage",
        "improvements:resolve",
        "improvements:watchdog-status",
        "improvements:keyless-digest",
        "improvements:bug-inflow",
        "improvements:learning_loops",
        "improvements:set-watchdog-tunables",
        "watchdog:status",
        "config:doors-get",
        "config:doors-set",
        "config:doors-set-session",
        "config:list-overrides",
        "config:reset-overrides",
        "config:set-compaction-limit",
        "config:role-launch",
        "config:tiers-get",
        "config:tiers-set",
        "config:terminal-emulator",
        "session:request-compaction",
        "session:carry-drill",
        "session:end",
        "sessions:search",
        "sessions:read",
        "sessions:list",
        "sessions:timeline",
        "sessions:digest",
        "sessions:ingest-gate-event",
        "sessions:record-prompt-origin",
        "sessions:list-pending-gates",
        "sessions:rename",
        "db:migrate-policy",
        "routines:list",
        "routines:fire",
        "dream:control",
        "routines:group-set",
        "routines:revert",
        "git-sync:run",
        "git-sync:send-green",
        "pot_git:integration_requests",
        "pot_git:secrets_exemptions",
        "schedule:inventory",
        "telemetry:set_buffer",
        "db:txn-timeouts",
        "capability:grant_role",
        "capability:revoke_role",
        "capability_envelope:set_role",
        "prompt:role_override",
        "fleet:opus_budget",
        "accounts:scale_policy",
        "improvements:set-auto-policy",
        "gym:set-gates",
        "work_items:reclaim_config",
        "coord:handoff_config",
        "coord:orientation_telemetry",
        "coord:session_reaper_config",
        "pot:control_policy",
        "workspace:work_scope",
        "workspace:work_scope_status",
        "governance:policy",
        "release:checkpoint-config",
        "release:repair-queue",
        "release:test-downgrade",
        "learning:set-scout-budget",
        "gym:arm",
        "governor:arm",
        "governor:admission_cutover",
        "learning:set-pot-scope",
        "quota:set_tool",
        "auth:set_full_access_roles",
        "clamp:set_safe_tools",
        "exec_sandbox:set_policy",
        "capability_tier:set",
        "release:deploy",
        "release:checkpoint-run",
        "release:checkpoint-cancel",
        "release:cut",
        "rubrics:list",
        "rubrics:get",
        "rubrics:search",
        "rubrics:propose",
        "rubrics:repair",
        "rubrics:amend",
        "rubrics:amend-status",
        "rubrics:check-approver",
        "rubrics:ratify",
        "rubrics:retire",
        "rubrics:set-history-reset",
        "rubrics:trend",
        "scorecards:list",
        "scorecards:get",
        "scorecards:freshness",
        "scorecards:evaluate",
        "scorecards:repair",
        "plans:evaluate-spec-test-adequacy",
        "scorecards:emit",
        "scorecards:retract",
        "pilot:assign",
        "pilot:collect",
        "health:ack",
        "health:unack",
        "work_items:link",
        "work_items:create",
        "work_items:get",
        "work_items:list",
        "work_items:export",
        "work_items:claimable",
        "work_items:stranded",
        "work_items:burn_down",
        "work_items:search",
        "work_items:set_state",
        "work_items:withdraw",
        "work_items:set_live_verified",
        "work_items:complete",
        "work_items:claim",
        "work_items:pickup",
        "work_items:release",
        "work_items:request_release",
        "work_items:decline_release_request",
        "work_items:withdraw_release_request",
        "work_items:park",
        "work_items:hold_open",
        "work_items:reorder",
        "work_items:links",
        "work_items:set_blocker",
        "work_items:tag",
        "work_items:subscribe",
        "work_items:comment",
        "work_items:update",
        "work_items:checkpoint",
        "work_items:amend",
        "work_items:expand",
        "work_items:promote",
        "work_items:admit",
        "work_items:bulk_dedup",
        "work_items:claim_next",
        "work_items:rehome",
        "work_items:observe",
        "scheduler:set_claim_spec",
        "scheduler:get_claim_spec",
        "scheduler:pull_ledger",
        "scheduler:preview_spec_delta",
        "p2p:trace",
        "hive:store_breakdown",
        "resource:delegate",
        "resource:offers",
        "scheduler:running",
        "work_items:co_locate",
        "work_items:set_priority",
        "work_items:set_redundancy",
        "work_items:claim_replica",
        "work_items:record_replica_result",
        "work_items:judge_redundancy",
        "work_items:redundancy_status",
        "work_items:completion_stats",
        "work_items:acceptance_adoption",
        "fleet:cancel",
        "fleet:tree",
        "fleet:supervise",
        "fleet:admit",
        "fleet:governor",
        "fleet:capacity",
        "fleet:leader-brief",
        "fleet:audit",
        "fleet:bench",
        "fleet:invariant",
        "fleet:require-checkpoint",
        "fleet:place_batch",
        "fleet:drain",
        "fleet:cup_mail",
        "fleet:selected_cup",
        "fleet:sandbox_deps",
        "coord:vote",
        "coord:deliberate",
        "coord:ask-owner",
        "coord:thread-post",
        "coord:watermark",
        "coord:plan-events",
        "plans:set-now",
        "plans:set-plan-status",
        "plans:set-status",
        "plans:promote",
        "plans:list",
        "plans:get",
        "plans:get-properties",
        "plans:set-property",
        "plans:acceptance-disposition",
        "plans:blind-review",
        "plans:get-specs",
        "plans:spec-reconciliation",
        "plans:set-specs",
        "plans:bind-spec-evidence",
        "plans:bind-independent-verification",
        "plans:get-spec-evidence",
        "plans:evidence-measuring-paths",
        "plans:certify-spec-clauses",
        "plans:evaluate-spec-quality",
        "plans:items",
        "plans:get-item",
        "plans:get-template-data",
        "plans:set-template-data",
        "plans:get-input-schema",
        "plans:governance-event",
        "plans:set-input-schema",
        "plans:get-output-schema",
        "plans:set-output-schema",
        "plans:publish-outputs",
        "plans:attention",
        "plans:search",
        "plans:lint",
        "plans:export",
        "plans:new",
        "plans:cleanup-manifest",
        "plans:cleanup-act",
        "plans:cleanup-report",
        "plans:cleanup-settle",
        "plans:set-importance",
        "plans:add-decision",
        "plans:set-decision-body",
        "plans:ratify-decision",
        "plans:add-item",
        "plans:audit",
        "plans:audit-unshipped",
        "plans:set-content",
        "plans:set-content-chunk",
        "plans:edit",
        "plans:set-frontmatter",
        "plans:set-initiative",
        "plans:set-frontmatter-field",
        "plans:set-title",
        "plans:set-item-blocked-by",
        "plans:set-item-phase",
        "plans:conformance",
        "plans:set-schedule",
        "plans:run-now",
        "plans:arm-schedule",
        "plans:disarm-schedule",
        "plans:revisions",
        "plans:backfill-revisions",
        "plans:migrate-acceptance-bars",
        "plans:acceptance-bar-census",
        "plans:verification-health",
        "plans:backfill-dependency-edges",
        "plans:revision-transcript",
        "plans:summarize-revision",
        "plans:revision-diff",
        "plans:run-transcript",
        "plans:start",
        "plans:pause",
        "plans:set-priority",
        "plans:set-verification-profile",
        "plan-types:define",
        "plan-types:get",
        "plan-types:list",
        "plan-types:retire",
        "plan-types:pin",
        "plans:set-archived",
        "plans:launch",
        "plans:resume",
        "plans:runs",
        "plans:set-run-status",
        "plans:apply-plan-block",
        "plan_items:adopt_name",
        "plan_items:assign",
        "plan_items:unassign",
        "plan_items:my_items",
        "plan_items:claim",
        "plan_items:convert",
        "plan_items:release",
        "plan_items:heartbeat",
        "plan_items:status",
        "plan_items:join_group",
        "plan_items:leave_group",
        "substrate:revoke_self_device",
        "substrate:revoke_contributor",
        "blueprint:validate",
        "blueprint:create",
        "blueprint:extend",
        "identities:create",
        "identities:list",
        "identities:get",
        "identities:validate",
        "identities:preview",
        "blueprint:publish",
        "blueprint:submit",
        "blueprint:read-private-input",
        "blueprint:status",
        "blueprint:result",
        "blueprint:events",
        "blueprint:cancel",
        "blueprint:signal",
        "blueprint:resume",
        "cupboard:publish-app",
        "cupboard:publish-plugin",
        "cupboard:publish-template",
        "cupboard:install-blueprint",
        "cupboard:install-plugin",
        "cupboard:install-template",
        "cupboard:install-app",
        "cupboard:publish-rubric",
        "cupboard:install-rubric",
        "cupboard:publish-rule",
        "cupboard:install-rule",
        "cupboard:publish-plan",
        "cupboard:install-plan",
        "cupboard:publish-recipe",
        "cupboard:install-recipe",
        "cupboard:publish-goal",
        "cupboard:install-goal",
        "cupboard:publish-theme",
        "cupboard:install-theme",
        "cupboard:publish-datatype",
        "cupboard:install-datatype",
        "cupboard:publish-event",
        "cupboard:install-event",
        "cupboard:search",
        "cupboard:my-listings",
        "cupboard:unpublish",
        "cupboard:checkout",
        "cupboard:publish-offer",
        "cupboard:refund-request",
        "cupboard:support-request",
        "cupboard:commerce-dashboards",
        "cupboard:ledger-chain",
        "cupboard:ledger-chain-witness",
        "cupboard:ledger-anchor",
        "cupboard:ledger-anchor-run",
        "cupboard:payment-receipt",
        "cupboard:statement-attestation",
        "cupboard:reconciliation",
        "cupboard:bind-wallet",
        "pot:equity",
        "cupboard:bind-identity-funding",
        "cupboard:meter-invocation",
        "blueprint:catalog",
        "templates:list",
        "templates:get-guide",
        "templates:new-app",
        "harness:generate-from-repo",
        "harness:configure",
        "gym:judge",
        "gym:signals",
        "review:approve",
        "merge:approve",
        "experiment:catalog",
        "experiment:run",
        "experiment:results",
        "blender:grade-idea",
        "blender:ideation-feedback",
        "blender:route-idea",
        "blender:ideate-pass-record",
        "blender:success-metrics",
        "blender:run-drill",
        "blender:goal-drafts",
        "change_ledger:list",
        "change_ledger:calendar",
        "decision_ledger:list",
        "decision_ledger:summary",
        "ablation:report",
        "calibration:summary",
        "events:graph",
        "events:await",
        "events:emit",
        "rules:validate",
        "rules:create",
        "rules:list",
        "rules:get",
        "rules:enable",
        "rules:disable",
        "rules:delete",
        "rules:test",
        "events:cancel",
        "triggers:list",
        "triggers:create",
        "triggers:create-webhook",
        "triggers:rotate-webhook-secret",
        "triggers:bind",
        "triggers:arm",
        "triggers:disarm",
        "trigger-packs:review",
        "trigger-packs:arm",
        "trigger-packs:uninstall",
        "trigger-packs:export",
        "triggers:run-with-last-event",
        "triggers:status",
        "triggers:read-payload",
        "events:unsubscribe",
        "state:read",
        "state:subscribe",
        "host:memory_pressure",
        "governor:state_snapshot",
        "lsp:admission_snapshot",
        "events:catalog",
        "deploy:await",
        "checkpoint:await",
        "work-item:await",
        "service:await-up",
        "git-sync:await",
        "plan-item:await",
        "fleet:await-drained",
        "events:lost-wake-check",
        "rationale:feed",
        "rationale:reproject",
        "lexicon:active_pack",
        "storage:usage",
        "storage:census",
        "storage:prune",
        "storage:pin",
        "access:list",
        "access:create",
        "access:pause",
        "access:revoke",
        "reports:list",
        "reports:search",
        "reports:retire"
      ],
      "port": 43877,
      "elapsedMs": 124800
    },
    "primary-control.json": {
      "schemaVersion": "p536-primary-control-v1",
      "run": "/tmp/p2p-p536-48ad-20261024-U1aLGd",
      "pid": 1861363,
      "health": {
        "ok": true,
        "service": "papercusp-operator",
        "sha": "ea7f90bca4",
        "version": "0.0.0",
        "claimSpec": {
          "specVersion": "1.0",
          "revisionAdoption": [
            "first"
          ]
        },
        "ts": "2026-10-25T06:50:08.995Z"
      },
      "actualPort": 43877,
      "pgPort": 45937,
      "registry": {
        "workspace": "test-runtime-p2p-vmcopy-p536-48ad-20261024",
        "foreignWorkspace": "test-runtime-p2p-vmcopy-p536-48ad-20261024-foreign"
      },
      "elapsedMs": 124800,
      "authenticatedMcp": "passed",
      "worker": "not-run",
      "product": "not-run"
    },
    "primary-attempt.json": {
      "run": "/tmp/p2p-p536-48ad-20261024-U1aLGd",
      "startedAt": "2026-10-25T06:48:06.839Z",
      "elapsedMs": 127397,
      "failure": null,
      "teardown": [
        {
          "pid": 1861363,
          "phase": "start",
          "elapsedMs": 0,
          "exitCode": null,
          "signalCode": null,
          "sigtermAccepted": null,
          "sigkillAccepted": null,
          "exitObserved": false,
          "closeObserved": false,
          "kernelProcess": {
            "status": "present",
            "state": "R",
            "startTicks": "6211319",
            "waitChannel": "0"
          }
        },
        {
          "pid": 1861363,
          "phase": "postgres captured",
          "elapsedMs": 23,
          "exitCode": null,
          "signalCode": null,
          "sigtermAccepted": null,
          "sigkillAccepted": null,
          "exitObserved": false,
          "closeObserved": false,
          "kernelProcess": {
            "status": "present",
            "state": "S",
            "startTicks": "6211319",
            "waitChannel": "ep_poll"
          },
          "postgres": [
            {
              "pid": 1864646,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211648",
              "postmaster": true,
              "state": "S"
            },
            {
              "pid": 1865486,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1865487,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1865488,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1865489,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1865490,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1865496,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1865497,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1865498,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888177,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888178,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888179,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888182,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888183,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888185,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888186,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888188,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888190,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888191,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888192,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888193,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888194,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888195,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888196,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888198,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888199,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888200,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888201,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888202,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888205,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888208,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888213,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888217,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888219,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888220,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888222,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888224,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888229,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888235,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888240,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888244,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888245,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888246,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888248,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888249,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888250,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888284,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888286,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888287,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888288,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888289,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888291,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888292,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888293,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888295,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888296,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888298,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888299,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888339,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888352,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888422,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888423,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888676,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888677,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888678,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888934,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214435",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888948,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214437",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1889225,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214472",
              "postmaster": false,
              "state": "S"
            }
          ]
        },
        {
          "pid": 1861363,
          "phase": "signal",
          "elapsedMs": 27,
          "exitCode": null,
          "signalCode": null,
          "sigtermAccepted": true,
          "sigkillAccepted": null,
          "exitObserved": false,
          "closeObserved": false,
          "kernelProcess": {
            "status": "present",
            "state": "R",
            "startTicks": "6211319",
            "waitChannel": "0"
          },
          "postgres": [
            {
              "pid": 1864646,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211648",
              "postmaster": true,
              "state": "S"
            },
            {
              "pid": 1865486,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1865487,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1865488,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1865489,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1865490,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1865496,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1865497,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1865498,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888177,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888178,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888179,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888182,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888183,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888185,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888186,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888188,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888190,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888191,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888192,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888193,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888194,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888195,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888196,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888198,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888199,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888200,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888201,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888202,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888205,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888208,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888213,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888217,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888219,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888220,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888222,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888224,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888229,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888235,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888240,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888244,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888245,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888246,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888248,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888249,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888250,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888284,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888286,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888287,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888288,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888289,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888291,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888292,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888293,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888295,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888296,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888298,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888299,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888339,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888352,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888422,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888423,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888676,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888677,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888678,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888934,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214435",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1888948,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214437",
              "postmaster": false,
              "state": "S"
            },
            {
              "pid": 1889225,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214472",
              "postmaster": false,
              "state": "S"
            }
          ],
          "signal": "SIGTERM",
          "accepted": true
        },
        {
          "pid": 1861363,
          "phase": "exit",
          "elapsedMs": 2587,
          "exitCode": 0,
          "signalCode": null,
          "sigtermAccepted": true,
          "sigkillAccepted": null,
          "exitObserved": true,
          "closeObserved": false,
          "kernelProcess": {
            "state": null,
            "startTicks": null,
            "waitChannel": null,
            "status": "absent"
          },
          "postgres": [
            {
              "pid": 1864646,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211648",
              "postmaster": true,
              "state": null
            },
            {
              "pid": 1865486,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865487,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865488,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865489,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865490,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865496,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865497,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865498,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888177,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888178,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888179,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888182,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888183,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888185,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888186,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888188,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888190,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888191,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888192,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888193,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888194,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888195,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888196,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888198,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888199,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888200,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888201,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888202,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888205,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888208,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888213,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888217,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888219,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888220,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888222,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888224,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888229,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888235,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888240,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888244,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888245,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888246,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888248,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888249,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888250,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888284,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888286,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888287,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888288,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888289,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888291,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888292,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888293,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888295,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888296,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888298,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888299,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888339,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888352,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888422,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888423,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888676,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888677,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888678,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888934,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214435",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888948,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214437",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1889225,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214472",
              "postmaster": false,
              "state": null
            }
          ]
        },
        {
          "pid": 1861363,
          "phase": "close",
          "elapsedMs": 2589,
          "exitCode": 0,
          "signalCode": null,
          "sigtermAccepted": true,
          "sigkillAccepted": null,
          "exitObserved": true,
          "closeObserved": true,
          "kernelProcess": {
            "state": null,
            "startTicks": null,
            "waitChannel": null,
            "status": "absent"
          },
          "postgres": [
            {
              "pid": 1864646,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211648",
              "postmaster": true,
              "state": null
            },
            {
              "pid": 1865486,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865487,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865488,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865489,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865490,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865496,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865497,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865498,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888177,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888178,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888179,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888182,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888183,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888185,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888186,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888188,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888190,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888191,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888192,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888193,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888194,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888195,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888196,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888198,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888199,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888200,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888201,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888202,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888205,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888208,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888213,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888217,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888219,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888220,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888222,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888224,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888229,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888235,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888240,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888244,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888245,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888246,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888248,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888249,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888250,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888284,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888286,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888287,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888288,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888289,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888291,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888292,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888293,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888295,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888296,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888298,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888299,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888339,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888352,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888422,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888423,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888676,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888677,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888678,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888934,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214435",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888948,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214437",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1889225,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214472",
              "postmaster": false,
              "state": null
            }
          ]
        },
        {
          "pid": 1861363,
          "phase": "postgres stopped",
          "elapsedMs": 2593,
          "exitCode": 0,
          "signalCode": null,
          "sigtermAccepted": true,
          "sigkillAccepted": null,
          "exitObserved": true,
          "closeObserved": true,
          "kernelProcess": {
            "state": null,
            "startTicks": null,
            "waitChannel": null,
            "status": "absent"
          },
          "postgres": [
            {
              "pid": 1864646,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211648",
              "postmaster": true,
              "state": null
            },
            {
              "pid": 1865486,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865487,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865488,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865489,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865490,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865496,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865497,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865498,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888177,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888178,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888179,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888182,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888183,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888185,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888186,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888188,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888190,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888191,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888192,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888193,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888194,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888195,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888196,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888198,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888199,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888200,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888201,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888202,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888205,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888208,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888213,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888217,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888219,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888220,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888222,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888224,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888229,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888235,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888240,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888244,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888245,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888246,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888248,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888249,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888250,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888284,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888286,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888287,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888288,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888289,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888291,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888292,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888293,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888295,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888296,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888298,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888299,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888339,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888352,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888422,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888423,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888676,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888677,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888678,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888934,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214435",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888948,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214437",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1889225,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214472",
              "postmaster": false,
              "state": null
            }
          ]
        },
        {
          "pid": 1861363,
          "phase": "complete",
          "elapsedMs": 2594,
          "exitCode": 0,
          "signalCode": null,
          "sigtermAccepted": true,
          "sigkillAccepted": null,
          "exitObserved": true,
          "closeObserved": true,
          "kernelProcess": {
            "state": null,
            "startTicks": null,
            "waitChannel": null,
            "status": "absent"
          },
          "postgres": [
            {
              "pid": 1864646,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211648",
              "postmaster": true,
              "state": null
            },
            {
              "pid": 1865486,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865487,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865488,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865489,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865490,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865496,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865497,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1865498,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888177,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888178,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888179,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888182,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888183,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888185,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888186,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888188,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888190,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888191,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888192,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888193,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888194,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888195,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888196,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888198,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888199,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888200,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888201,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888202,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888205,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888208,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888213,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888217,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888219,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888220,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888222,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888224,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888229,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888235,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888240,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888244,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888245,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888246,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888248,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888249,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888250,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888284,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888286,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888287,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888288,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888289,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888291,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888292,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888293,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888295,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888296,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888298,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888299,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888339,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888352,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888422,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888423,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888676,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888677,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888678,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888934,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214435",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1888948,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214437",
              "postmaster": false,
              "state": null
            },
            {
              "pid": 1889225,
              "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214472",
              "postmaster": false,
              "state": null
            }
          ]
        }
      ]
    }
  },
  "teardown": [
    {
      "pid": 1861363,
      "phase": "start",
      "elapsedMs": 0,
      "exitCode": null,
      "signalCode": null,
      "sigtermAccepted": null,
      "sigkillAccepted": null,
      "exitObserved": false,
      "closeObserved": false,
      "kernelProcess": {
        "status": "present",
        "state": "R",
        "startTicks": "6211319",
        "waitChannel": "0"
      }
    },
    {
      "pid": 1861363,
      "phase": "postgres captured",
      "elapsedMs": 23,
      "exitCode": null,
      "signalCode": null,
      "sigtermAccepted": null,
      "sigkillAccepted": null,
      "exitObserved": false,
      "closeObserved": false,
      "kernelProcess": {
        "status": "present",
        "state": "S",
        "startTicks": "6211319",
        "waitChannel": "ep_poll"
      },
      "postgres": [
        {
          "pid": 1864646,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211648",
          "postmaster": true,
          "state": "S"
        },
        {
          "pid": 1865486,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1865487,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1865488,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1865489,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1865490,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1865496,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1865497,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1865498,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888177,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888178,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888179,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888182,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888183,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888185,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888186,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888188,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888190,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888191,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888192,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888193,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888194,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888195,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888196,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888198,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888199,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888200,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888201,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888202,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888205,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888208,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888213,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888217,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888219,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888220,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888222,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888224,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888229,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888235,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888240,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888244,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888245,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888246,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888248,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888249,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888250,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888284,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888286,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888287,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888288,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888289,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888291,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888292,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888293,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888295,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888296,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888298,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888299,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888339,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888352,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888422,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888423,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888676,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888677,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888678,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888934,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214435",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888948,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214437",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1889225,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214472",
          "postmaster": false,
          "state": "S"
        }
      ]
    },
    {
      "pid": 1861363,
      "phase": "signal",
      "elapsedMs": 27,
      "exitCode": null,
      "signalCode": null,
      "sigtermAccepted": true,
      "sigkillAccepted": null,
      "exitObserved": false,
      "closeObserved": false,
      "kernelProcess": {
        "status": "present",
        "state": "R",
        "startTicks": "6211319",
        "waitChannel": "0"
      },
      "postgres": [
        {
          "pid": 1864646,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211648",
          "postmaster": true,
          "state": "S"
        },
        {
          "pid": 1865486,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1865487,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1865488,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1865489,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1865490,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1865496,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1865497,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1865498,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888177,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888178,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888179,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888182,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888183,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888185,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888186,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888188,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888190,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888191,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888192,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888193,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888194,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888195,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888196,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888198,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888199,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888200,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888201,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888202,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888205,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888208,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888213,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888217,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888219,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888220,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888222,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888224,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888229,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888235,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888240,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888244,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888245,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888246,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888248,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888249,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888250,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888284,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888286,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888287,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888288,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888289,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888291,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888292,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888293,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888295,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888296,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888298,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888299,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888339,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888352,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888422,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888423,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888676,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888677,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888678,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888934,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214435",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1888948,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214437",
          "postmaster": false,
          "state": "S"
        },
        {
          "pid": 1889225,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214472",
          "postmaster": false,
          "state": "S"
        }
      ],
      "signal": "SIGTERM",
      "accepted": true
    },
    {
      "pid": 1861363,
      "phase": "exit",
      "elapsedMs": 2587,
      "exitCode": 0,
      "signalCode": null,
      "sigtermAccepted": true,
      "sigkillAccepted": null,
      "exitObserved": true,
      "closeObserved": false,
      "kernelProcess": {
        "state": null,
        "startTicks": null,
        "waitChannel": null,
        "status": "absent"
      },
      "postgres": [
        {
          "pid": 1864646,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211648",
          "postmaster": true,
          "state": null
        },
        {
          "pid": 1865486,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865487,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865488,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865489,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865490,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865496,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865497,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865498,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888177,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888178,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888179,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888182,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888183,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888185,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888186,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888188,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888190,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888191,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888192,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888193,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888194,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888195,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888196,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888198,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888199,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888200,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888201,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888202,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888205,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888208,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888213,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888217,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888219,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888220,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888222,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888224,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888229,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888235,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888240,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888244,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888245,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888246,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888248,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888249,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888250,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888284,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888286,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888287,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888288,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888289,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888291,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888292,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888293,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888295,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888296,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888298,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888299,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888339,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888352,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888422,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888423,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888676,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888677,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888678,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888934,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214435",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888948,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214437",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1889225,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214472",
          "postmaster": false,
          "state": null
        }
      ]
    },
    {
      "pid": 1861363,
      "phase": "close",
      "elapsedMs": 2589,
      "exitCode": 0,
      "signalCode": null,
      "sigtermAccepted": true,
      "sigkillAccepted": null,
      "exitObserved": true,
      "closeObserved": true,
      "kernelProcess": {
        "state": null,
        "startTicks": null,
        "waitChannel": null,
        "status": "absent"
      },
      "postgres": [
        {
          "pid": 1864646,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211648",
          "postmaster": true,
          "state": null
        },
        {
          "pid": 1865486,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865487,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865488,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865489,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865490,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865496,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865497,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865498,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888177,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888178,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888179,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888182,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888183,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888185,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888186,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888188,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888190,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888191,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888192,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888193,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888194,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888195,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888196,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888198,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888199,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888200,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888201,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888202,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888205,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888208,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888213,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888217,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888219,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888220,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888222,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888224,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888229,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888235,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888240,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888244,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888245,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888246,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888248,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888249,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888250,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888284,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888286,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888287,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888288,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888289,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888291,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888292,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888293,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888295,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888296,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888298,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888299,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888339,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888352,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888422,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888423,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888676,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888677,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888678,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888934,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214435",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888948,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214437",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1889225,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214472",
          "postmaster": false,
          "state": null
        }
      ]
    },
    {
      "pid": 1861363,
      "phase": "postgres stopped",
      "elapsedMs": 2593,
      "exitCode": 0,
      "signalCode": null,
      "sigtermAccepted": true,
      "sigkillAccepted": null,
      "exitObserved": true,
      "closeObserved": true,
      "kernelProcess": {
        "state": null,
        "startTicks": null,
        "waitChannel": null,
        "status": "absent"
      },
      "postgres": [
        {
          "pid": 1864646,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211648",
          "postmaster": true,
          "state": null
        },
        {
          "pid": 1865486,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865487,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865488,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865489,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865490,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865496,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865497,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865498,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888177,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888178,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888179,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888182,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888183,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888185,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888186,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888188,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888190,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888191,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888192,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888193,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888194,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888195,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888196,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888198,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888199,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888200,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888201,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888202,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888205,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888208,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888213,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888217,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888219,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888220,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888222,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888224,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888229,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888235,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888240,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888244,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888245,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888246,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888248,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888249,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888250,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888284,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888286,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888287,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888288,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888289,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888291,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888292,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888293,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888295,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888296,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888298,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888299,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888339,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888352,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888422,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888423,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888676,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888677,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888678,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888934,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214435",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888948,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214437",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1889225,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214472",
          "postmaster": false,
          "state": null
        }
      ]
    },
    {
      "pid": 1861363,
      "phase": "complete",
      "elapsedMs": 2594,
      "exitCode": 0,
      "signalCode": null,
      "sigtermAccepted": true,
      "sigkillAccepted": null,
      "exitObserved": true,
      "closeObserved": true,
      "kernelProcess": {
        "state": null,
        "startTicks": null,
        "waitChannel": null,
        "status": "absent"
      },
      "postgres": [
        {
          "pid": 1864646,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211648",
          "postmaster": true,
          "state": null
        },
        {
          "pid": 1865486,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865487,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211715",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865488,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865489,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865490,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865496,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865497,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1865498,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6211716",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888177,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888178,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888179,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888182,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214374",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888183,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888185,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888186,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888188,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888190,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888191,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888192,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888193,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888194,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888195,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888196,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888198,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888199,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888200,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888201,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888202,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888205,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888208,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888213,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888217,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214375",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888219,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888220,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888222,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888224,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888229,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888235,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888240,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888244,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888245,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888246,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888248,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888249,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888250,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214376",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888284,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888286,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888287,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888288,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888289,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888291,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888292,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888293,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888295,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888296,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888298,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888299,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214377",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888339,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888352,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214381",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888422,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888423,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214388",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888676,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888677,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888678,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214409",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888934,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214435",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1888948,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214437",
          "postmaster": false,
          "state": null
        },
        {
          "pid": 1889225,
          "identity": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:6214472",
          "postmaster": false,
          "state": null
        }
      ]
    }
  ],
  "actualLoadedDescriptors": [
    {
      "name": "tools:invoke",
      "description": "Call ANY tool in the full tool catalog by name, even one not in your loaded tool list. ⚠ Use colon tool names (flags:set); NEVER underscored display names. Args go in `args`. The call is dispatched server-side and gated exactly as a direct call would be. Pair with tools:find: tools:find(\"<intent>\") to get the name + arg schema, then tools:invoke({ name, args }) to run it. Use this when a tool you need is not in your loaded set and your client has not surfaced it directly.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          },
          "servingGeneration": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160
          },
          "build": {
            "description": "'staging' runs the call on the staging operator (:3170), for a tool main does not have yet. Default main.",
            "type": "string",
            "enum": [
              "main",
              "staging"
            ]
          },
          "args": {
            "type": "object",
            "propertyNames": {
              "type": "string"
            },
            "additionalProperties": {}
          }
        },
        "required": [
          "name"
        ],
        "additionalProperties": false
      },
      "annotations": {
        "readOnlyHint": false
      },
      "_meta": {
        "papercusp/toolRegistryRevision": "projected-tool-registry-v1:cc000576a76868be",
        "papercusp/toolRegistrySource": "projected-tool-registry",
        "papercusp/provider": {
          "pluginName": "agent-mcp",
          "packageName": "@papercusp/agent-mcp",
          "version": "0.1.0",
          "kind": "builtin"
        },
        "papercusp/servingGeneration": "serving-generation-v1:6cb07e6d45f6a51ac66f798ff14ca9182d665350d442265c4f4a4a384b17fb4f"
      }
    },
    {
      "name": "capability:inspect",
      "description": "Run fixed code verification (typecheck or test), or check vm-copy-authority for an already accepted operation. The protected VM-copy check requires authenticated applied execution authority and never runs commands or acquires leases. Fixed safe commands only for code verification; never an arbitrary shell command.",
      "inputSchema": {
        "type": "object",
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "check": {
                "type": "string",
                "enum": [
                  "typecheck",
                  "test"
                ],
                "description": "typecheck = `npx tsc --noEmit` in the package; test = the package suite (`npx vitest run`), the repository `npm run test:file -- <path…>` router for exact one- or multi-file runs (including `.integration.test.*`, `.browser.test.*`, and `.e2e.test.*`), or, with no package and no paths, the repo `npm run test:affected`."
              },
              "package": {
                "description": "Repository-relative directory path to run in, e.g. \"packages/operator-core\", or the canonical npm workspace name such as \"@papercusp/operator-core\" (resolved via its node_modules workspace link). It must contain tsconfig.json for typecheck. For test, omit to run `npm run test:affected` at the repo root.",
                "type": "string"
              },
              "path": {
                "description": "test only: one test file/dir to narrow the run (e.g. \"lib/foo.test.ts\"). When `package` is supplied, the path is package-relative; when omitted, it is repo-relative. Layered `.integration.test.*`/`.browser.test.*`/`.e2e.test.*` files are routed through the repository `test:file` command automatically. For multiple exact files, use `onlyPaths` instead; do not pass both fields.",
                "type": "string"
              },
              "onlyPaths": {
                "description": "Exact paths for a focused run. For test, pass one or more package-relative paths (when `package` is supplied) or repo-relative paths (when omitted); they run through the root `npm run test:file -- <paths…>` router. For typecheck, discover the repository baseline gate that covers these package- or repo-relative paths, then scope its verdict via `--files=`. Mixed or uncovered gate scopes are refused rather than guessed.",
                "maxItems": 50,
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 300
                }
              },
              "run_in_background": {
                "description": "Run detached; returns a bash_id immediately. Poll with capability:bash_output, stop with processes:kill { taskId }.",
                "type": "boolean"
              },
              "runInBackground": {
                "description": "Compatibility alias for run_in_background; the snake_case spelling is canonical.",
                "type": "boolean"
              },
              "timeout": {
                "description": "Wall-clock timeout in ms. FOREGROUND: default 120000, clamped to 45000ms (below the ~55s MCP transport cap) so it returns a hint instead of an opaque request_timeout. BACKGROUND (run_in_background): default 14400000, max 43200000 — not bound by the transport cap, but still terminated at its own deadline.",
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 43200000
              }
            },
            "required": [
              "check"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "check": {
                "type": "string",
                "const": "vm-copy-authority"
              },
              "request": {
                "type": "object",
                "properties": {
                  "schemaVersion": {
                    "type": "number",
                    "const": 1
                  },
                  "phase": {
                    "type": "string",
                    "enum": [
                      "preflight",
                      "prepublish"
                    ]
                  },
                  "challenge": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "operationId": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9_-]{1,80}$"
                  },
                  "manifestRawBase64": {
                    "type": "string",
                    "minLength": 4,
                    "maxLength": 87384
                  },
                  "manifestSha256": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  }
                },
                "required": [
                  "schemaVersion",
                  "phase",
                  "challenge",
                  "operationId",
                  "manifestRawBase64",
                  "manifestSha256"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "check",
              "request"
            ],
            "additionalProperties": false
          }
        ]
      },
      "annotations": {
        "readOnlyHint": true
      },
      "_meta": {
        "papercusp/toolRegistryRevision": "projected-tool-registry-v1:cc000576a76868be",
        "papercusp/toolRegistrySource": "projected-tool-registry",
        "papercusp/provider": {
          "pluginName": "agent-mcp",
          "packageName": "@papercusp/agent-mcp",
          "version": "0.1.0",
          "kind": "builtin"
        },
        "papercusp/servingGeneration": "serving-generation-v1:6cb07e6d45f6a51ac66f798ff14ca9182d665350d442265c4f4a4a384b17fb4f"
      }
    },
    {
      "name": "capability:bash",
      "description": "Run `bash -c` in the project dir; stream and spill large output to a log. Operator callers may bind redacted integration credentials.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "command": {
            "description": "The bash command to run (passed to `bash -c`). Required, unless `cmd` is given. For inline Python `-c`, do not encode source line breaks as literal `\\n` inside a shell-quoted program: the shell preserves the backslash and Python raises a line-continuation SyntaxError. Use a quoted heredoc (`python3 - <<'PY' ... PY`) or a semicolon-delimited one-liner.",
            "type": "string",
            "minLength": 1
          },
          "cmd": {
            "description": "Alias for `command`. Accepted because the Codex CLI's own native `shell` tool call uses \"cmd\" as its argument key (EI-22073622160284651: a Codex-backed agent reaching for this tool by habit typed `cmd` and was rejected), so an agent used to that convention can reach for it here too. Prefer `command`.",
            "type": "string",
            "minLength": 1
          },
          "description": {
            "description": "5–10 word description of what the command does (for telemetry / the agent log).",
            "type": "string"
          },
          "timeout": {
            "description": "Wall-clock timeout in ms (minimum 1000; values below one second are rejected to catch seconds-vs-milliseconds mistakes — 20 seconds = 20000ms). This is the EXECUTION deadline, not the response window. Ordinary calls default to 120000; if still running at the response window they return the SAME durable job without killing it. Explicit run_in_background calls default to 14400000. Maximum 43200000. The whole confined task subtree IS terminated only at this execution deadline (systemd RuntimeMaxSec plus the local SIGTERM/SIGKILL path), so budget it for all command wall-clock work, including sleeps, SSH/remote round-trips, retries, and other waits; raise it when that planned work can run longer. The deadline is FIXED AT LAUNCH and cannot be extended on a running task (systemd 255 refuses a runtime RuntimeMaxSec change): size it for retries, or chain longer work as separate tasks. Deliberately daemonized descendants remain tracked inside the same task and share its deadline; use a dedicated service launcher for a different lifetime. Work submitted to an external server can outlive the shell: killing psql does not prove its PostgreSQL query stopped. Use dev:pg_query for bounded diagnostic reads, or set and verify a server-side statement_timeout for native SQL.",
            "type": "integer",
            "minimum": 1000,
            "maximum": 43200000
          },
          "yield_after_ms": {
            "description": "Ordinary-call RESPONSE window in ms (default 45000, max 45000). If the command is still running when this window ends, the call returns its original durable bash_id/task_id and the job continues until completion, explicit kill/abort, or the separate timeout execution deadline. This never restarts or duplicates the command. Ignored with run_in_background:true, which yields immediately.",
            "type": "integer",
            "minimum": 10,
            "maximum": 45000
          },
          "run_in_background": {
            "description": "Return the durable job immediately instead of waiting for fast completion. Ordinary calls already yield the same job automatically at yield_after_ms. Read later output via capability:bash_output.",
            "type": "boolean"
          },
          "require_task_confinement": {
            "description": "Require managed task enrollment and cgroup confinement before fork. Refuse without starting the command if unavailable; timeout still bounds the whole task.",
            "type": "boolean"
          },
          "allow_duplicate": {
            "description": "Allow a duplicate launch when a live task already has the exact same command and cwd. Use only when the duplicate is intentional.",
            "type": "boolean"
          },
          "cwd": {
            "description": "Working dir (absolute, or relative to the project dir). Defaults to the project dir.",
            "type": "string"
          },
          "work_item_id": {
            "description": "Held work-item this job is for. Required when you hold multiple work-items or held-item attribution cannot be measured; pass the exact full id returned by scheduler:get_next or work_items:get. Shortened or inferred ids are refused with the current held ids. Otherwise optional. Overrides your declared goal for task-ledger attribution and the slow-attempt loop gate.",
            "type": "string"
          },
          "parent_task_id": {
            "description": "Durable task that owns this nested launch. Pass PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID from a managed caller. Must be live and owned by the same caller, workspace, harness and work-item; subtree cancellation then includes this child.",
            "type": "string",
            "pattern": "^[0-9a-z]{4,64}$"
          },
          "integration_env": {
            "description": "Operator-authority only. Map child environment variable names to encrypted setup:save_integration_key names, e.g. {\"DEEPGRAM_API_KEY\":\"SIDESTAGE_DEEPGRAM_API_KEY\"}. Raw values stay server-side, exist only in this child process, and are exact-value-redacted from events, results, background reads, and spill logs.",
            "type": "object",
            "propertyNames": {
              "type": "string",
              "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"
            },
            "additionalProperties": {
              "type": "string",
              "pattern": "^[A-Z][A-Z0-9_]*$"
            }
          }
        },
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "ok": {
            "type": "boolean"
          },
          "reason": {
            "type": "string"
          },
          "unconfined_reason": {
            "type": "string"
          },
          "command_started": {
            "type": "boolean"
          },
          "bash_id": {
            "type": "string"
          },
          "task_id": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "running",
              "completed",
              "failed",
              "killed",
              "timed_out"
            ]
          },
          "running": {
            "type": "boolean"
          },
          "yielded": {
            "type": "boolean"
          },
          "cleanup_pending": {
            "type": "boolean"
          },
          "exit_code": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          },
          "duration_ms": {
            "type": "number",
            "minimum": 0
          },
          "cwd": {
            "type": "string"
          },
          "output": {
            "type": "string"
          },
          "truncated": {
            "description": "When true, output is a bounded head/tail preview, not complete data; do not parse it. Narrow the command or read log_path.",
            "type": "boolean"
          },
          "total_bytes": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "log_path": {
            "description": "Path containing the complete command output when output is truncated.",
            "type": "string"
          },
          "response_window_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "timeout_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "deadline": {
            "type": "string"
          },
          "advice": {
            "type": "string"
          },
          "process_table_notice": {
            "type": "string"
          },
          "integration_env": {
            "type": "object",
            "propertyNames": {
              "type": "string"
            },
            "additionalProperties": {
              "type": "object",
              "properties": {
                "source": {
                  "type": "string"
                },
                "masked": {
                  "type": "string"
                }
              },
              "required": [
                "source",
                "masked"
              ],
              "additionalProperties": {}
            }
          }
        },
        "required": [
          "ok"
        ],
        "additionalProperties": {}
      },
      "annotations": {
        "readOnlyHint": false
      },
      "_meta": {
        "papercusp/toolRegistryRevision": "projected-tool-registry-v1:cc000576a76868be",
        "papercusp/toolRegistrySource": "projected-tool-registry",
        "papercusp/provider": {
          "pluginName": "agent-mcp",
          "packageName": "@papercusp/agent-mcp",
          "version": "0.1.0",
          "kind": "builtin"
        },
        "papercusp/resultFormats": [
          "json"
        ],
        "papercusp/servingGeneration": "serving-generation-v1:6cb07e6d45f6a51ac66f798ff14ca9182d665350d442265c4f4a4a384b17fb4f"
      }
    }
  ],
  "completeCatalog": {
    "sourcePath": "/tmp/p2p-p536-48ad-20261024-U1aLGd/evidence/loaded-tool-descriptors.json",
    "sha256": "2c324f6107e2434d6aa3292a5535f7535ede6577508d1fb1aa52d65442801ca0",
    "names": [
      "harness:list",
      "harness:get",
      "harness:status",
      "tasks:list",
      "tasks:get",
      "features:get",
      "features:history",
      "features:search",
      "features:list_related",
      "features:tag_vocabulary",
      "goals:list",
      "goals:get",
      "goals:create",
      "goals:propose",
      "goals:update",
      "blender:attach-goal-evidence",
      "goals:attach-pot",
      "goals:detach-pot",
      "goals:pots",
      "audit:list",
      "intel:spawn_tree",
      "intel:artifacts",
      "papercusp:list_workspaces",
      "pending_events:list",
      "search:query",
      "artifacts:load",
      "artifacts:save",
      "artifacts:append",
      "artifacts:delete",
      "testing:run",
      "testing:runs",
      "watch:create",
      "fleet:assignments",
      "scheduler:get_next",
      "plans:transfer-owner",
      "orchestrate:inspect",
      "reports:publish",
      "reports:get",
      "graph:query",
      "docs:author",
      "docs:get",
      "goals:start",
      "lsp:query",
      "lsp:apply",
      "code:structural",
      "locks:queue",
      "code:pack",
      "code:run",
      "orchestrate:search",
      "orchestrate:run",
      "code:tools",
      "recipes:list",
      "recipes:get",
      "recipes:revise",
      "recipes:search",
      "recipes:run",
      "recipes:candidates",
      "recipes:merge",
      "recipes:sweep",
      "meta:define-datatype",
      "datatypes:list",
      "datatypes:get",
      "people:search",
      "people:get",
      "people:merge",
      "datatypes:install",
      "datatypes:summary",
      "classes:define",
      "classes:list",
      "classes:get",
      "classes:validate",
      "tools:scaffold",
      "meta:define-tool",
      "tools:find",
      "tools:invoke",
      "operator:stats",
      "operator:converse",
      "papercup:converse",
      "architect:chat",
      "brainstorm:chat",
      "oracle:chat",
      "agent_chats:chat",
      "operator:audit",
      "operator:nudge",
      "operator:standing_approvals_list",
      "operator:standing_approvals_decide",
      "operator:standing_approval_mark_shown",
      "operator:voice_utterance_log",
      "operator:voice_debug",
      "operator:voice_prefs",
      "operator:conv_voice",
      "operator:voice_spend_summary",
      "voice:channels",
      "voice:join",
      "voice:leave",
      "voice:status",
      "voice:agent",
      "voice:transcript",
      "ui:dispatch",
      "voice:say",
      "voice:delegate_deep",
      "conversation:recent",
      "conversation:append",
      "consult:get_feedback",
      "consult:reply",
      "consult:decline",
      "consult:close",
      "consult:routing-health",
      "roles:list",
      "roles:get",
      "roles:firing_on",
      "roles:known",
      "hooks:known",
      "agent_tools:list",
      "ui:list_clients",
      "ui:get_state",
      "tui:dispatch",
      "coord:inbox",
      "coord:glance",
      "activity:report",
      "activity:bash-substitution-report",
      "activity:recent",
      "activity:mix",
      "activity:tool-log",
      "journal:record-turn",
      "journal:recent",
      "journal:push-utilization",
      "journal:peer-brief",
      "curation:feed",
      "curation:change-feed",
      "curation:state-of-pot",
      "discovery:pots",
      "discovery:set_pot",
      "pot:declare-wake",
      "pot:wake",
      "pot:status",
      "pot:mug_efficiency",
      "pot:start",
      "pot:pause",
      "pot:set-steering",
      "pot:get-steering",
      "pot:list",
      "pot:get",
      "pot:create",
      "pot:add-member",
      "pot:create_from_repo",
      "platform:enable",
      "platform:contribute",
      "platform:fork_gc",
      "platform:dogfood_verify",
      "pot:dissolve",
      "pot:obliterate",
      "pot:leave",
      "pot:update",
      "pot:cross_grant",
      "pot:beacon_consent",
      "pot:ask",
      "pot:request_work",
      "pot:asks",
      "pot:membership_pending",
      "pot:membership_decide",
      "pot:report",
      "pot:moderation_queue",
      "pot:moderation_resolve",
      "pot:takedown",
      "pot:ban_member",
      "network:board",
      "chat:ask_choice",
      "search:fulltext",
      "search:semantic",
      "personal:search",
      "personal:ask",
      "personal:purge",
      "personal:privacy-rules",
      "personal:declassify",
      "personal:open-sealed",
      "documents:search",
      "documents:read",
      "documents:subscriptions",
      "mail:draft",
      "mail:reply",
      "mail:send",
      "mail:send-draft",
      "calendar:propose",
      "calendar:update",
      "calendar:delete",
      "chat:reply",
      "ticket:file",
      "social:delete",
      "social:post",
      "blog:post",
      "notify:send",
      "social:read",
      "social:reply",
      "social:search",
      "chat:post",
      "memory:remember",
      "memory:search",
      "memory:list",
      "memory:get",
      "facts:assert",
      "facts:retract",
      "claims:retract",
      "facts:list",
      "conventions:governing",
      "probe:emit",
      "probe:get",
      "gates:canary-check",
      "gates:degenerate-check",
      "goals:start-from-package",
      "goals:set-schedule",
      "goals:arm-schedule",
      "goals:set-input-schema",
      "goals:set-output-schema",
      "goals:set-property",
      "goals:apply-package-update",
      "knowledge_packs:list",
      "knowledge_packs:install",
      "knowledge_packs:uninstall",
      "knowledge_packs:set_enabled",
      "knowledge_packs:upgrade",
      "knowledge_packs:sweep",
      "knowledge_packs:export",
      "knowledge_packs:publish",
      "knowledge_packs:candidates",
      "knowledge_packs:decide_candidate",
      "memory:forget",
      "memory:update",
      "memory:sweep",
      "memory:recover-from-transcripts",
      "autoloop:status",
      "autoloop:control",
      "loop:arm",
      "loop:checkpoint",
      "loop:end",
      "loop:session-audit",
      "loop:soak-report",
      "routines:set",
      "loop:standdown-all",
      "loop:status",
      "loop:transfer",
      "logs:read",
      "orders:record",
      "orders:capture",
      "orders:clear",
      "orders:summarize",
      "orders:disposition",
      "orders:reopen",
      "orders:list",
      "orders:get",
      "operator:dedup_check",
      "wiki:backlinks",
      "harness:phase_path",
      "harness:markdown_index",
      "harness:escalation",
      "harness:overview",
      "harness:pending_reviews",
      "harness:health",
      "harness:list_features",
      "harness:membership",
      "deploy:harness",
      "deploy:teardown",
      "harness:migrate-config-json",
      "deploy:status",
      "deploy:pot",
      "deploy:teardown_pot",
      "deploys:vintage",
      "accounts:register",
      "accounts:list",
      "accounts:remove",
      "accounts:status",
      "accounts:reset-rate",
      "accounts:scale_out",
      "accounts:link-start",
      "accounts:link-complete",
      "accounts:link-status",
      "accounts:set-session-override",
      "accounts:get-session-override",
      "accounts:test-egress",
      "egress:provision",
      "egress:list",
      "egress:release",
      "egress:health",
      "accounts:probe-capacity",
      "gateway:status",
      "accounts:pin",
      "accounts:unpin",
      "gateway:reload",
      "gateway:owner_report",
      "gateway:egress_mode",
      "gateway:local_backend_register",
      "gateway:local_backend_list",
      "gateway:local_backend_remove",
      "provisioner:detect_hardware",
      "provisioner:recommend",
      "provisioner:plan_install",
      "provisioner:install",
      "cert:run",
      "cert:catalog",
      "behaviour:run",
      "behaviour:catalog",
      "cross_harness:docs_outline",
      "cross_harness:docs_get",
      "cross_harness:docs_search",
      "cross_harness:plans_list",
      "cross_harness:plans_get",
      "cross_harness:plans_search",
      "actions:recent",
      "notifications:recent",
      "notifications:send_owner",
      "harness:create",
      "instance:capture",
      "instance:boot",
      "instance:clone",
      "operator:preview_prompt",
      "operator:decisions",
      "agents:list",
      "operator:budget",
      "operator:paused",
      "operator:trigger_state",
      "operator:preferences",
      "operator:rate_limit_config",
      "omp:config",
      "omp:sessions",
      "operator:multi_workspace",
      "operator:credentials_status",
      "projects:list",
      "projects:get",
      "projects:spec_revisions",
      "projects:spec_revision",
      "operator:notes",
      "cross_harness:supervisor_notes",
      "cross_harness:recent_activity",
      "plugins:runtime_status",
      "plugins:invoke_action",
      "plugins:fire_event",
      "plugins:tui_panes",
      "tasks:create",
      "tasks:ops",
      "tasks:todo_write",
      "tasks:update_plan",
      "agent_chats:list",
      "agent_chats:get",
      "agent_chats:create",
      "agent_chats:send_message",
      "agent_chats:archive",
      "dev:harnesses",
      "dev:telemetry",
      "dev:code_run_adoption",
      "dev:limit_failure_rate",
      "dev:orient_dedup_rate",
      "dev:audit",
      "dev:sessions",
      "dev:activity",
      "dev:pg_health",
      "dev:pg_active_queries",
      "dev:pg_hot_queries",
      "dev:pg_table_sizes",
      "dev:pg_mutate",
      "dev:pg_query",
      "dev:cache_stats",
      "dev:embed_latency",
      "dev:build_status",
      "dev:pipeline_position",
      "dev:gate_ownership",
      "release:trace",
      "dev:why",
      "dev:coord_categorize",
      "dev:advisory_bet_signal",
      "dev:dogfood_substrate_status",
      "dev:own_log_fork_recover",
      "dev:ipc_echo",
      "dev:state_counter",
      "dev:event_emitter",
      "dev:processes",
      "dev:listening_ports",
      "dev:session_detail",
      "dev:resolve_owner",
      "dev:tool_cooccurrence",
      "processes:kill",
      "processes:list",
      "processes:freeze",
      "processes:limit",
      "turn:interrupt",
      "dev:omp_session",
      "dev:claude_session",
      "flags:list",
      "flags:get",
      "flags:set",
      "flags:attest",
      "autonomy:policy_get",
      "autonomy:policy_set",
      "autonomy:decide",
      "autonomy:record_disposition",
      "autonomy:tripwire_list",
      "autonomy:tripwire_revert",
      "autonomy:graduation_status",
      "trust:list",
      "trust:add",
      "trust:remove",
      "trust:comms",
      "saved_prompts:list",
      "backup:snapshot_create",
      "backup:snapshot_list",
      "backup:restore",
      "backup:restore_clone_cleanup",
      "backup:diff",
      "backup:promote",
      "backup:rollback",
      "backup:settings_get",
      "backup:settings_set",
      "setup:status",
      "setup:set_git_identity",
      "setup:set_telemetry",
      "setup:set_update_channel",
      "setup:save_key",
      "setup:save_integration_key",
      "setup:complete",
      "setup:set_tutorial_progress",
      "docs:outline",
      "docs:search",
      "harness_docs:record",
      "harness_docs:list",
      "harness_docs:anchor",
      "harness_docs:verify",
      "harness_docs:set_overlay",
      "harness_docs:regenerate",
      "harness_docs:ingest",
      "harness_docs:retire",
      "locks:acquire",
      "locks:release",
      "locks:heartbeat",
      "locks:cancel_wait",
      "locks:acquire_resource",
      "locks:register_resource",
      "locks:release_resource",
      "locks:heartbeat_resource",
      "locks:acquire_granular",
      "locks:release_granular",
      "locks:list",
      "locks:check_command",
      "capability:inspect",
      "capability:bash",
      "capability:bash_output",
      "capability:bash_kill",
      "capability:pty_open",
      "capability:pty_write_stdin",
      "capability:pty_resize",
      "capability:pty_read_screen",
      "capability:pty_kill",
      "capability:terminal",
      "mode:set",
      "capability:launch-agent",
      "capability:read",
      "capability:list",
      "capability:write",
      "capability:edit",
      "capability:patch",
      "capability:notebook_edit",
      "capability:git",
      "capability:fetch",
      "capability:computer",
      "computer:provision_desktop",
      "computer:release_desktop",
      "computer:list_desktops",
      "computer:observe",
      "computer:click_element",
      "computer:record",
      "dev:restart",
      "dev:service_health",
      "supervision:annotate-pause",
      "supervision:announce-quiesce",
      "dev:rate_governor_status",
      "dev:stall_waker_status",
      "db:migrate",
      "db:check_drift",
      "db:migrations",
      "issues:list",
      "db:next-migration",
      "testing:prune-orphan-runs",
      "testing:flakiness",
      "testing:case-categories",
      "testing:record-run",
      "testing:run-status",
      "testing:verdict_diff",
      "testing:coverage",
      "build:typecheck",
      "fleet:create",
      "fleet:list",
      "fleet:status",
      "fleet:join",
      "fleet:leave",
      "fleet:take-leadership",
      "fleet:wind-down",
      "fleet:resume",
      "fleet:pause",
      "fleet:supersede",
      "fleet:launch-on-plan",
      "fleet:headcount-target",
      "fleet:request_remote_spawn",
      "fleet:recolor",
      "fleet:reconfigure-member",
      "fleet:kill",
      "fleet:respawn-member",
      "coord:whoami",
      "coord:rebind-identity",
      "coord:presence",
      "coord:roster",
      "coord:declare-intent",
      "coord:goal",
      "coord:wake-mode",
      "coord:wake-queue",
      "coord:walls",
      "events:status",
      "coord:orient",
      "mode:list",
      "mode:get",
      "slash:dispatch",
      "coord:send",
      "coord:supersede",
      "coord:dispatch",
      "coord:wake",
      "coord:message-agent",
      "coord:await-inbox",
      "inbox:triage",
      "inbox:bulk-run-manifest",
      "inbox:bulk-run-act",
      "inbox:bulk-run-report",
      "inbox:bulk-run-settle",
      "inbox:automation-policy",
      "coord:emit",
      "coord:conditions",
      "coord:ack",
      "coord:focus-window",
      "coord:mark-terminal",
      "coord:couple",
      "coord:decouple",
      "coord:thread",
      "coord:read",
      "coord:escalate",
      "coord:escalations",
      "coord:resolve",
      "coord:handoff",
      "coord:handoffs",
      "coord:feed",
      "coord:catch-up",
      "coord:retract",
      "fleet:delivery",
      "new_subagent:request",
      "new_subagent:approve",
      "topics:list",
      "topics:create",
      "topics:unsubscribe",
      "topics:merge",
      "topics:tag",
      "topics:feed",
      "conversations:post",
      "conversations:answer",
      "conversations:resolve",
      "conversations:join",
      "conversations:list",
      "conversations:get",
      "conversations:promote",
      "conversations:supersede",
      "conversations:withdraw",
      "improvements:capture",
      "improvements:agent-review",
      "improvements:digest",
      "improvements:filing-classes",
      "improvements:triage",
      "improvements:resolve",
      "improvements:watchdog-status",
      "improvements:keyless-digest",
      "improvements:bug-inflow",
      "improvements:learning_loops",
      "improvements:set-watchdog-tunables",
      "watchdog:status",
      "config:doors-get",
      "config:doors-set",
      "config:doors-set-session",
      "config:list-overrides",
      "config:reset-overrides",
      "config:set-compaction-limit",
      "config:role-launch",
      "config:tiers-get",
      "config:tiers-set",
      "config:terminal-emulator",
      "session:request-compaction",
      "session:carry-drill",
      "session:end",
      "sessions:search",
      "sessions:read",
      "sessions:list",
      "sessions:timeline",
      "sessions:digest",
      "sessions:ingest-gate-event",
      "sessions:record-prompt-origin",
      "sessions:list-pending-gates",
      "sessions:rename",
      "db:migrate-policy",
      "routines:list",
      "routines:fire",
      "dream:control",
      "routines:group-set",
      "routines:revert",
      "git-sync:run",
      "git-sync:send-green",
      "pot_git:integration_requests",
      "pot_git:secrets_exemptions",
      "schedule:inventory",
      "telemetry:set_buffer",
      "db:txn-timeouts",
      "capability:grant_role",
      "capability:revoke_role",
      "capability_envelope:set_role",
      "prompt:role_override",
      "fleet:opus_budget",
      "accounts:scale_policy",
      "improvements:set-auto-policy",
      "gym:set-gates",
      "work_items:reclaim_config",
      "coord:handoff_config",
      "coord:orientation_telemetry",
      "coord:session_reaper_config",
      "pot:control_policy",
      "workspace:work_scope",
      "workspace:work_scope_status",
      "governance:policy",
      "release:checkpoint-config",
      "release:repair-queue",
      "release:test-downgrade",
      "learning:set-scout-budget",
      "gym:arm",
      "governor:arm",
      "governor:admission_cutover",
      "learning:set-pot-scope",
      "quota:set_tool",
      "auth:set_full_access_roles",
      "clamp:set_safe_tools",
      "exec_sandbox:set_policy",
      "capability_tier:set",
      "release:deploy",
      "release:checkpoint-run",
      "release:checkpoint-cancel",
      "release:cut",
      "rubrics:list",
      "rubrics:get",
      "rubrics:search",
      "rubrics:propose",
      "rubrics:repair",
      "rubrics:amend",
      "rubrics:amend-status",
      "rubrics:check-approver",
      "rubrics:ratify",
      "rubrics:retire",
      "rubrics:set-history-reset",
      "rubrics:trend",
      "scorecards:list",
      "scorecards:get",
      "scorecards:freshness",
      "scorecards:evaluate",
      "scorecards:repair",
      "plans:evaluate-spec-test-adequacy",
      "scorecards:emit",
      "scorecards:retract",
      "pilot:assign",
      "pilot:collect",
      "health:ack",
      "health:unack",
      "work_items:link",
      "work_items:create",
      "work_items:get",
      "work_items:list",
      "work_items:export",
      "work_items:claimable",
      "work_items:stranded",
      "work_items:burn_down",
      "work_items:search",
      "work_items:set_state",
      "work_items:withdraw",
      "work_items:set_live_verified",
      "work_items:complete",
      "work_items:claim",
      "work_items:pickup",
      "work_items:release",
      "work_items:request_release",
      "work_items:decline_release_request",
      "work_items:withdraw_release_request",
      "work_items:park",
      "work_items:hold_open",
      "work_items:reorder",
      "work_items:links",
      "work_items:set_blocker",
      "work_items:tag",
      "work_items:subscribe",
      "work_items:comment",
      "work_items:update",
      "work_items:checkpoint",
      "work_items:amend",
      "work_items:expand",
      "work_items:promote",
      "work_items:admit",
      "work_items:bulk_dedup",
      "work_items:claim_next",
      "work_items:rehome",
      "work_items:observe",
      "scheduler:set_claim_spec",
      "scheduler:get_claim_spec",
      "scheduler:pull_ledger",
      "scheduler:preview_spec_delta",
      "p2p:trace",
      "hive:store_breakdown",
      "resource:delegate",
      "resource:offers",
      "scheduler:running",
      "work_items:co_locate",
      "work_items:set_priority",
      "work_items:set_redundancy",
      "work_items:claim_replica",
      "work_items:record_replica_result",
      "work_items:judge_redundancy",
      "work_items:redundancy_status",
      "work_items:completion_stats",
      "work_items:acceptance_adoption",
      "fleet:cancel",
      "fleet:tree",
      "fleet:supervise",
      "fleet:admit",
      "fleet:governor",
      "fleet:capacity",
      "fleet:leader-brief",
      "fleet:audit",
      "fleet:bench",
      "fleet:invariant",
      "fleet:require-checkpoint",
      "fleet:place_batch",
      "fleet:drain",
      "fleet:cup_mail",
      "fleet:selected_cup",
      "fleet:sandbox_deps",
      "coord:vote",
      "coord:deliberate",
      "coord:ask-owner",
      "coord:thread-post",
      "coord:watermark",
      "coord:plan-events",
      "plans:set-now",
      "plans:set-plan-status",
      "plans:set-status",
      "plans:promote",
      "plans:list",
      "plans:get",
      "plans:get-properties",
      "plans:set-property",
      "plans:acceptance-disposition",
      "plans:blind-review",
      "plans:get-specs",
      "plans:spec-reconciliation",
      "plans:set-specs",
      "plans:bind-spec-evidence",
      "plans:bind-independent-verification",
      "plans:get-spec-evidence",
      "plans:evidence-measuring-paths",
      "plans:certify-spec-clauses",
      "plans:evaluate-spec-quality",
      "plans:items",
      "plans:get-item",
      "plans:get-template-data",
      "plans:set-template-data",
      "plans:get-input-schema",
      "plans:governance-event",
      "plans:set-input-schema",
      "plans:get-output-schema",
      "plans:set-output-schema",
      "plans:publish-outputs",
      "plans:attention",
      "plans:search",
      "plans:lint",
      "plans:export",
      "plans:new",
      "plans:cleanup-manifest",
      "plans:cleanup-act",
      "plans:cleanup-report",
      "plans:cleanup-settle",
      "plans:set-importance",
      "plans:add-decision",
      "plans:set-decision-body",
      "plans:ratify-decision",
      "plans:add-item",
      "plans:audit",
      "plans:audit-unshipped",
      "plans:set-content",
      "plans:set-content-chunk",
      "plans:edit",
      "plans:set-frontmatter",
      "plans:set-initiative",
      "plans:set-frontmatter-field",
      "plans:set-title",
      "plans:set-item-blocked-by",
      "plans:set-item-phase",
      "plans:conformance",
      "plans:set-schedule",
      "plans:run-now",
      "plans:arm-schedule",
      "plans:disarm-schedule",
      "plans:revisions",
      "plans:backfill-revisions",
      "plans:migrate-acceptance-bars",
      "plans:acceptance-bar-census",
      "plans:verification-health",
      "plans:backfill-dependency-edges",
      "plans:revision-transcript",
      "plans:summarize-revision",
      "plans:revision-diff",
      "plans:run-transcript",
      "plans:start",
      "plans:pause",
      "plans:set-priority",
      "plans:set-verification-profile",
      "plan-types:define",
      "plan-types:get",
      "plan-types:list",
      "plan-types:retire",
      "plan-types:pin",
      "plans:set-archived",
      "plans:launch",
      "plans:resume",
      "plans:runs",
      "plans:set-run-status",
      "plans:apply-plan-block",
      "plan_items:adopt_name",
      "plan_items:assign",
      "plan_items:unassign",
      "plan_items:my_items",
      "plan_items:claim",
      "plan_items:convert",
      "plan_items:release",
      "plan_items:heartbeat",
      "plan_items:status",
      "plan_items:join_group",
      "plan_items:leave_group",
      "substrate:revoke_self_device",
      "substrate:revoke_contributor",
      "blueprint:validate",
      "blueprint:create",
      "blueprint:extend",
      "identities:create",
      "identities:list",
      "identities:get",
      "identities:validate",
      "identities:preview",
      "blueprint:publish",
      "blueprint:submit",
      "blueprint:read-private-input",
      "blueprint:status",
      "blueprint:result",
      "blueprint:events",
      "blueprint:cancel",
      "blueprint:signal",
      "blueprint:resume",
      "cupboard:publish-app",
      "cupboard:publish-plugin",
      "cupboard:publish-template",
      "cupboard:install-blueprint",
      "cupboard:install-plugin",
      "cupboard:install-template",
      "cupboard:install-app",
      "cupboard:publish-rubric",
      "cupboard:install-rubric",
      "cupboard:publish-rule",
      "cupboard:install-rule",
      "cupboard:publish-plan",
      "cupboard:install-plan",
      "cupboard:publish-recipe",
      "cupboard:install-recipe",
      "cupboard:publish-goal",
      "cupboard:install-goal",
      "cupboard:publish-theme",
      "cupboard:install-theme",
      "cupboard:publish-datatype",
      "cupboard:install-datatype",
      "cupboard:publish-event",
      "cupboard:install-event",
      "cupboard:search",
      "cupboard:my-listings",
      "cupboard:unpublish",
      "cupboard:checkout",
      "cupboard:publish-offer",
      "cupboard:refund-request",
      "cupboard:support-request",
      "cupboard:commerce-dashboards",
      "cupboard:ledger-chain",
      "cupboard:ledger-chain-witness",
      "cupboard:ledger-anchor",
      "cupboard:ledger-anchor-run",
      "cupboard:payment-receipt",
      "cupboard:statement-attestation",
      "cupboard:reconciliation",
      "cupboard:bind-wallet",
      "pot:equity",
      "cupboard:bind-identity-funding",
      "cupboard:meter-invocation",
      "blueprint:catalog",
      "templates:list",
      "templates:get-guide",
      "templates:new-app",
      "harness:generate-from-repo",
      "harness:configure",
      "gym:judge",
      "gym:signals",
      "review:approve",
      "merge:approve",
      "experiment:catalog",
      "experiment:run",
      "experiment:results",
      "blender:grade-idea",
      "blender:ideation-feedback",
      "blender:route-idea",
      "blender:ideate-pass-record",
      "blender:success-metrics",
      "blender:run-drill",
      "blender:goal-drafts",
      "change_ledger:list",
      "change_ledger:calendar",
      "decision_ledger:list",
      "decision_ledger:summary",
      "ablation:report",
      "calibration:summary",
      "events:graph",
      "events:await",
      "events:emit",
      "rules:validate",
      "rules:create",
      "rules:list",
      "rules:get",
      "rules:enable",
      "rules:disable",
      "rules:delete",
      "rules:test",
      "events:cancel",
      "triggers:list",
      "triggers:create",
      "triggers:create-webhook",
      "triggers:rotate-webhook-secret",
      "triggers:bind",
      "triggers:arm",
      "triggers:disarm",
      "trigger-packs:review",
      "trigger-packs:arm",
      "trigger-packs:uninstall",
      "trigger-packs:export",
      "triggers:run-with-last-event",
      "triggers:status",
      "triggers:read-payload",
      "events:unsubscribe",
      "state:read",
      "state:subscribe",
      "host:memory_pressure",
      "governor:state_snapshot",
      "lsp:admission_snapshot",
      "events:catalog",
      "deploy:await",
      "checkpoint:await",
      "work-item:await",
      "service:await-up",
      "git-sync:await",
      "plan-item:await",
      "fleet:await-drained",
      "events:lost-wake-check",
      "rationale:feed",
      "rationale:reproject",
      "lexicon:active_pack",
      "storage:usage",
      "storage:census",
      "storage:prune",
      "storage:pin",
      "access:list",
      "access:create",
      "access:pause",
      "access:revoke",
      "reports:list",
      "reports:search",
      "reports:retire"
    ]
  },
  "importLog": "{\"phase\":\"source-verified\",\"elapsedMs\":44932,\"files\":22309,\"bytes\":4515823883}\n{\"schemaVersion\":\"p536-qualified-import-v1\",\"retention\":{\"root\":\"/tmp/pcv/papercusp-lint-as-committed-ea7f90bca4-x5XVpZ\",\"sha\":\"ea7f90bca42b357aedc80a0f01770a8bd1674f47\"},\"run\":\"/tmp/p2p-p536-48ad-20261024-U1aLGd\",\"source\":\"/tmp/48ad-p537-build9-Xt4F7n/run/artifact\",\"donor\":\"/tmp/pcv/papercusp-lint-as-committed-ea7f90bca4-x5XVpZ\",\"commit\":\"ea7f90bca42b357aedc80a0f01770a8bd1674f47\",\"desktopPin\":\"96ff0d4663b13b724dc022dd6d7a1b02dd911855\",\"sha256\":\"360e797a82df826f4c8df33ab3997f1712912186519d9a1b00c5d4b595fdcc81\",\"files\":22309,\"bytes\":4515823883,\"objects\":24668,\"sourceCensusMs\":42112,\"copiedCensusMs\":33171,\"totalMs\":81790,\"closure\":\"✓ runtime dependency closure resolved inside sidecar (359 packages checked)\",\"runtime\":\"not-started\",\"product\":\"not-run\",\"fixtureRevision\":9}\n",
  "controlLog": "{\"phase\":\"canonical-credential-install-complete\",\"elapsedMs\":91038}\n{\"phase\":\"primary-spawned\",\"pid\":1861363,\"httpPort\":43877,\"pgPort\":45937}\n{\"phase\":\"primary-discovery-qualified\",\"elapsedMs\":122221}\n{\"schemaVersion\":\"p536-primary-control-v1\",\"run\":\"/tmp/p2p-p536-48ad-20261024-U1aLGd\",\"pid\":1861363,\"health\":{\"ok\":true,\"service\":\"papercusp-operator\",\"sha\":\"ea7f90bca4\",\"version\":\"0.0.0\",\"claimSpec\":{\"specVersion\":\"1.0\",\"revisionAdoption\":[\"first\"]},\"ts\":\"2026-10-25T06:50:08.995Z\"},\"actualPort\":43877,\"pgPort\":45937,\"registry\":{\"workspace\":\"test-runtime-p2p-vmcopy-p536-48ad-20261024\",\"foreignWorkspace\":\"test-runtime-p2p-vmcopy-p536-48ad-20261024-foreign\"},\"elapsedMs\":124800,\"authenticatedMcp\":\"passed\",\"worker\":\"not-run\",\"product\":\"not-run\"}\n{\"phase\":\"primary-teardown\",\"elapsedMs\":127398,\"exitCode\":0,\"signal\":null,\"observations\":[\"start\",\"postgres captured\",\"signal\",\"exit\",\"close\",\"postgres stopped\",\"complete\"]}\n",
  "scripts": {
    "su56361-fire66-p536-combined-import.mjs": "import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport path from 'node:path';\nimport crypto from 'node:crypto';\nimport { execFileSync } from 'node:child_process';\nimport { verifyCommittedWorkRoot } from '/home/marsh-office/papercupai-workspace/papercusp/scripts/lint-as-committed.mjs';\n\nconst q = JSON.parse(fs.readFileSync('/tmp/48ad-p537-assembly9-qualification.json', 'utf8'));\nconst expected = '360e797a82df826f4c8df33ab3997f1712912186519d9a1b00c5d4b595fdcc81';\nconst source = '/tmp/48ad-p537-build9-Xt4F7n/run/artifact';\nconst donor = '/tmp/pcv/papercusp-lint-as-committed-ea7f90bca4-x5XVpZ';\nconst started = Date.now();\nconst hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');\nfunction census(root) {\n  const at = Date.now(), digest = crypto.createHash('sha256'), inventory = [];\n  let files = 0, bytes = 0;\n  function walk(dir) {\n    const before = fs.lstatSync(dir, { bigint: true });\n    assert(before.isDirectory());\n    inventory.push({ path: path.relative(root, dir), kind: 'directory', dev: String(before.dev), ino: String(before.ino), mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs) });\n    for (const name of fs.readdirSync(dir).sort()) {\n      assert(inventory.length < 50000, 'artifact object ceiling');\n      assert(Date.now() - at <= 120000, 'census time ceiling');\n      const file = path.join(dir, name), st = fs.lstatSync(file, { bigint: true });\n      if (st.isDirectory()) { walk(file); continue; }\n      assert(st.isFile(), 'artifact link or special object');\n      const fd = fs.openSync(file, 'r'), fileHash = crypto.createHash('sha256');\n      try {\n        const opened = fs.fstatSync(fd, { bigint: true });\n        assert.equal(opened.ino, st.ino); assert.equal(opened.dev, st.dev);\n        const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);\n        let count;\n        while ((count = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {\n          fileHash.update(chunk.subarray(0, count));\n          assert(Date.now() - at <= 120000, 'census time ceiling');\n        }\n        const after = fs.fstatSync(fd, { bigint: true });\n        for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], st[key], 'artifact changed during census');\n      } finally { fs.closeSync(fd); }\n      const sha256 = fileHash.digest('hex'), relative = path.relative(root, file), mode = Number(st.mode) & 0o777;\n      digest.update(JSON.stringify([relative, mode, sha256]));\n      files++; bytes += Number(st.size); assert(bytes <= 8 * 1024 ** 3, 'artifact byte ceiling');\n      inventory.push({ path: relative, kind: 'file', mode, size: Number(st.size), sha256, dev: String(st.dev), ino: String(st.ino), mtimeNs: String(st.mtimeNs), ctimeNs: String(st.ctimeNs) });\n    }\n    const after = fs.lstatSync(dir, { bigint: true });\n    for (const key of ['dev', 'ino', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key], 'directory changed during census');\n  }\n  walk(root);\n  return { root, files, bytes, objects: inventory.length, sha256: digest.digest('hex'), elapsedMs: Date.now() - at, inventory };\n}\nlet run;\ntry {\n  assert.equal(q.artifact, source); assert.equal(q.root, donor);\n  assert.equal(q.sourceCommit, 'ea7f90bca42b357aedc80a0f01770a8bd1674f47');\n  assert.equal(execFileSync('git', ['-C', donor, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), q.sourceCommit);\n  assert(execFileSync('git', ['-C', donor, 'ls-tree', 'HEAD', 'papercusp-desktop'], { encoding: 'utf8' }).includes('96ff0d4663b13b724dc022dd6d7a1b02dd911855'));\n  assert.equal(hash(q.assemblyReceipt), 'afc7f6d75cb181aca25fd134300c78d5e6d19c0431f749d0f7e28e67cc6b0845');\n  assert.equal(hash(path.join(source, 'serve.mjs')), '288cff11c5267447c5757d5d4ab55d81c33ac5e2ec272d361033f32a0da8d5d4');\n  assert.equal(hash(path.join(source, 'spawner-sidecar.mjs')), '2712f8de1ddf156be5fcc59d32675c0298d53a616b87fb62f2ae1d214e184da4');\n  const retained = verifyCommittedWorkRoot(donor, q.sourceCommit, ['packages/operator-core/test/private-http-workspace-preflight.ts', 'papercusp-desktop/bin/lib/host-runtime-closure.sh'], source);\n  const original = census(source);\n  assert.equal(original.sha256, expected); assert.equal(original.files, 22309); assert.equal(original.bytes, 4515823883);\n  console.log(JSON.stringify({ phase: 'source-verified', elapsedMs: Date.now() - started, files: original.files, bytes: original.bytes }));\n  run = fs.mkdtempSync('/tmp/p2p-p536-48ad-20261024-'); fs.chmodSync(run, 0o700);\n  for (const name of ['evidence', 'state', 'artifact']) fs.mkdirSync(path.join(run, name), { mode: 0o700 });\n  fs.writeFileSync('/tmp/su56361-fire66-p536-combined-run-path', run + '\\n');\n  execFileSync('cp', ['-a', '--reflink=auto', source + '/.', path.join(run, 'artifact')], { timeout: 90000 });\n  const copied = census(path.join(run, 'artifact'));\n  assert.equal(copied.sha256, expected); assert.equal(copied.files, original.files); assert.equal(copied.bytes, original.bytes);\n  for (const [name, value] of [['source-census', original], ['copied-census', copied]]) fs.writeFileSync(path.join(run, 'evidence', name + '.json'), JSON.stringify(value));\n  const closure = execFileSync('bash', ['-c', 'source \"$1\"; assert_runtime_dependency_closure \"$2\"', 'p536-closure', path.join(donor, 'papercusp-desktop/bin/lib/host-runtime-closure.sh'), path.join(run, 'artifact')], { encoding: 'utf8', timeout: 30000 });\n  assert(Date.now() - started <= 180000, 'artifact import setup ceiling');\n  const receipt = { schemaVersion: 'p536-qualified-import-v1', retention: retained, run, source, donor, commit: q.sourceCommit, desktopPin: q.desktopPin, sha256: copied.sha256, files: copied.files, bytes: copied.bytes, objects: copied.objects, sourceCensusMs: original.elapsedMs, copiedCensusMs: copied.elapsedMs, totalMs: Date.now() - started, closure: closure.trim(), runtime: 'not-started', product: 'not-run', fixtureRevision: 9 };\n  fs.writeFileSync(path.join(run, 'evidence', 'import.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));\n} catch (error) {\n  const failed = { run: run ?? null, phase: 'artifact-import', error: String(error), elapsedMs: Date.now() - started };\n  fs.writeFileSync('/tmp/su56361-fire66-p536-combined-import-failed.json', JSON.stringify(failed)); console.error(JSON.stringify(failed)); process.exitCode = 1;\n}\n",
    "su56361-fire66-p536-combined-control.sh": "node --import tsx --input-type=module <<'NODE'\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport path from 'node:path';\nimport net from 'node:net';\nimport {once} from 'node:events';\nimport {spawn,execFileSync} from 'node:child_process';\nimport {Client} from '@modelcontextprotocol/sdk/client/index.js';\nimport {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';\nimport {privateBundleRuntimeEnv,stopPrivateOperatorHost,waitForPrivateOperator} from './packages/operator-core/test/private-http-workspace-preflight.ts';\nconst run=fs.readFileSync('/tmp/su56361-fire66-p536-combined-run-path','utf8').trim(),state=path.join(run,'state'),evidence=path.join(run,'evidence'),artifact=path.join(run,'artifact');\nconst receipt=JSON.parse(fs.readFileSync(path.join(evidence,'import.json'),'utf8'));assert.equal(receipt.sha256,'360e797a82df826f4c8df33ab3997f1712912186519d9a1b00c5d4b595fdcc81');assert.equal(receipt.runtime,'not-started');assert(receipt.totalMs<=180000,'artifact import setup ceiling');\nfor(const dir of ['home','tmp','workspaces','config','cache','runtime','data','vms'])fs.mkdirSync(path.join(state,dir),{recursive:true,mode:0o700});\nasync function freePort(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise((r,j)=>s.close(e=>e?j(e):r()));return p;}\nconst httpPort=await freePort();let pgPort;do{pgPort=await freePort();}while(pgPort===httpPort);\nconst env=privateBundleRuntimeEnv({PATH:process.env.PATH,LANG:'C.UTF-8',TZ:'UTC',USER:process.env.USER,\n HOME:path.join(state,'home'),TMPDIR:path.join(state,'tmp'),XDG_CONFIG_HOME:path.join(state,'config'),XDG_CACHE_HOME:path.join(state,'cache'),XDG_RUNTIME_DIR:path.join(state,'runtime'),XDG_DATA_HOME:path.join(state,'data'),\n DBUS_SESSION_BUS_ADDRESS:'unix:path='+path.join(state,'private-unavailable-bus'),PAPERCUSP_HOME:path.join(state,'home','.papercusp'),PAPERCUSP_IDENTITY_DIR:path.join(state,'home','.papercusp','identity'),\n PAPERCUSP_WORKSPACES_ROOT:path.join(state,'workspaces'),PAPERCUSP_WORKSPACE_ID:'test-runtime-p2p-vmcopy-p536-48ad-20261024',\n PAPERCUSP_HONO_PORT:String(httpPort),PAPERCUSP_BIND_HOST:'127.0.0.1',PAPERCUSP_PG_PORT:String(pgPort),PAPERCUSP_PG_DATA_DIR:path.join(state,'pgdata'),PAPERCUSP_PG_SQL_DIR:path.join(artifact,'sql'),PAPERCUSP_PG_HOST_CREDENTIALS:'1',PAPERCUSP_PG_DISABLE_SEED:'1',\n PAPERCUSP_UTILITY_HOST:'1',PAPERCUSP_BACKGROUND_WORKERS:'1',PAPERCUSP_DBOS_ENABLE:'0',PAPERCUSP_IPC_ENABLE:'0',PAPERCUSP_GATEWAY_SIDECAR:'0',PAPERCUSP_SPAWNER_SIDECAR:'0',MALLOC_ARENA_MAX:'2'});\nconst started=Number(process.env.P536_SETUP_STARTED_MS);assert(Number.isFinite(started));const deadline=started+180000;const budget=cap=>{const remaining=deadline-Date.now();assert(remaining>0,'shared setup deadline exceeded');return Math.min(cap,remaining);};let child,log,failed,client;const observations=[];\ntry{\n const installSource=path.join(receipt.donor,'packages/operator-core/lib/desktop-install/papercusp-files.ts');\n const installer=\"const {installPapercuspFiles}=await import(process.argv[1]);const r=await installPapercuspFiles({home:process.env.HOME,operatorAppRoot:process.argv[2]});console.log(JSON.stringify({canonicalInstall:true,tokenMinted:r.minted.token,agentIdMinted:r.minted.agentId,tokenPath:r.tokenPath,rtkProvision:r.rtkProvision}));process.exit(0);\";\n const installed=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',installer,installSource,artifact],{cwd:process.cwd(),env,encoding:'utf8',timeout:budget(30000)});fs.writeFileSync(path.join(evidence,'canonical-install.log'),installed);console.log(JSON.stringify({phase:'canonical-credential-install-complete',elapsedMs:Date.now()-started}));\n const preflight=\"const m=await import('./packages/operator-core/test/private-http-workspace-preflight.ts');console.log(JSON.stringify(m.preparePrivateHttpWorkspaces()));process.exit(0);\";\n const registry=JSON.parse(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',preflight],{cwd:process.cwd(),env,encoding:'utf8',timeout:budget(15000)}).trim());\n fs.writeFileSync(path.join(evidence,'namespace.json'),JSON.stringify(registry));\n log=fs.openSync(path.join(evidence,'primary.log'),'a',0o600);\n child=spawn(process.execPath,[path.join(artifact,'serve.mjs')],{cwd:artifact,env,stdio:['ignore',log,log]});\n await once(child,'spawn');const identity={pid:child.pid,exe:fs.readlinkSync('/proc/'+child.pid+'/exe'),stat:fs.readFileSync('/proc/'+child.pid+'/stat','utf8'),httpPort,pgPort,run,spawnedAt:new Date().toISOString()};\n fs.writeFileSync(path.join(evidence,'primary-identity.json'),JSON.stringify(identity));console.log(JSON.stringify({phase:'primary-spawned',pid:child.pid,httpPort,pgPort}));\n const health=await waitForPrivateOperator({host:child,base:'http://127.0.0.1:'+httpPort,evidenceDir:evidence,environment:env,timeoutMs:budget(60000)});\n let discovery;\n const discoveryDeadline=Math.min(deadline,Date.now()+60000);\n while(Date.now()<discoveryDeadline){\n  assert.equal(child.exitCode,null,'PRIMARY exited before discovery');\n  assert.equal(child.signalCode,null,'PRIMARY signaled before discovery');\n  try{discovery=JSON.parse(fs.readFileSync(path.join(env.PAPERCUSP_HOME,'operator.json'),'utf8'));break;}\n  catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;await new Promise(done=>setTimeout(done,50));}\n }\n assert(discovery,'PRIMARY health did not publish discovery within the startup deadline');\n assert.equal(discovery.pid,child.pid);assert.equal(discovery.port,httpPort);assert.equal(new URL(discovery.httpUrl).port,String(httpPort));assert(discovery.token);\n console.log(JSON.stringify({phase:'primary-discovery-qualified',elapsedMs:Date.now()-started}));\n const url=new URL('http://127.0.0.1:'+httpPort+'/api/mcp');\n for(const [key,value] of Object.entries({superuser:'1',workspace:env.PAPERCUSP_WORKSPACE_ID,client:'p536-independent-private-setup',format:'json',structured:'1'}))url.searchParams.set(key,value);\n client=new Client({name:'p536-independent-private-setup',version:'1'});\n await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:'Bearer '+discovery.token}}}),{timeout:budget(15000)});\n const catalog=await client.listTools(undefined,{timeout:budget(15000)});assert(catalog.tools.length>0);fs.writeFileSync(path.join(evidence,'loaded-tool-descriptors.json'),JSON.stringify(catalog,null,2));\n const identityResult=await client.callTool({name:'tools:invoke',arguments:{name:'coord:whoami',args:{}}},undefined,{timeout:budget(15000)});\n assert(!identityResult.isError,JSON.stringify(identityResult));\n const mcpIdentity=identityResult.structuredContent??JSON.parse(identityResult.content.find(p=>p.type==='text'&&p.text.trim().startsWith('{')).text);\n assert.equal(mcpIdentity.workspaceId,env.PAPERCUSP_WORKSPACE_ID);assert(mcpIdentity.ownerId);\n const mcp={authenticated:true,workspaceId:mcpIdentity.workspaceId,ownerId:mcpIdentity.ownerId,catalogNames:catalog.tools.map(t=>t.name),port:httpPort,elapsedMs:Date.now()-started};\n budget(1);\n fs.writeFileSync(path.join(evidence,'authenticated-mcp.json'),JSON.stringify(mcp,null,2));\n assert(Date.now()-started<=180000,'shared setup deadline exceeded');const result={schemaVersion:'p536-primary-control-v1',run,pid:child.pid,health,actualPort:discovery.port,pgPort,registry,elapsedMs:Date.now()-started,authenticatedMcp:'passed',worker:'not-run',product:'not-run'};\n fs.writeFileSync(path.join(evidence,'primary-control.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));\n}catch(error){failed={phase:'primary-setup',run,error:String(error),elapsedMs:Date.now()-started};fs.writeFileSync(path.join(evidence,'primary-failed.json'),JSON.stringify(failed,null,2));console.error(JSON.stringify(failed));process.exitCode=1;}\nfinally{\n if(client)await client.close().catch(error=>{console.error(JSON.stringify({mcpCloseError:String(error)}));process.exitCode=1;});\n if(child){try{await stopPrivateOperatorHost(child,undefined,5000,o=>{observations.push(o);fs.appendFileSync(path.join(evidence,'primary-stop.jsonl'),JSON.stringify(o)+'\\n');});}catch(error){console.error(JSON.stringify({teardownError:String(error)}));process.exitCode=1;}}\n if(log!==undefined)fs.closeSync(log);\n fs.writeFileSync(path.join(evidence,'primary-attempt.json'),JSON.stringify({run,startedAt:new Date(started).toISOString(),elapsedMs:Date.now()-started,failure:failed??null,teardown:observations}));\n console.log(JSON.stringify({phase:'primary-teardown',elapsedMs:Date.now()-started,exitCode:child?.exitCode??null,signal:child?.signalCode??null,observations:observations.map(o=>o.phase)}));\n}\nNODE\n"
  },
  "maintainedPreflightSha256": "93e5a1d678e9b96687765f4548dd92bb741159d2247c30ab103fb7af339fa934",
  "censusFiles": [
    {
      "path": "/tmp/p2p-p536-48ad-20261024-U1aLGd/evidence/source-census.json",
      "sha256": "53423afc2eeaac441e3435a236dbc0b110ca022c7e40ef60b0d0ed0a0192b6e7"
    },
    {
      "path": "/tmp/p2p-p536-48ad-20261024-U1aLGd/evidence/copied-census.json",
      "sha256": "8ff5d2dde86e7b70838b4a22e5b48bc68778a17cfe2dce247d50c518640fb70c"
    }
  ],
  "limits": {
    "setupMaxMs": 180000,
    "actualContinuousSetupMs": 124800,
    "actualWithTeardownMs": 127397,
    "teardownMaxMs": 30000
  },
  "unrun": [
    "actual native worker",
    "standing/device attestation",
    "provider class/conformance binding",
    "identity/grant",
    "VM/domain/lease mapping",
    "protected writer/reader/challenges",
    "intended installed allow assertion-red",
    "original frozen manifest revision1"
  ],
  "noGO": true,
  "noShipment": true,
  "noGistOrAccountAuthorization": true,
  "supersededInputOnlyImport": {
    "run": "/tmp/p2p-p536-48ad-20261024-xjSKiC",
    "runtime": "not-started",
    "setupCredit": false
  }
}
