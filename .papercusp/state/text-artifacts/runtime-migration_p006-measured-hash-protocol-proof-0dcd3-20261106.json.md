---
rel_path: "runtime-migration/p006-measured-hash-protocol-proof-0dcd3-20261106.json"
updated_at: 1793942541515
_body: "content"
---

{
  "schemaVersion": "bun-p006-spec-hash-protocol-distinguishing-proof-v1",
  "ownerId": "su-0dcd3a3c-a45f-482b-a8cd-e957407353f9",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "workItem": "WI-6554700010022072",
  "priorFailedAuditProof": "runtime-migration/p006-d8d0-audit-failed-replay-diagnosis-0dcd3-20261106.json",
  "measurement": {
    "procedure": "Load exact saved historical rows through plans:get-specs on 3170 at cutoff; call maintained computeSpecSetHash on original rows then on copies omitting only falsifier. Same process and source for both variants; no clause writes.",
    "currentProtocol": 2,
    "sourceHash": "7136a8e056fe1b04d74a8810747eb1965417f5c5d4c27f3c4f6f22e520b79633",
    "exactRowsSha256": "967b8f4e1af1c98308a9406b12c254231fd15507ab99dbf524d0f023f821fec5",
    "rows": 27,
    "declaredFalsifiers": 27,
    "withFalsifiers": "57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186",
    "withoutFalsifiers": "d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40",
    "conclusion": "The observed two hashes differ solely by inclusion of declared falsifiers on this exact saved population. This establishes a semantic hash protocol difference, not changed behavior rows or semantic failure of the old clauses."
  },
  "selection": {
    "planContentHash": "af2aa1ded67bf168291f875b5ba74bceda3bafa932fab2f8d52ea67ed424975f",
    "clausesAsOf": "2026-10-23T19:18:53.760Z",
    "route": "http://127.0.0.1:3170"
  },
  "exactSelectedRows": [
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "accepted-shipment",
      "sourceValId": null,
      "currentRevision": 2,
      "revision": 2,
      "planItemId": "P-008",
      "behavior": "The shipped active runtime identity equals the independently accepted immutable candidate identity.",
      "behaviorClass": "lifecycle",
      "requiredEvidence": [
        "deployed",
        "tree"
      ],
      "requiredTestLayers": [
        "e2e"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "Final release or installed runtime identity differs from acceptance or a mandatory leg remains failed/unmeasured.",
        "probeMethod": "After independent candidate acceptance and author verdict, promote/deploy through the normal release pipeline. Compare accepted and final-release/installed source/artifact/runtime binary/version/platform/native dependency/lockfile/configuration/schema-bound identities on every required target. Current staging and detector tests do not establish shipment.",
        "requiredScenarios": [
          "different-artifact",
          "different-configuration",
          "different-dependencies",
          "different-runtime",
          "different-source",
          "exact-shipment",
          "unmeasured-leg"
        ]
      },
      "contentHash": "8379e79eea536eb029cf31dc1f8046076bea5e89b11c5c909fe74746e72a30c1",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-22T23:34:29.876Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-22T23:34:29.982Z",
      "acceptanceRef": "node-to-bun-staged-migration-2026-10-22#D-002",
      "sourceBar": null
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "artifact-runtimes",
      "sourceValId": null,
      "currentRevision": 2,
      "revision": 2,
      "planItemId": "P-006",
      "behavior": "Each supported installed artifact launches its selected pinned runtime from its own runtime closure.",
      "behaviorClass": "happy-path",
      "requiredEvidence": [
        "deployed",
        "tree"
      ],
      "requiredTestLayers": [
        "e2e",
        "unit"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "An installed artifact uses host PATH or cannot launch the packaged selected runtime including retained Node.",
        "probeMethod": "Use the source-derived configured server/Tauri OS/arch matrix. Produce through maintained packagers and run offline clean-install, upgrade, restart and rollback with host Node/Bun absent from PATH. Record installer/artifact/runtime/native digests and actual PID runtime. Unsupported capacity is unmeasured, never deleted from required scope.",
        "requiredScenarios": [
          "host-path-poison",
          "offline-install",
          "offline-node-rollback",
          "offline-restart",
          "offline-upgrade"
        ]
      },
      "contentHash": "207faedd91a3ab46841b78ae432abeb838ca133c7bf78e81a354c2e3513de464",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-22T23:34:29.876Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-22T23:34:29.992Z",
      "acceptanceRef": "node-to-bun-staged-migration-2026-10-22#D-002",
      "sourceBar": null
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "AUTO-BAR-R-1-P-001",
      "sourceValId": null,
      "currentRevision": 4,
      "revision": 4,
      "planItemId": "P-001",
      "behavior": "Each ordinary launcher keeps an operational pinned Node default until exact candidate acceptance authorizes cutover.",
      "behaviorClass": "happy-path",
      "requiredEvidence": [
        "live"
      ],
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "Node is not the measured active default at any ordinary launcher before acceptance, a required live or installed launch receipt is absent, or a default switch accepts an absent, stale or wrong-candidate receipt."
      },
      "contentHash": "808575491dbfdd984a981de6a121cebb0ad0aaf251bb443b0de87c83f98f4e02",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-23T19:18:53.256Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-23T19:18:53.261Z",
      "acceptanceRef": "acceptance-node-to-bun-staged-migration-2026-10-22@3:R-1",
      "sourceBar": {
        "barKey": "R-1",
        "barHash": "e427ef44dc876be80811fb6f8e91ccd421c2107db453201878c5ac4e493de267",
        "barSetHash": "4c80c0b06a4f90548adcb597de9e5f86a852ae033272acab2ffe833ac21e4b0c",
        "rubricSlug": "acceptance-node-to-bun-staged-migration-2026-10-22",
        "rubricRevision": 3,
        "evidencePlane": "live"
      }
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "AUTO-BAR-R-1-P-002",
      "sourceValId": null,
      "currentRevision": 4,
      "revision": 4,
      "planItemId": "P-002",
      "behavior": "Each ordinary launcher keeps an operational pinned Node default until exact candidate acceptance authorizes cutover.",
      "behaviorClass": "happy-path",
      "requiredEvidence": [
        "live"
      ],
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "Node is not the measured active default at any ordinary launcher before acceptance, a required live or installed launch receipt is absent, or a default switch accepts an absent, stale or wrong-candidate receipt."
      },
      "contentHash": "155bbca6d8dcf9f2452d41a8eb14df9cdf49c6565e7cab5501d977fc037ba750",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-23T19:18:53.279Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-23T19:18:53.291Z",
      "acceptanceRef": "acceptance-node-to-bun-staged-migration-2026-10-22@3:R-1",
      "sourceBar": {
        "barKey": "R-1",
        "barHash": "e427ef44dc876be80811fb6f8e91ccd421c2107db453201878c5ac4e493de267",
        "barSetHash": "4c80c0b06a4f90548adcb597de9e5f86a852ae033272acab2ffe833ac21e4b0c",
        "rubricSlug": "acceptance-node-to-bun-staged-migration-2026-10-22",
        "rubricRevision": 3,
        "evidencePlane": "live"
      }
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "AUTO-BAR-R-2-P-001",
      "sourceValId": null,
      "currentRevision": 3,
      "revision": 3,
      "planItemId": "P-001",
      "behavior": "Each required capability leg in the source-derived supported-role census produces its declared semantic result under the selected pinned candidate interpreter.",
      "behaviorClass": "happy-path",
      "requiredEvidence": [
        "live"
      ],
      "requiredTestLayers": [
        "e2e",
        "integration"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "A required capability leg is failed, unmeasured, skipped, or attributed to a different interpreter while the candidate is called compatible."
      },
      "contentHash": "274e329bb67af621000577319a7d379c1413ac51549fe0b85b94fd2e526a47af",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-23T19:18:53.314Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-23T19:18:53.438Z",
      "acceptanceRef": "acceptance-node-to-bun-staged-migration-2026-10-22@2:R-2",
      "sourceBar": {
        "barKey": "R-2",
        "barHash": "6e683650d77729eb1b4a8c32c7a1fdc0293b2f2ef0a08840af298e15938f0057",
        "barSetHash": "326b1f33cfe7581961bd24d39d5af46e9386b744264e099d43020a5244f7f131",
        "rubricSlug": "acceptance-node-to-bun-staged-migration-2026-10-22",
        "rubricRevision": 2,
        "evidencePlane": "live"
      }
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "AUTO-BAR-R-2-P-003",
      "sourceValId": null,
      "currentRevision": 3,
      "revision": 3,
      "planItemId": "P-003",
      "behavior": "Each required capability leg in the source-derived supported-role census produces its declared semantic result under the selected pinned candidate interpreter.",
      "behaviorClass": "happy-path",
      "requiredEvidence": [
        "live"
      ],
      "requiredTestLayers": [
        "e2e",
        "integration"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "A required capability leg is failed, unmeasured, skipped, or attributed to a different interpreter while the candidate is called compatible."
      },
      "contentHash": "2000b8b708635a2dd221e92f53221f5de1b5c3dde37d47651dbc0e2193ee4f24",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-23T19:18:53.473Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-23T19:18:53.482Z",
      "acceptanceRef": "acceptance-node-to-bun-staged-migration-2026-10-22@2:R-2",
      "sourceBar": {
        "barKey": "R-2",
        "barHash": "6e683650d77729eb1b4a8c32c7a1fdc0293b2f2ef0a08840af298e15938f0057",
        "barSetHash": "326b1f33cfe7581961bd24d39d5af46e9386b744264e099d43020a5244f7f131",
        "rubricSlug": "acceptance-node-to-bun-staged-migration-2026-10-22",
        "rubricRevision": 2,
        "evidencePlane": "live"
      }
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "AUTO-BAR-R-2-P-007",
      "sourceValId": null,
      "currentRevision": 3,
      "revision": 3,
      "planItemId": "P-007",
      "behavior": "Each required capability leg in the source-derived supported-role census produces its declared semantic result under the selected pinned candidate interpreter.",
      "behaviorClass": "happy-path",
      "requiredEvidence": [
        "live"
      ],
      "requiredTestLayers": [
        "e2e",
        "integration"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "A required capability leg is failed, unmeasured, skipped, or attributed to a different interpreter while the candidate is called compatible."
      },
      "contentHash": "a50d409ba381e472d1d7c1ba7e3ff5efb527e84226fc563a41257b7b34480d73",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-23T19:18:53.496Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-23T19:18:53.514Z",
      "acceptanceRef": "acceptance-node-to-bun-staged-migration-2026-10-22@2:R-2",
      "sourceBar": {
        "barKey": "R-2",
        "barHash": "6e683650d77729eb1b4a8c32c7a1fdc0293b2f2ef0a08840af298e15938f0057",
        "barSetHash": "326b1f33cfe7581961bd24d39d5af46e9386b744264e099d43020a5244f7f131",
        "rubricSlug": "acceptance-node-to-bun-staged-migration-2026-10-22",
        "rubricRevision": 2,
        "evidencePlane": "live"
      }
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "AUTO-BAR-R-3-P-003",
      "sourceValId": null,
      "currentRevision": 3,
      "revision": 3,
      "planItemId": "P-003",
      "behavior": "Each guarded launcher in the source-derived census rejects a planted uncommitted module.",
      "behaviorClass": "happy-path",
      "requiredEvidence": [
        "tree"
      ],
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "A planted dirty or new module executes through a launch entry classified as committed-source guarded."
      },
      "contentHash": "b089a6a03d268f7569757d5276d607693f54def5ef5a651591bca657dc445bfa",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-23T19:18:53.533Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-23T19:18:53.551Z",
      "acceptanceRef": "acceptance-node-to-bun-staged-migration-2026-10-22@2:R-3",
      "sourceBar": {
        "barKey": "R-3",
        "barHash": "2e6355e887db52789a2ccdf581d8171a761165aecbaead9655aec5affde35eb5",
        "barSetHash": "326b1f33cfe7581961bd24d39d5af46e9386b744264e099d43020a5244f7f131",
        "rubricSlug": "acceptance-node-to-bun-staged-migration-2026-10-22",
        "rubricRevision": 2,
        "evidencePlane": "tree"
      }
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "AUTO-BAR-R-3-P-004",
      "sourceValId": null,
      "currentRevision": 3,
      "revision": 3,
      "planItemId": "P-004",
      "behavior": "Each guarded launcher in the source-derived census rejects a planted uncommitted module.",
      "behaviorClass": "happy-path",
      "requiredEvidence": [
        "tree"
      ],
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "A planted dirty or new module executes through a launch entry classified as committed-source guarded."
      },
      "contentHash": "133ccccbcc40188422af61f68a1e5fef930b7b4df89d3f20e08d00e78da00e93",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-23T19:18:53.563Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-23T19:18:53.577Z",
      "acceptanceRef": "acceptance-node-to-bun-staged-migration-2026-10-22@2:R-3",
      "sourceBar": {
        "barKey": "R-3",
        "barHash": "2e6355e887db52789a2ccdf581d8171a761165aecbaead9655aec5affde35eb5",
        "barSetHash": "326b1f33cfe7581961bd24d39d5af46e9386b744264e099d43020a5244f7f131",
        "rubricSlug": "acceptance-node-to-bun-staged-migration-2026-10-22",
        "rubricRevision": 2,
        "evidencePlane": "tree"
      }
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "AUTO-BAR-R-4-P-005",
      "sourceValId": null,
      "currentRevision": 3,
      "revision": 3,
      "planItemId": "P-005",
      "behavior": "Proof reuse accepts only an identical source/runtime/platform/dependency/configuration fingerprint tuple.",
      "behaviorClass": "happy-path",
      "requiredEvidence": [
        "tree"
      ],
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "A proof is reused after one required identity dimension changes, or a Bun failure invalidates an otherwise current Node proof."
      },
      "contentHash": "f72b7eb9ea128d31658fff2c949884a360f10d8207ce1259ec66b6d2ce606d15",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-23T19:18:53.589Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-23T19:18:53.601Z",
      "acceptanceRef": "acceptance-node-to-bun-staged-migration-2026-10-22@2:R-4",
      "sourceBar": {
        "barKey": "R-4",
        "barHash": "828709faeed3eb18287e533ff9b031487232a85c00d5ad2275cf6fb78592483c",
        "barSetHash": "326b1f33cfe7581961bd24d39d5af46e9386b744264e099d43020a5244f7f131",
        "rubricSlug": "acceptance-node-to-bun-staged-migration-2026-10-22",
        "rubricRevision": 2,
        "evidencePlane": "tree"
      }
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "AUTO-BAR-R-5-P-004",
      "sourceValId": null,
      "currentRevision": 3,
      "revision": 3,
      "planItemId": "P-004",
      "behavior": "Each mutating role admits effects only from its current fenced owner.",
      "behaviorClass": "happy-path",
      "requiredEvidence": [
        "live"
      ],
      "requiredTestLayers": [
        "e2e",
        "integration"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "A stale or concurrent Node/Bun owner commits an effect, or a handoff produces a duplicate committed operation."
      },
      "contentHash": "0d38059469aa1fe4ec0349ffd7adcfda8d2d51495ba1cbf7088a5ef8b6e25c09",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-23T19:18:53.615Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-23T19:18:53.623Z",
      "acceptanceRef": "acceptance-node-to-bun-staged-migration-2026-10-22@2:R-5",
      "sourceBar": {
        "barKey": "R-5",
        "barHash": "38fe9f9ea2703d0a0f71889a4de4b31110a564460c9524c3ee42c90298187da6",
        "barSetHash": "326b1f33cfe7581961bd24d39d5af46e9386b744264e099d43020a5244f7f131",
        "rubricSlug": "acceptance-node-to-bun-staged-migration-2026-10-22",
        "rubricRevision": 2,
        "evidencePlane": "live"
      }
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "AUTO-BAR-R-5-P-007",
      "sourceValId": null,
      "currentRevision": 3,
      "revision": 3,
      "planItemId": "P-007",
      "behavior": "Each mutating role admits effects only from its current fenced owner.",
      "behaviorClass": "happy-path",
      "requiredEvidence": [
        "live"
      ],
      "requiredTestLayers": [
        "e2e",
        "integration"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "A stale or concurrent Node/Bun owner commits an effect, or a handoff produces a duplicate committed operation."
      },
      "contentHash": "8b76c238d9444fcf8ac5ce966080bfe6a48230e6575a79bae1dd23e16f6a9038",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-23T19:18:53.634Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-23T19:18:53.648Z",
      "acceptanceRef": "acceptance-node-to-bun-staged-migration-2026-10-22@2:R-5",
      "sourceBar": {
        "barKey": "R-5",
        "barHash": "38fe9f9ea2703d0a0f71889a4de4b31110a564460c9524c3ee42c90298187da6",
        "barSetHash": "326b1f33cfe7581961bd24d39d5af46e9386b744264e099d43020a5244f7f131",
        "rubricSlug": "acceptance-node-to-bun-staged-migration-2026-10-22",
        "rubricRevision": 2,
        "evidencePlane": "live"
      }
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "AUTO-BAR-R-6-P-006",
      "sourceValId": null,
      "currentRevision": 4,
      "revision": 4,
      "planItemId": "P-006",
      "behavior": "Every configured installed product/OS/architecture cell executes its selected packaged runtime offline.",
      "behaviorClass": "happy-path",
      "requiredEvidence": [
        "deployed"
      ],
      "requiredTestLayers": [
        "e2e",
        "unit"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "Any required GUI/server matrix cell lacks current installed semantic execution proof, uses a host PATH runtime, is omitted from canonical coverage, or is accepted solely from another target or a desktop-shell receipt."
      },
      "contentHash": "78722b092024f0846ea267f16aeba43f8a76298ec16a4a0b1570853466bd9b52",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-23T19:18:53.659Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-23T19:18:53.669Z",
      "acceptanceRef": "acceptance-node-to-bun-staged-migration-2026-10-22@3:R-6",
      "sourceBar": {
        "barKey": "R-6",
        "barHash": "abffdb49d829472e693e5f6263197f21c66d7f666e5e8b74d654db7b7cdce091",
        "barSetHash": "4c80c0b06a4f90548adcb597de9e5f86a852ae033272acab2ffe833ac21e4b0c",
        "rubricSlug": "acceptance-node-to-bun-staged-migration-2026-10-22",
        "rubricRevision": 3,
        "evidencePlane": "deployed"
      }
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "AUTO-BAR-R-6-P-007",
      "sourceValId": null,
      "currentRevision": 4,
      "revision": 4,
      "planItemId": "P-007",
      "behavior": "Every configured installed product/OS/architecture cell executes its selected packaged runtime offline.",
      "behaviorClass": "happy-path",
      "requiredEvidence": [
        "deployed"
      ],
      "requiredTestLayers": [
        "e2e",
        "unit"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "Any required GUI/server matrix cell lacks current installed semantic execution proof, uses a host PATH runtime, is omitted from canonical coverage, or is accepted solely from another target or a desktop-shell receipt."
      },
      "contentHash": "08dbd334e8633a12ffc81f2065b7c0cfaa26009dd5ae5d84bdf27aac0ce6f6bc",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-23T19:18:53.679Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-23T19:18:53.690Z",
      "acceptanceRef": "acceptance-node-to-bun-staged-migration-2026-10-22@3:R-6",
      "sourceBar": {
        "barKey": "R-6",
        "barHash": "abffdb49d829472e693e5f6263197f21c66d7f666e5e8b74d654db7b7cdce091",
        "barSetHash": "4c80c0b06a4f90548adcb597de9e5f86a852ae033272acab2ffe833ac21e4b0c",
        "rubricSlug": "acceptance-node-to-bun-staged-migration-2026-10-22",
        "rubricRevision": 3,
        "evidencePlane": "deployed"
      }
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "AUTO-BAR-R-7-P-007",
      "sourceValId": null,
      "currentRevision": 3,
      "revision": 3,
      "planItemId": "P-007",
      "behavior": "Each declared forced-rollback scenario restores its reference data/effect outcome within the declared recovery budget.",
      "behaviorClass": "happy-path",
      "requiredEvidence": [
        "live"
      ],
      "requiredTestLayers": [
        "e2e",
        "integration"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "Restored Node cannot read a Bun-written result, loses an acknowledged operation, repeats an effect, or exceeds the pinned recovery budget."
      },
      "contentHash": "c9b06ebb1bdc0a43972658519ef8dffaa5e87a70c28b8cc441edff882c145bbf",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-23T19:18:53.703Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-23T19:18:53.712Z",
      "acceptanceRef": "acceptance-node-to-bun-staged-migration-2026-10-22@2:R-7",
      "sourceBar": {
        "barKey": "R-7",
        "barHash": "b334f76abeaf2ee3ded4f06cf829f826e88549d0ce58fe33e6dac9a960c69c3a",
        "barSetHash": "326b1f33cfe7581961bd24d39d5af46e9386b744264e099d43020a5244f7f131",
        "rubricSlug": "acceptance-node-to-bun-staged-migration-2026-10-22",
        "rubricRevision": 2,
        "evidencePlane": "live"
      }
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "AUTO-BAR-R-7-P-008",
      "sourceValId": null,
      "currentRevision": 3,
      "revision": 3,
      "planItemId": "P-008",
      "behavior": "Each declared forced-rollback scenario restores its reference data/effect outcome within the declared recovery budget.",
      "behaviorClass": "happy-path",
      "requiredEvidence": [
        "live"
      ],
      "requiredTestLayers": [
        "e2e",
        "integration"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "Restored Node cannot read a Bun-written result, loses an acknowledged operation, repeats an effect, or exceeds the pinned recovery budget."
      },
      "contentHash": "5edc1bb422ebcc011aaaa6a4d21273d5113e2cd7e810aa338e6c49a353315424",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-23T19:18:53.724Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-23T19:18:53.733Z",
      "acceptanceRef": "acceptance-node-to-bun-staged-migration-2026-10-22@2:R-7",
      "sourceBar": {
        "barKey": "R-7",
        "barHash": "b334f76abeaf2ee3ded4f06cf829f826e88549d0ce58fe33e6dac9a960c69c3a",
        "barSetHash": "326b1f33cfe7581961bd24d39d5af46e9386b744264e099d43020a5244f7f131",
        "rubricSlug": "acceptance-node-to-bun-staged-migration-2026-10-22",
        "rubricRevision": 2,
        "evidencePlane": "live"
      }
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "AUTO-BAR-R-8-P-008",
      "sourceValId": null,
      "currentRevision": 4,
      "revision": 4,
      "planItemId": "P-008",
      "behavior": "Each shipped final signed distributable matches the complete final artifact digest independently accepted before cutover.",
      "behaviorClass": "happy-path",
      "requiredEvidence": [
        "deployed"
      ],
      "requiredTestLayers": [
        "e2e"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "A shipped final artifact differs from its independently accepted complete signed artifact digest, or shipment proceeds with a failed or unmeasured mandatory leg."
      },
      "contentHash": "efca1cc760cd14cc160550a22d86a6b789fffd33453ea0b64c1bf51eb7beba0f",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-23T19:18:53.745Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-23T19:18:53.759Z",
      "acceptanceRef": "acceptance-node-to-bun-staged-migration-2026-10-22@3:R-8",
      "sourceBar": {
        "barKey": "R-8",
        "barHash": "41752a15108d147b8485c58d45a2c47c35a05537decb12d9380b74efb612ead7",
        "barSetHash": "4c80c0b06a4f90548adcb597de9e5f86a852ae033272acab2ffe833ac21e4b0c",
        "rubricSlug": "acceptance-node-to-bun-staged-migration-2026-10-22",
        "rubricRevision": 3,
        "evidencePlane": "deployed"
      }
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "background-single-owner",
      "sourceValId": null,
      "currentRevision": 2,
      "revision": 2,
      "planItemId": "P-004",
      "behavior": "Each mutating authority/effect class admits committed effects only from its current fenced owner.",
      "behaviorClass": "concurrency",
      "requiredEvidence": [
        "live",
        "tree"
      ],
      "requiredTestLayers": [
        "e2e",
        "integration",
        "unit"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "A stale or competing Node/Bun owner commits a duplicate or unauthorized effect.",
        "probeMethod": "Use the existing leases/fencing/idempotency authority for each source-derived mutator class in isolated background-federation routes. Race contenders and retain epochs/operation IDs at renewal, expiry, crash-before-effect, crash-after-commit-before-ack, restart and handoff in both directions with a counted sink.",
        "requiredScenarios": [
          "bun-to-node",
          "contender-race",
          "crash-after-commit",
          "crash-before-effect",
          "lease-expiry",
          "lease-renewal",
          "node-to-bun",
          "stale-fence"
        ]
      },
      "contentHash": "a5b3da9ce6acbbd91bac98844d3a7d634e0e11bc529fdb8c0b6238b24c4b1288",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-22T23:34:29.877Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-22T23:34:29.966Z",
      "acceptanceRef": "node-to-bun-staged-migration-2026-10-22#D-002",
      "sourceBar": null
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "candidate-readiness",
      "sourceValId": null,
      "currentRevision": 2,
      "revision": 2,
      "planItemId": "P-007",
      "behavior": "A failed, stale or unmeasured mandatory candidate leg withholds pre-cutover eligibility.",
      "behaviorClass": "failure",
      "requiredEvidence": [
        "live",
        "tree"
      ],
      "requiredTestLayers": [
        "e2e",
        "integration",
        "unit"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "The eligibility evaluator admits a candidate despite a failed or missing required leg.",
        "probeMethod": "Freeze finite required populations and exact immutable candidate identity before runs. Plant failed native capability, unavailable required platform, stale/wrong artifact, missing proof and failing soak/rollback. Require actual R-1..R-7 and applicable atomic outcomes, independent acceptance and author verdict before default cutover; R-8 verifies later shipment separately. Matched soak>=60min and1000operations, errors<=0.1%, p95<=1.25xNode, throughput>=0.9xNode,last20min memory slope<=1MiB/min.",
        "requiredScenarios": [
          "complete-candidate",
          "failed-capability",
          "failed-rollback",
          "failed-soak",
          "stale-proof",
          "unmeasured-platform",
          "wrong-artifact"
        ]
      },
      "contentHash": "8c49889591b4719ea2569892b6d269acae9322c21daa890ace3a01e5f2478c2a",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-22T23:34:29.877Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-22T23:34:29.966Z",
      "acceptanceRef": "node-to-bun-staged-migration-2026-10-22#D-002",
      "sourceBar": null
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "child-selection",
      "sourceValId": null,
      "currentRevision": 4,
      "revision": 4,
      "planItemId": "P-004",
      "behavior": "Each inventoried child launch uses the interpreter declared for its process role.",
      "behaviorClass": "lifecycle",
      "requiredEvidence": [
        "live",
        "tree"
      ],
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "A launched child reports an interpreter different from the interpreter declared for its process role.",
        "probeMethod": "Exercise every distinct host/spawner boundary and observe actual child executable digest/version/argv/environment, not the parent process name. External CLIs and maintained Node native boundaries retain their declared interpreter and typed error/cancellation/lifecycle contract. Boundary cases include execPath, shell, cluster, workers and external CLIs.",
        "requiredScenarios": [
          "cluster-child",
          "execpath-child",
          "external-cli",
          "shell-child",
          "worker-child"
        ]
      },
      "contentHash": "bb84811f03388b9dd50fa05704ab06b545e60f78117960a6041c034bc542ab27",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-22T23:37:59.947Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-22T23:38:00.148Z",
      "acceptanceRef": "node-to-bun-staged-migration-2026-10-22#D-002",
      "sourceBar": null
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "guard-preservation",
      "sourceValId": null,
      "currentRevision": 2,
      "revision": 2,
      "planItemId": "P-003",
      "behavior": "Each inventoried guarded launch rejects modules or artifacts whose bytes differ from its admitted committed identity.",
      "behaviorClass": "authorization",
      "requiredEvidence": [
        "tree"
      ],
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "mutationRequired": true,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "A planted dirty/new/sibling checkout module or tampered artifact executes at a guarded boundary.",
        "probeMethod": "Retain Node loader orchestration where required; Bun loads only verified immutable bundles unless equivalent enforcement is proven. Pair dirty existing import, new import, sibling-repository import and tampered bundle with clean controls at every distinct guard boundary.",
        "requiredScenarios": [
          "clean-control",
          "dirty-import",
          "new-import",
          "sibling-import",
          "tampered-artifact"
        ]
      },
      "contentHash": "721e80d2f07bf2d935c2102cc70eff70bb0761653fc7bbee0bf9aa95733df107",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-22T23:34:37.960Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-22T23:34:39.525Z",
      "acceptanceRef": "node-to-bun-staged-migration-2026-10-22#D-002",
      "sourceBar": null
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "inventory-evidence",
      "sourceValId": null,
      "currentRevision": 2,
      "revision": 2,
      "planItemId": "P-001",
      "behavior": "A compatibility report admits a required capability result only when the identified interpreter completes its declared semantic operation.",
      "behaviorClass": "observability",
      "requiredEvidence": [
        "live",
        "tree"
      ],
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "A capability is reported passed from import-only success, premature zero exit, a wrong semantic result, or an unknown interpreter.",
        "probeMethod": "Derive the finite role/launcher/native/platform/guard/proof/mutator/persistence censuses from committed sources. Preserve required/unreachable/external classification and unavailable capacity. For each required capability run a real semantic roundtrip and Node positive control, recording executable digest/version, platform, dependencies and expected/actual result. Plant pass, throw, timeout, premature-zero, incorrect-result and wrong-interpreter controls.",
        "requiredScenarios": [
          "incorrect-result",
          "pass",
          "premature-zero",
          "throw",
          "timeout",
          "wrong-interpreter"
        ]
      },
      "contentHash": "7453fc0efaed3d481de42360dc3c8e796303c13f819001755151dae491887662",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-22T23:34:37.959Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-22T23:34:39.520Z",
      "acceptanceRef": "node-to-bun-staged-migration-2026-10-22#D-002",
      "sourceBar": null
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "proof-separation",
      "sourceValId": null,
      "currentRevision": 2,
      "revision": 2,
      "planItemId": "P-005",
      "behavior": "A proof is reusable only for the identical source/runtime/platform/dependency/configuration identity tuple.",
      "behaviorClass": "boundary",
      "requiredEvidence": [
        "tree"
      ],
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "mutationRequired": true,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "A producer or consumer reuses proof after one required identity dimension changes.",
        "probeMethod": "Derive the finite existing proof/cache/result writer-reader census. Vary committed source, runtime name/version/binary digest, OS/architecture, native dependency generation, npm lockfile and configuration one at a time in both directions; missing fields fail closed. Confirm exact identity hits and Bun failure preserves a current Node verdict. Extend existing stores only.",
        "requiredScenarios": [
          "arch-change",
          "binary-change",
          "configuration-change",
          "identical-hit",
          "lockfile-change",
          "missing-identity",
          "native-generation-change",
          "node-proof-preserved",
          "os-change",
          "runtime-change",
          "source-change",
          "version-change"
        ]
      },
      "contentHash": "95f16ddb901cc5d2c78f2fbd6d992487ad77ed2a2ec15fd31b066d80a7ec4f1d",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-22T23:34:37.959Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-22T23:34:39.524Z",
      "acceptanceRef": "node-to-bun-staged-migration-2026-10-22#D-002",
      "sourceBar": null
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "rollback-data",
      "sourceValId": null,
      "currentRevision": 2,
      "revision": 2,
      "planItemId": "P-007",
      "behavior": "Each forced-rollback scenario restores its reference durable data and effect outcome within the pinned recovery budget.",
      "behaviorClass": "migration-data-integrity",
      "requiredEvidence": [
        "live",
        "tree"
      ],
      "requiredTestLayers": [
        "e2e",
        "integration"
      ],
      "mutationRequired": true,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "Rollback loses an acknowledged operation, duplicates an effect, cannot read either runtime-written state, or exceeds the pinned recovery budget.",
        "probeMethod": "For each persistent schema/row/file/queue/event/cache/in-flight class, execute Bun-write/Node-read and Node-write/Bun-read using the immutable candidate tuple. Kill before/after durable commit and during drain/handoff; compare values and operation IDs to matched Node reference. Require recovery<=120s, drain<=30s, no lost acknowledged operations or duplicate effects. Snapshot before destructive change.",
        "requiredScenarios": [
          "bun-write-node-read",
          "kill-after-commit",
          "kill-before-commit",
          "kill-during-drain",
          "kill-during-handoff",
          "node-write-bun-read"
        ]
      },
      "contentHash": "f767c78a895f46db904136b1b1099cfd28a28a0028ef96f8724b65b9c6ceb267",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-22T23:34:46.535Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-22T23:34:46.608Z",
      "acceptanceRef": "node-to-bun-staged-migration-2026-10-22#D-002",
      "sourceBar": null
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "rollback-retention",
      "sourceValId": null,
      "currentRevision": 2,
      "revision": 2,
      "planItemId": "P-008",
      "behavior": "The installed compatible Node rollback closure remains launchable under a persisted seven-day minimum no-collection policy.",
      "behaviorClass": "lifecycle",
      "requiredEvidence": [
        "deployed",
        "tree"
      ],
      "requiredTestLayers": [
        "e2e",
        "unit"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "Cleanup, upgrade, reinstall or clock rollback permits removal of the retained Node runtime/native closure before the cutover deadline.",
        "probeMethod": "Persist authoritative cutoverAt and deadline>=cutoverAt+7days. At shipment verify installed Node launches after Bun-written state and early collection is refused, including upgrade/reinstall and wall-clock rollback. Simulated deadline tests establish policy only; do not claim seven elapsed days. Retain the pin until deadline plus verification; Node removal is outside scope.",
        "requiredScenarios": [
          "clock-rollback",
          "installed-node-launch",
          "predeadline-collection",
          "reinstall-retention",
          "upgrade-retention"
        ]
      },
      "contentHash": "9e571a643291788e039d5ecf4aad42a6d84c146742b9fd7faafdaacae234fe3c",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-22T23:34:46.539Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-22T23:34:46.612Z",
      "acceptanceRef": "node-to-bun-staged-migration-2026-10-22#D-002",
      "sourceBar": null
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "runtime-gc",
      "sourceValId": null,
      "currentRevision": 2,
      "revision": 2,
      "planItemId": "P-003",
      "behavior": "The selected runtime memory-recovery boundary produces an observable supported recovery action or explicit safe escalation.",
      "behaviorClass": "failure",
      "requiredEvidence": [
        "live",
        "tree"
      ],
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "mutationRequired": false,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "Memory recovery silently loses its configured action when an engine-specific API throws or is unavailable.",
        "probeMethod": "Use actual runtime action markers and pressure/restart/signal/exit probes. Inject unavailable/throwing V8 and Bun hooks and verify supported collection or an explicit observable bounded safe escalation, never catch-and-ignore. Profiling and supervision remain separate capability legs in the census.",
        "requiredScenarios": [
          "bun-action",
          "node-action",
          "safe-escalation",
          "throwing-action",
          "unsupported-action"
        ]
      },
      "contentHash": "2025ef430a10aedc97cb94c16cfef7bf17537d1f5559a91727c77c5a69e0dba2",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-22T23:34:46.550Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-22T23:34:46.625Z",
      "acceptanceRef": "node-to-bun-staged-migration-2026-10-22#D-002",
      "sourceBar": null
    },
    {
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "specId": "runtime-selection",
      "sourceValId": null,
      "currentRevision": 2,
      "revision": 2,
      "planItemId": "P-002",
      "behavior": "Normal launch defaults remain pinned Node until the exact candidate receives independent pre-cutover acceptance.",
      "behaviorClass": "authorization",
      "requiredEvidence": [
        "tree"
      ],
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "mutationRequired": true,
      "lifecycleStatus": "active",
      "supersedes": null,
      "exemption": null,
      "falsifier": {
        "observation": "An absent, malformed, unknown-role, stale-receipt or different-candidate selection replaces the normal Node default.",
        "probeMethod": "Exercise each inventoried launch boundary with exact runtime binary/configuration identity. Explicit isolated/canary Bun uses separate ports/data/identity and never changes normal defaults. Reject missing binary digest, hostile PATH, incompatible flags and wrong acceptance tuple. Test current-candidate acceptance as the positive control.",
        "requiredScenarios": [
          "hostile-path",
          "incompatible-flags",
          "isolated-bun",
          "malformed-selector",
          "node-default",
          "stale-acceptance",
          "unknown-role",
          "wrong-candidate"
        ]
      },
      "contentHash": "25537f8635bc1622510bf5ec00fb132c05089ae1b8677e4a0be0115a3d2d7f6a",
      "createdBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "createdAt": "2026-10-22T23:34:46.550Z",
      "acceptedBy": "su-501c9929-ca51-40f3-a17f-7f69304b0906",
      "acceptedAt": "2026-10-22T23:34:46.625Z",
      "acceptanceRef": "node-to-bun-staged-migration-2026-10-22#D-002",
      "sourceBar": null
    }
  ],
  "currentStagingReplay": {
    "completeChars": 48801,
    "sha256": "751d0eab850bb6a3a66aae9d8feafacb21aaf1a1850532194faf4ba6c31719c5",
    "result": {
      "ok": true,
      "slug": "node-to-bun-staged-migration-2026-10-22",
      "harnessSlug": "papercusp",
      "replaySnapshot": {
        "planContentHash": "af2aa1ded67bf168291f875b5ba74bceda3bafa932fab2f8d52ea67ed424975f",
        "clausesAsOf": "2026-10-23T19:18:53.760Z"
      },
      "planSlug": "node-to-bun-staged-migration-2026-10-22",
      "classRef": "plan-class-migration",
      "specSetHash": "57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186",
      "clauseCount": 27,
      "planItemCount": 8,
      "ratings": {
        "stable-revision-identity": {
          "rating": "pass",
          "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"stable-revision-identity\"]. 27 current clause(s) have unique identities, content hashes, and acceptance provenance. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"af2aa1ded67bf168291f875b5ba74bceda3bafa932fab2f8d52ea67ed424975f\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
        },
        "item-contract-coverage": {
          "rating": "pass",
          "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"item-contract-coverage\"]. All 8 plan item(s) are covered by active item clauses or explicit exemptions. 15 sourceBar-pinned projection(s) are excluded as copies of canonical acceptance BARs; added or meaning-changed BAR projections are checked on rubric writes, while unchanged legacy BARs are not re-certified here. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"af2aa1ded67bf168291f875b5ba74bceda3bafa932fab2f8d52ea67ed424975f\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
        },
        "atomic-observable-behavior": {
          "rating": "pass",
          "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"atomic-observable-behavior\"]. 12 independent item behavior clause(s) passed the supported structural atomicity checks. 15 sourceBar-pinned projection(s) are excluded as copies of canonical acceptance BARs; added or meaning-changed BAR projections are checked on rubric writes, while unchanged legacy BARs are not re-certified here. Coverage: 12 of 27 active behavioral clause(s) evaluated; 15 active sourceBar-pinned BAR projection(s) excluded (new or meaning-changed canonical BAR projections are checked on rubric writes; unchanged legacy BARs are not re-certified here); per-clause dispositions are in details.atomicityClauseDiagnostics. Detector controls: 4/4 compound counterexamples rejected; 4/4 single-outcome controls accepted; see details.atomicityDetectorControls. Coverage is structural pattern detection, not a proof of arbitrary natural-language semantics. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"af2aa1ded67bf168291f875b5ba74bceda3bafa932fab2f8d52ea67ed424975f\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
        },
        "falsifiability": {
          "rating": "pass",
          "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"falsifiability\"]. 12 independent item behavior clause(s) state falsifiable outcomes. 15 sourceBar-pinned projection(s) are excluded as copies of canonical acceptance BARs; added or meaning-changed BAR projections are checked on rubric writes, while unchanged legacy BARs are not re-certified here. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"af2aa1ded67bf168291f875b5ba74bceda3bafa932fab2f8d52ea67ed424975f\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
        },
        "implementation-independence": {
          "rating": "pass",
          "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"implementation-independence\"]. No active/accepted behavior clause is coupled to an implementation detail covered by the detector. Fields inspected per clause: behavior and falsifier.observation (falsifier.probeMethod is excluded because it legitimately names the test or probe). Detector coverage: implementation filenames, explicitly qualified/quoted construct symbols (including snake_case identifiers), bare lowerCamel identifiers (excluding recognized public platform/device names), repository paths, internal route literals, named operations, mandated reuse of existing surfaces (including runtimes, flows, pipelines, ledgers, mechanisms, scheduling paths and sweeps, including passive by prescriptions), imperative implementation selection, filesystem permission modes, named storage backends, encryption, and mirroring. Inspected 27 active/accepted behavior clause(s), including 15 sourceBar-pinned acceptance BAR projection(s). 0 draft/exempt clause(s) excluded; per-clause dispositions are in details.implementationIndependenceClauseDiagnostics. Detector controls: see details.implementationIndependenceDetectorControls for coupled counterexamples and independent observable outcomes. Coverage is structural pattern detection, not a proof of arbitrary natural-language semantics. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"af2aa1ded67bf168291f875b5ba74bceda3bafa932fab2f8d52ea67ed424975f\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
        },
        "explicit-non-behavioral-exemptions": {
          "rating": "not-applicable",
          "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"explicit-non-behavioral-exemptions\"]. Exact clause scope 57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186 contains 27 current row(s); 0 exempt ([]), 0 valid and 0 invalid; invalid ids=[]; row census SHA-256=61ec474af71f2ff1125ae7427795e056255753fd4f6e7a379852757dfa8cb59a. Replay this exact snapshot and compare details.exemptionCensus.rows. No clause claims a non-behavioral exemption. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"af2aa1ded67bf168291f875b5ba74bceda3bafa932fab2f8d52ea67ed424975f\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
        },
        "plan-class-specialization": {
          "rating": "pass",
          "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"plan-class-specialization\"]. Migration plan includes an active migration-data-integrity contract. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"af2aa1ded67bf168291f875b5ba74bceda3bafa932fab2f8d52ea67ed424975f\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
        },
        "spec-set-freshness": {
          "rating": "pass",
          "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"spec-set-freshness\"]. Verdict is pinned to exact current specSetHash 57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186 over 27 clause(s). Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"af2aa1ded67bf168291f875b5ba74bceda3bafa932fab2f8d52ea67ed424975f\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
        }
      },
      "verdict": "pass",
      "wouldBlock": [],
      "details": {
        "uncoveredPlanItemIds": [],
        "invalidExemptionSpecIds": [],
        "exemptionCensus": {
          "specSetHash": "57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186",
          "currentClauseCount": 27,
          "exemptClauseCount": 0,
          "validExemptionSpecIds": [],
          "invalidExemptionSpecIds": [],
          "censusSha256": "61ec474af71f2ff1125ae7427795e056255753fd4f6e7a379852757dfa8cb59a",
          "rows": [
            {
              "specId": "accepted-shipment",
              "revision": 2,
              "planItemId": "P-008",
              "lifecycleStatus": "active",
              "behaviorClass": "lifecycle",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "artifact-runtimes",
              "revision": 2,
              "planItemId": "P-006",
              "lifecycleStatus": "active",
              "behaviorClass": "happy-path",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "AUTO-BAR-R-1-P-001",
              "revision": 4,
              "planItemId": "P-001",
              "lifecycleStatus": "active",
              "behaviorClass": "happy-path",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "AUTO-BAR-R-1-P-002",
              "revision": 4,
              "planItemId": "P-002",
              "lifecycleStatus": "active",
              "behaviorClass": "happy-path",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "AUTO-BAR-R-2-P-001",
              "revision": 3,
              "planItemId": "P-001",
              "lifecycleStatus": "active",
              "behaviorClass": "happy-path",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "AUTO-BAR-R-2-P-003",
              "revision": 3,
              "planItemId": "P-003",
              "lifecycleStatus": "active",
              "behaviorClass": "happy-path",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "AUTO-BAR-R-2-P-007",
              "revision": 3,
              "planItemId": "P-007",
              "lifecycleStatus": "active",
              "behaviorClass": "happy-path",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "AUTO-BAR-R-3-P-003",
              "revision": 3,
              "planItemId": "P-003",
              "lifecycleStatus": "active",
              "behaviorClass": "happy-path",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "AUTO-BAR-R-3-P-004",
              "revision": 3,
              "planItemId": "P-004",
              "lifecycleStatus": "active",
              "behaviorClass": "happy-path",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "AUTO-BAR-R-4-P-005",
              "revision": 3,
              "planItemId": "P-005",
              "lifecycleStatus": "active",
              "behaviorClass": "happy-path",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "AUTO-BAR-R-5-P-004",
              "revision": 3,
              "planItemId": "P-004",
              "lifecycleStatus": "active",
              "behaviorClass": "happy-path",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "AUTO-BAR-R-5-P-007",
              "revision": 3,
              "planItemId": "P-007",
              "lifecycleStatus": "active",
              "behaviorClass": "happy-path",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "AUTO-BAR-R-6-P-006",
              "revision": 4,
              "planItemId": "P-006",
              "lifecycleStatus": "active",
              "behaviorClass": "happy-path",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "AUTO-BAR-R-6-P-007",
              "revision": 4,
              "planItemId": "P-007",
              "lifecycleStatus": "active",
              "behaviorClass": "happy-path",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "AUTO-BAR-R-7-P-007",
              "revision": 3,
              "planItemId": "P-007",
              "lifecycleStatus": "active",
              "behaviorClass": "happy-path",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "AUTO-BAR-R-7-P-008",
              "revision": 3,
              "planItemId": "P-008",
              "lifecycleStatus": "active",
              "behaviorClass": "happy-path",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "AUTO-BAR-R-8-P-008",
              "revision": 4,
              "planItemId": "P-008",
              "lifecycleStatus": "active",
              "behaviorClass": "happy-path",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "background-single-owner",
              "revision": 2,
              "planItemId": "P-004",
              "lifecycleStatus": "active",
              "behaviorClass": "concurrency",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "candidate-readiness",
              "revision": 2,
              "planItemId": "P-007",
              "lifecycleStatus": "active",
              "behaviorClass": "failure",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "child-selection",
              "revision": 4,
              "planItemId": "P-004",
              "lifecycleStatus": "active",
              "behaviorClass": "lifecycle",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "guard-preservation",
              "revision": 2,
              "planItemId": "P-003",
              "lifecycleStatus": "active",
              "behaviorClass": "authorization",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "inventory-evidence",
              "revision": 2,
              "planItemId": "P-001",
              "lifecycleStatus": "active",
              "behaviorClass": "observability",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "proof-separation",
              "revision": 2,
              "planItemId": "P-005",
              "lifecycleStatus": "active",
              "behaviorClass": "boundary",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "rollback-data",
              "revision": 2,
              "planItemId": "P-007",
              "lifecycleStatus": "active",
              "behaviorClass": "migration-data-integrity",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "rollback-retention",
              "revision": 2,
              "planItemId": "P-008",
              "lifecycleStatus": "active",
              "behaviorClass": "lifecycle",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "runtime-gc",
              "revision": 2,
              "planItemId": "P-003",
              "lifecycleStatus": "active",
              "behaviorClass": "failure",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            },
            {
              "specId": "runtime-selection",
              "revision": 2,
              "planItemId": "P-002",
              "lifecycleStatus": "active",
              "behaviorClass": "authorization",
              "exemptionDeclared": false,
              "valid": null,
              "hasJustification": false,
              "hasProvenance": false
            }
          ]
        },
        "draftSpecIds": [],
        "atomicityClauseDiagnostics": [
          {
            "specId": "accepted-shipment",
            "planItemId": "P-008",
            "behavior": "The shipped active runtime identity equals the independently accepted immutable candidate identity.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "artifact-runtimes",
            "planItemId": "P-006",
            "behavior": "Each supported installed artifact launches its selected pinned runtime from its own runtime closure.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "AUTO-BAR-R-1-P-001",
            "planItemId": "P-001",
            "behavior": "Each ordinary launcher keeps an operational pinned Node default until exact candidate acceptance authorizes cutover.",
            "disposition": "excluded",
            "rating": "not-applicable",
            "reason": "sourceBar-pinned BAR projection is not an independent item behavior clause."
          },
          {
            "specId": "AUTO-BAR-R-1-P-002",
            "planItemId": "P-002",
            "behavior": "Each ordinary launcher keeps an operational pinned Node default until exact candidate acceptance authorizes cutover.",
            "disposition": "excluded",
            "rating": "not-applicable",
            "reason": "sourceBar-pinned BAR projection is not an independent item behavior clause."
          },
          {
            "specId": "AUTO-BAR-R-2-P-001",
            "planItemId": "P-001",
            "behavior": "Each required capability leg in the source-derived supported-role census produces its declared semantic result under the selected pinned candidate interpreter.",
            "disposition": "excluded",
            "rating": "not-applicable",
            "reason": "sourceBar-pinned BAR projection is not an independent item behavior clause."
          },
          {
            "specId": "AUTO-BAR-R-2-P-003",
            "planItemId": "P-003",
            "behavior": "Each required capability leg in the source-derived supported-role census produces its declared semantic result under the selected pinned candidate interpreter.",
            "disposition": "excluded",
            "rating": "not-applicable",
            "reason": "sourceBar-pinned BAR projection is not an independent item behavior clause."
          },
          {
            "specId": "AUTO-BAR-R-2-P-007",
            "planItemId": "P-007",
            "behavior": "Each required capability leg in the source-derived supported-role census produces its declared semantic result under the selected pinned candidate interpreter.",
            "disposition": "excluded",
            "rating": "not-applicable",
            "reason": "sourceBar-pinned BAR projection is not an independent item behavior clause."
          },
          {
            "specId": "AUTO-BAR-R-3-P-003",
            "planItemId": "P-003",
            "behavior": "Each guarded launcher in the source-derived census rejects a planted uncommitted module.",
            "disposition": "excluded",
            "rating": "not-applicable",
            "reason": "sourceBar-pinned BAR projection is not an independent item behavior clause."
          },
          {
            "specId": "AUTO-BAR-R-3-P-004",
            "planItemId": "P-004",
            "behavior": "Each guarded launcher in the source-derived census rejects a planted uncommitted module.",
            "disposition": "excluded",
            "rating": "not-applicable",
            "reason": "sourceBar-pinned BAR projection is not an independent item behavior clause."
          },
          {
            "specId": "AUTO-BAR-R-4-P-005",
            "planItemId": "P-005",
            "behavior": "Proof reuse accepts only an identical source/runtime/platform/dependency/configuration fingerprint tuple.",
            "disposition": "excluded",
            "rating": "not-applicable",
            "reason": "sourceBar-pinned BAR projection is not an independent item behavior clause."
          },
          {
            "specId": "AUTO-BAR-R-5-P-004",
            "planItemId": "P-004",
            "behavior": "Each mutating role admits effects only from its current fenced owner.",
            "disposition": "excluded",
            "rating": "not-applicable",
            "reason": "sourceBar-pinned BAR projection is not an independent item behavior clause."
          },
          {
            "specId": "AUTO-BAR-R-5-P-007",
            "planItemId": "P-007",
            "behavior": "Each mutating role admits effects only from its current fenced owner.",
            "disposition": "excluded",
            "rating": "not-applicable",
            "reason": "sourceBar-pinned BAR projection is not an independent item behavior clause."
          },
          {
            "specId": "AUTO-BAR-R-6-P-006",
            "planItemId": "P-006",
            "behavior": "Every configured installed product/OS/architecture cell executes its selected packaged runtime offline.",
            "disposition": "excluded",
            "rating": "not-applicable",
            "reason": "sourceBar-pinned BAR projection is not an independent item behavior clause."
          },
          {
            "specId": "AUTO-BAR-R-6-P-007",
            "planItemId": "P-007",
            "behavior": "Every configured installed product/OS/architecture cell executes its selected packaged runtime offline.",
            "disposition": "excluded",
            "rating": "not-applicable",
            "reason": "sourceBar-pinned BAR projection is not an independent item behavior clause."
          },
          {
            "specId": "AUTO-BAR-R-7-P-007",
            "planItemId": "P-007",
            "behavior": "Each declared forced-rollback scenario restores its reference data/effect outcome within the declared recovery budget.",
            "disposition": "excluded",
            "rating": "not-applicable",
            "reason": "sourceBar-pinned BAR projection is not an independent item behavior clause."
          },
          {
            "specId": "AUTO-BAR-R-7-P-008",
            "planItemId": "P-008",
            "behavior": "Each declared forced-rollback scenario restores its reference data/effect outcome within the declared recovery budget.",
            "disposition": "excluded",
            "rating": "not-applicable",
            "reason": "sourceBar-pinned BAR projection is not an independent item behavior clause."
          },
          {
            "specId": "AUTO-BAR-R-8-P-008",
            "planItemId": "P-008",
            "behavior": "Each shipped final signed distributable matches the complete final artifact digest independently accepted before cutover.",
            "disposition": "excluded",
            "rating": "not-applicable",
            "reason": "sourceBar-pinned BAR projection is not an independent item behavior clause."
          },
          {
            "specId": "background-single-owner",
            "planItemId": "P-004",
            "behavior": "Each mutating authority/effect class admits committed effects only from its current fenced owner.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "candidate-readiness",
            "planItemId": "P-007",
            "behavior": "A failed, stale or unmeasured mandatory candidate leg withholds pre-cutover eligibility.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "child-selection",
            "planItemId": "P-004",
            "behavior": "Each inventoried child launch uses the interpreter declared for its process role.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "guard-preservation",
            "planItemId": "P-003",
            "behavior": "Each inventoried guarded launch rejects modules or artifacts whose bytes differ from its admitted committed identity.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "inventory-evidence",
            "planItemId": "P-001",
            "behavior": "A compatibility report admits a required capability result only when the identified interpreter completes its declared semantic operation.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "proof-separation",
            "planItemId": "P-005",
            "behavior": "A proof is reusable only for the identical source/runtime/platform/dependency/configuration identity tuple.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "rollback-data",
            "planItemId": "P-007",
            "behavior": "Each forced-rollback scenario restores its reference durable data and effect outcome within the pinned recovery budget.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "rollback-retention",
            "planItemId": "P-008",
            "behavior": "The installed compatible Node rollback closure remains launchable under a persisted seven-day minimum no-collection policy.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "runtime-gc",
            "planItemId": "P-003",
            "behavior": "The selected runtime memory-recovery boundary produces an observable supported recovery action or explicit safe escalation.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "runtime-selection",
            "planItemId": "P-002",
            "behavior": "Normal launch defaults remain pinned Node until the exact candidate receives independent pre-cutover acceptance.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          }
        ],
        "atomicityDetectorControls": [
          {
            "behavior": "The price sheet reproduces measured costs, separates platform margin and specifies an allowance.",
            "expected": "compound",
            "actual": "compound",
            "passed": true
          },
          {
            "behavior": "The customer journey satisfies the security and operating promises.",
            "expected": "compound",
            "actual": "compound",
            "passed": true
          },
          {
            "behavior": "Each original parked-agent request has exactly one evidence-based disposition and never counts queued or delivered as pickup.",
            "expected": "compound",
            "actual": "compound",
            "passed": true
          },
          {
            "behavior": "A current-build dogfood run completes the parked-agent audit through coord:roster view=audit without caller SQL and records complete coverage.",
            "expected": "compound",
            "actual": "compound",
            "passed": true
          },
          {
            "behavior": "The price sheet reproduces the measured cost for each workload case.",
            "expected": "atomic",
            "actual": "atomic",
            "passed": true
          },
          {
            "behavior": "The customer journey stops when the inference allowance is exhausted.",
            "expected": "atomic",
            "actual": "atomic",
            "passed": true
          },
          {
            "behavior": "Each original parked-agent request has exactly one evidence-based disposition.",
            "expected": "atomic",
            "actual": "atomic",
            "passed": true
          },
          {
            "behavior": "A current-build dogfood run completes the parked-agent audit through coord:roster view=audit without caller SQL.",
            "expected": "atomic",
            "actual": "atomic",
            "passed": true
          }
        ],
        "implementationIndependenceClauseDiagnostics": [
          {
            "specId": "accepted-shipment",
            "planItemId": "P-008",
            "behavior": "The shipped active runtime identity equals the independently accepted immutable candidate identity.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "artifact-runtimes",
            "planItemId": "P-006",
            "behavior": "Each supported installed artifact launches its selected pinned runtime from its own runtime closure.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "AUTO-BAR-R-1-P-001",
            "planItemId": "P-001",
            "behavior": "Each ordinary launcher keeps an operational pinned Node default until exact candidate acceptance authorizes cutover.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "AUTO-BAR-R-1-P-002",
            "planItemId": "P-002",
            "behavior": "Each ordinary launcher keeps an operational pinned Node default until exact candidate acceptance authorizes cutover.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "AUTO-BAR-R-2-P-001",
            "planItemId": "P-001",
            "behavior": "Each required capability leg in the source-derived supported-role census produces its declared semantic result under the selected pinned candidate interpreter.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "AUTO-BAR-R-2-P-003",
            "planItemId": "P-003",
            "behavior": "Each required capability leg in the source-derived supported-role census produces its declared semantic result under the selected pinned candidate interpreter.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "AUTO-BAR-R-2-P-007",
            "planItemId": "P-007",
            "behavior": "Each required capability leg in the source-derived supported-role census produces its declared semantic result under the selected pinned candidate interpreter.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "AUTO-BAR-R-3-P-003",
            "planItemId": "P-003",
            "behavior": "Each guarded launcher in the source-derived census rejects a planted uncommitted module.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "AUTO-BAR-R-3-P-004",
            "planItemId": "P-004",
            "behavior": "Each guarded launcher in the source-derived census rejects a planted uncommitted module.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "AUTO-BAR-R-4-P-005",
            "planItemId": "P-005",
            "behavior": "Proof reuse accepts only an identical source/runtime/platform/dependency/configuration fingerprint tuple.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "AUTO-BAR-R-5-P-004",
            "planItemId": "P-004",
            "behavior": "Each mutating role admits effects only from its current fenced owner.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "AUTO-BAR-R-5-P-007",
            "planItemId": "P-007",
            "behavior": "Each mutating role admits effects only from its current fenced owner.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "AUTO-BAR-R-6-P-006",
            "planItemId": "P-006",
            "behavior": "Every configured installed product/OS/architecture cell executes its selected packaged runtime offline.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "AUTO-BAR-R-6-P-007",
            "planItemId": "P-007",
            "behavior": "Every configured installed product/OS/architecture cell executes its selected packaged runtime offline.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "AUTO-BAR-R-7-P-007",
            "planItemId": "P-007",
            "behavior": "Each declared forced-rollback scenario restores its reference data/effect outcome within the declared recovery budget.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "AUTO-BAR-R-7-P-008",
            "planItemId": "P-008",
            "behavior": "Each declared forced-rollback scenario restores its reference data/effect outcome within the declared recovery budget.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "AUTO-BAR-R-8-P-008",
            "planItemId": "P-008",
            "behavior": "Each shipped final signed distributable matches the complete final artifact digest independently accepted before cutover.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "background-single-owner",
            "planItemId": "P-004",
            "behavior": "Each mutating authority/effect class admits committed effects only from its current fenced owner.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "candidate-readiness",
            "planItemId": "P-007",
            "behavior": "A failed, stale or unmeasured mandatory candidate leg withholds pre-cutover eligibility.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "child-selection",
            "planItemId": "P-004",
            "behavior": "Each inventoried child launch uses the interpreter declared for its process role.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "guard-preservation",
            "planItemId": "P-003",
            "behavior": "Each inventoried guarded launch rejects modules or artifacts whose bytes differ from its admitted committed identity.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "inventory-evidence",
            "planItemId": "P-001",
            "behavior": "A compatibility report admits a required capability result only when the identified interpreter completes its declared semantic operation.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "proof-separation",
            "planItemId": "P-005",
            "behavior": "A proof is reusable only for the identical source/runtime/platform/dependency/configuration identity tuple.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "rollback-data",
            "planItemId": "P-007",
            "behavior": "Each forced-rollback scenario restores its reference durable data and effect outcome within the pinned recovery budget.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "rollback-retention",
            "planItemId": "P-008",
            "behavior": "The installed compatible Node rollback closure remains launchable under a persisted seven-day minimum no-collection policy.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "runtime-gc",
            "planItemId": "P-003",
            "behavior": "The selected runtime memory-recovery boundary produces an observable supported recovery action or explicit safe escalation.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          },
          {
            "specId": "runtime-selection",
            "planItemId": "P-002",
            "behavior": "Normal launch defaults remain pinned Node until the exact candidate receives independent pre-cutover acceptance.",
            "disposition": "evaluated",
            "rating": "pass",
            "reason": null
          }
        ],
        "implementationIndependenceDetectorControls": [
          {
            "behavior": "The customer job completes through the existing runtime.",
            "expected": "coupled",
            "actual": "coupled",
            "passed": true
          },
          {
            "behavior": "The existing cloud subscription flow implements the approved offer.",
            "expected": "coupled",
            "actual": "coupled",
            "passed": true
          },
          {
            "behavior": "A failure produces an alarm through the existing alarm subscription mechanism.",
            "expected": "coupled",
            "actual": "coupled",
            "passed": true
          },
          {
            "behavior": "FAQ content stays synchronized through the existing source-linked maintenance pipeline.",
            "expected": "coupled",
            "actual": "coupled",
            "passed": true
          },
          {
            "behavior": "Computed tenure cards are refreshed by the existing goal scheduling path.",
            "expected": "coupled",
            "actual": "coupled",
            "passed": true
          },
          {
            "behavior": "Computed cards are produced by existing scheduling without a new scheduler.",
            "expected": "coupled",
            "actual": "coupled",
            "passed": true
          },
          {
            "behavior": "The publisher reuses the existing goal scheduling path.",
            "expected": "coupled",
            "actual": "coupled",
            "passed": true
          },
          {
            "behavior": "Computed cards are refreshed using the existing scheduled sweep.",
            "expected": "coupled",
            "actual": "coupled",
            "passed": true
          },
          {
            "behavior": "Computed cards are refreshed by the existing runtime.",
            "expected": "coupled",
            "actual": "coupled",
            "passed": true
          },
          {
            "behavior": "Reuse the runtime usage ledger for per-call token counts.",
            "expected": "coupled",
            "actual": "coupled",
            "passed": true
          },
          {
            "behavior": "Reuse PostHog for consented portal events.",
            "expected": "coupled",
            "actual": "coupled",
            "passed": true
          },
          {
            "behavior": "Reuse prior clean receipts when current; reuse PostHog for consented portal events.",
            "expected": "coupled",
            "actual": "coupled",
            "passed": true
          },
          {
            "behavior": "The private field condition_key retains episode coalescing.",
            "expected": "coupled",
            "actual": "coupled",
            "passed": true
          },
          {
            "behavior": "runSyncBatchDeltaCheck evaluates the batch under sustained load.",
            "expected": "coupled",
            "actual": "coupled",
            "passed": true
          },
          {
            "behavior": "A clickable block has no clip in src/cup-audio/.",
            "expected": "coupled",
            "actual": "coupled",
            "passed": true
          },
          {
            "behavior": "Wording from tests/fixtures/cupboard-brief.json appears outside a label.",
            "expected": "coupled",
            "actual": "coupled",
            "passed": true
          },
          {
            "behavior": "The built out/*/index.html leaves a placeholder behind.",
            "expected": "coupled",
            "actual": "coupled",
            "passed": true
          },
          {
            "behavior": "Readers see correlation between `test/run/case`, invocation/workflow and trace/span.",
            "expected": "coupled",
            "actual": "coupled",
            "passed": true
          },
          {
            "behavior": "Readers see correlation between test/run/case, invocation/workflow and trace/span.",
            "expected": "independent",
            "actual": "independent",
            "passed": true
          },
          {
            "behavior": "An existing customer sees their subscription after signing in.",
            "expected": "independent",
            "actual": "independent",
            "passed": true
          },
          {
            "behavior": "GET /architecture/index.html returns 200 with the map.",
            "expected": "independent",
            "actual": "independent",
            "passed": true
          },
          {
            "behavior": "A visitor who opts out/in keeps that choice after a reload.",
            "expected": "independent",
            "actual": "independent",
            "passed": true
          },
          {
            "behavior": "The customer reuses an existing account when accepting an invitation.",
            "expected": "independent",
            "actual": "independent",
            "passed": true
          },
          {
            "behavior": "A change is requested by the existing customer.",
            "expected": "independent",
            "actual": "independent",
            "passed": true
          },
          {
            "behavior": "An invitation is accepted by the existing account holder.",
            "expected": "independent",
            "actual": "independent",
            "passed": true
          },
          {
            "behavior": "Reuse of an expired invitation is refused.",
            "expected": "independent",
            "actual": "independent",
            "passed": true
          },
          {
            "behavior": "Reuse prior clean receipts when current; do not recreate proof just for recovery.",
            "expected": "independent",
            "actual": "independent",
            "passed": true
          }
        ],
        "exemptSourceBarProjectionMismatches": [],
        "prerequisiteRuntimeBarMismatches": []
      },
      "scorecardDraft": {
        "rubricRef": "spec-quality",
        "subject": {
          "kind": "plan",
          "ref": "spec-set:plan-class-migration:57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186:3bf31049db04120e"
        },
        "title": "node-to-bun-staged-migration-2026-10-22 spec quality (plan-class-migration)",
        "body": "Plan node-to-bun-staged-migration-2026-10-22; class plan-class-migration; exact current specSetHash 57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186; 27 current clause(s), 8 plan item(s).",
        "ratings": {
          "stable-revision-identity": {
            "rating": "pass",
            "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"stable-revision-identity\"]. 27 current clause(s) have unique identities, content hashes, and acceptance provenance. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"af2aa1ded67bf168291f875b5ba74bceda3bafa932fab2f8d52ea67ed424975f\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
          },
          "item-contract-coverage": {
            "rating": "pass",
            "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"item-contract-coverage\"]. All 8 plan item(s) are covered by active item clauses or explicit exemptions. 15 sourceBar-pinned projection(s) are excluded as copies of canonical acceptance BARs; added or meaning-changed BAR projections are checked on rubric writes, while unchanged legacy BARs are not re-certified here. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"af2aa1ded67bf168291f875b5ba74bceda3bafa932fab2f8d52ea67ed424975f\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
          },
          "atomic-observable-behavior": {
            "rating": "pass",
            "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"atomic-observable-behavior\"]. 12 independent item behavior clause(s) passed the supported structural atomicity checks. 15 sourceBar-pinned projection(s) are excluded as copies of canonical acceptance BARs; added or meaning-changed BAR projections are checked on rubric writes, while unchanged legacy BARs are not re-certified here. Coverage: 12 of 27 active behavioral clause(s) evaluated; 15 active sourceBar-pinned BAR projection(s) excluded (new or meaning-changed canonical BAR projections are checked on rubric writes; unchanged legacy BARs are not re-certified here); per-clause dispositions are in details.atomicityClauseDiagnostics. Detector controls: 4/4 compound counterexamples rejected; 4/4 single-outcome controls accepted; see details.atomicityDetectorControls. Coverage is structural pattern detection, not a proof of arbitrary natural-language semantics. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"af2aa1ded67bf168291f875b5ba74bceda3bafa932fab2f8d52ea67ed424975f\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
          },
          "falsifiability": {
            "rating": "pass",
            "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"falsifiability\"]. 12 independent item behavior clause(s) state falsifiable outcomes. 15 sourceBar-pinned projection(s) are excluded as copies of canonical acceptance BARs; added or meaning-changed BAR projections are checked on rubric writes, while unchanged legacy BARs are not re-certified here. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"af2aa1ded67bf168291f875b5ba74bceda3bafa932fab2f8d52ea67ed424975f\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
          },
          "implementation-independence": {
            "rating": "pass",
            "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"implementation-independence\"]. No active/accepted behavior clause is coupled to an implementation detail covered by the detector. Fields inspected per clause: behavior and falsifier.observation (falsifier.probeMethod is excluded because it legitimately names the test or probe). Detector coverage: implementation filenames, explicitly qualified/quoted construct symbols (including snake_case identifiers), bare lowerCamel identifiers (excluding recognized public platform/device names), repository paths, internal route literals, named operations, mandated reuse of existing surfaces (including runtimes, flows, pipelines, ledgers, mechanisms, scheduling paths and sweeps, including passive by prescriptions), imperative implementation selection, filesystem permission modes, named storage backends, encryption, and mirroring. Inspected 27 active/accepted behavior clause(s), including 15 sourceBar-pinned acceptance BAR projection(s). 0 draft/exempt clause(s) excluded; per-clause dispositions are in details.implementationIndependenceClauseDiagnostics. Detector controls: see details.implementationIndependenceDetectorControls for coupled counterexamples and independent observable outcomes. Coverage is structural pattern detection, not a proof of arbitrary natural-language semantics. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"af2aa1ded67bf168291f875b5ba74bceda3bafa932fab2f8d52ea67ed424975f\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
          },
          "explicit-non-behavioral-exemptions": {
            "rating": "not-applicable",
            "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"explicit-non-behavioral-exemptions\"]. Exact clause scope 57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186 contains 27 current row(s); 0 exempt ([]), 0 valid and 0 invalid; invalid ids=[]; row census SHA-256=61ec474af71f2ff1125ae7427795e056255753fd4f6e7a379852757dfa8cb59a. Replay this exact snapshot and compare details.exemptionCensus.rows. No clause claims a non-behavioral exemption. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"af2aa1ded67bf168291f875b5ba74bceda3bafa932fab2f8d52ea67ed424975f\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
          },
          "plan-class-specialization": {
            "rating": "pass",
            "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"plan-class-specialization\"]. Migration plan includes an active migration-data-integrity contract. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"af2aa1ded67bf168291f875b5ba74bceda3bafa932fab2f8d52ea67ed424975f\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
          },
          "spec-set-freshness": {
            "rating": "pass",
            "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"spec-set-freshness\"]. Verdict is pinned to exact current specSetHash 57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186 over 27 clause(s). Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"af2aa1ded67bf168291f875b5ba74bceda3bafa932fab2f8d52ea67ed424975f\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
          }
        },
        "terminal": true
      }
    },
    "emissionDisposition": "NOT EMITTED. Current staging result lacks evaluatorBuild/specSetHashVersion and explicit scorecardDraft.rerunRecipe; wait for maintained guarded evaluator and re-evaluate rather than fabricating recipe fields."
  },
  "runtimeSnapshot": {
    "observedAt": "2026-11-06T05:15Z",
    "directNative": "exact d8d0 pass; replay/build/version fields absent",
    "staging3170": "exact 57eb pass with immutable replaySnapshot, explicit draft recipe/build/version absent",
    "pipeline": "At read, source identity repair committed on staging but not loaded in release d740fc3802 or staging2f719c3d04; active managed staging-sync observed05:21Z, started05:13:57Z. No restart or gate operation performed."
  },
  "authority": "D019 remains terminal NO_START. No old draft reemission, selfaudit, native diagnostic, lease, dependency generation read, VM, extra implementation agent, source edit or test. Canonical independent audit and distinct coordinator successor/current activation audit/start still required."
}
