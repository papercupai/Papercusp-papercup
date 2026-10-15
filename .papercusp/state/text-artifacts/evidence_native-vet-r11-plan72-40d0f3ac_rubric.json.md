---
rel_path: "evidence/native-vet-r11-plan72-40d0f3ac/rubric.json"
updated_at: 1791997967599
_body: "content"
---

{
  "rubricId": "acceptance-native-code-intelligence-ecosystem-and-dream-2026-10-09",
  "revision": 11,
  "workspaceId": "papercusp-workspace",
  "kind": "acceptance",
  "subjectPlan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
  "subjectHarnessSlug": "papercusp",
  "classRef": "plan-class-feature-ship",
  "barSetHash": "730e4b5fd8c4da6ba577f8ccc5414c8a23fe1348562f7d0972f7f995f768de5b",
  "barContract": {
    "schemaVersion": 1,
    "adoptionEpoch": 1,
    "cohort": "post-epoch",
    "subjectPlanRevision": 72,
    "seededAt": "2026-10-14T08:24:47.882Z",
    "seededBy": "su-87f0aa6a-d766-4913-80fc-4c9014971d9a",
    "meaningRevision": 11
  },
  "characteristic": "native-code-intelligence-shipment",
  "title": "Acceptance: native code intelligence, ecosystem workflows and Dream",
  "description": "Initial class declaration for the owner-approved feature roadmap. The 29 predeclared Requirements/BAR outcomes will be seeded by the activation audit; this class-only proposal is not acceptance of implementation or a substitute for their future evidence.",
  "criteria": [
    {
      "key": "r-1",
      "title": "Licence-safe dependencies",
      "intent": {
        "request": "Licence-safe dependencies in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:1",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:26"
        ]
      },
      "model": "Shipped distributions contain no GitNexus code or automatic GitNexus download dependency.",
      "bar": "Shipped distributions contain no GitNexus code or automatic GitNexus download dependency.",
      "barKey": "R-1",
      "barHash": "7cfda6bda09921b164f2fcb31eaf2dda89960e93070b2109a56a757f023a9bf2",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-027"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "P-027 verifies the final distribution artifact against licence exclusions. P-001 supplies the source-pinned inventory and admission decision register as a prerequisite; that baseline is verified by its own spec and is not a distribution verdict. Retain unit and integration proof at the exact final artifact.",
      "driftMarkers": "A public or installer build downloads or packages GitNexus without an admitted commercial licence.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-2",
      "title": "Honest multilingual coverage",
      "intent": {
        "request": "Honest multilingual coverage in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:12"
        ]
      },
      "model": "An uncertified language-intent pair returns an explicit unsupported result.",
      "bar": "An uncertified language-intent pair returns an explicit unsupported result.",
      "barKey": "R-2",
      "barHash": "ae49a0f8c8315228c2caf3465ffe3b59afa0377b2ec4993e10b5597a0858dfe4",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-004",
        "P-005",
        "P-026"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-004, P-005, P-026 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "An unsupported Python/Rust/Go/C++ operation reports a trustworthy empty result.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-3",
      "title": "Attributable graph answers",
      "intent": {
        "request": "Attributable graph answers in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:6",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:18"
        ]
      },
      "model": "Each graph answer identifies the source scope from which its sites were derived.",
      "bar": "Each graph answer identifies the source scope from which its sites were derived.",
      "barKey": "R-3",
      "barHash": "ad880873867470280fd9076546e02d949c54bc682c07441037b7a3921680337d",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-007",
        "P-017"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "P-007 and P-017 verify the final attributable graph answers against exact changed source with unit and integration evidence. P-003 supplies the prerequisite source-evidence contract and tests measured identities, retained snapshot hashes, race rejection and explicit unknown legacy versions through SPEC-NATIVE-P-003. Preserve the unchanged final condition and per-edge repository/content-version falsifier.",
      "driftMarkers": "An answer contains an edge whose repository or content version cannot be determined.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-4",
      "title": "Cache invalidation",
      "intent": {
        "request": "Cache invalidation in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:12",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:14"
        ]
      },
      "model": "A source change invalidates the affected cached graph evidence.",
      "bar": "A source change invalidates the affected cached graph evidence.",
      "barKey": "R-4",
      "barHash": "291817cb556827927c42efe5738c554ed0039c4d626236f88e06eae6dbe0f4ae",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-006",
        "P-026"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-006, P-026 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "A query returns pre-edit dependencies as current after an edit or delete.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-5",
      "title": "Exposed graph parity",
      "intent": {
        "request": "Exposed graph parity in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:10",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:14"
        ]
      },
      "model": "Each admitted graph operation passes its preregistered source-site fixtures through the exposed tool handler.",
      "bar": "Each admitted graph operation passes its preregistered source-site fixtures through the exposed tool handler.",
      "barKey": "R-5",
      "barHash": "2f4eacc0527b6306724fd6fc079270a7cff8b54cdf86c4304fdaf7888d7878fa",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-007",
        "P-008",
        "P-026"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-007, P-008, P-026 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "The benchmark adapter passes while the actual graph:query handler returns a missing or incorrect site.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-6",
      "title": "Directed tracing",
      "intent": {
        "request": "Directed tracing in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:10",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:14"
        ]
      },
      "model": "A trace query returns the expected bounded directed path on the reference fixture.",
      "bar": "A trace query returns the expected bounded directed path on the reference fixture.",
      "barKey": "R-6",
      "barHash": "8c87c140c915156354bc6c76a352594879993d44ae3be448ecd657e642c92167",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-008",
        "P-026"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-008, P-026 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "A reverse path or an extra unsubstantiated hop is presented as the requested path.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-7",
      "title": "Fair comparison",
      "intent": {
        "request": "Fair comparison in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:6",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:12"
        ]
      },
      "model": "The backend verdict is reproducible from preregistered matched-operation evidence.",
      "bar": "The backend verdict is reproducible from preregistered matched-operation evidence.",
      "barKey": "R-7",
      "barHash": "d702c9516c197c7fd243cf3890af2d6101777c961250a4f396903f05c6226673",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-026"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "P-026 reconstructs the final backend verdict from saved matched-operation corpus, frozen question semantics and budgets, declared arms and scoring rules. P-002 supplies and tests preregistration as a prerequisite; its freeze/rejection behavior is verified by SPEC-NATIVE-P-002. The final reproducibility condition remains mandatory with unit/integration tree proof.",
      "driftMarkers": "The verdict changes when reconstructed from the saved corpus and scoring rules.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-8",
      "title": "Conservative test selection",
      "intent": {
        "request": "Conservative test selection in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:18",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:24"
        ]
      },
      "model": "Graph-based test selection preserves the baseline selected set.",
      "bar": "Graph-based test selection preserves the baseline selected set.",
      "barKey": "R-8",
      "barHash": "56cf322409e106f15e1445f943a79f0ed807faf8d76779042b81954affbd4d1d",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-009",
        "P-011",
        "P-026"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-009, P-011, P-026 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "A graph-suggested run omits any test selected by the baseline.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-9",
      "title": "Explain a change",
      "intent": {
        "request": "Explain a change in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:18",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:24"
        ]
      },
      "model": "The change report identifies reference-fixture consumers of the edited symbol.",
      "bar": "The change report identifies reference-fixture consumers of the edited symbol.",
      "barKey": "R-9",
      "barHash": "2fc7d7e10ac08d947f32a7d584820932f40a0944dba73254edc6da57e70ba409",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-010",
        "P-026"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "e2e",
        "integration"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-010, P-026 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "A known affected consumer is omitted without an explicit coverage limitation.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.e2e.test.ts"
        ]
      }
    },
    {
      "key": "r-10",
      "title": "Task-scoped context",
      "intent": {
        "request": "Task-scoped context in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:18",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:24"
        ]
      },
      "model": "A claim-time brief contains only evidence attributable to the claimed task scope.",
      "bar": "A claim-time brief contains only evidence attributable to the claimed task scope.",
      "barKey": "R-10",
      "barHash": "5640460b638376920a704528eb802e7fe9f16b491e7ff1bb58b29940d156d769",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-012",
        "P-021",
        "P-026"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "e2e",
        "integration"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-012, P-021, P-026 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "A brief includes inaccessible repository evidence or stale content labelled current.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.e2e.test.ts"
        ]
      }
    },
    {
      "key": "r-11",
      "title": "Coordination authority",
      "intent": {
        "request": "Coordination authority in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:18",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:24"
        ]
      },
      "model": "A graph overlap advisory leaves authoritative assignments unchanged.",
      "bar": "A graph overlap advisory leaves authoritative assignments unchanged.",
      "barKey": "R-11",
      "barHash": "1a53977ae8a83dd51f050d9ef758f8416608bce4d332366dc5e968cf128a8906",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-013",
        "P-026"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-013, P-026 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "Viewing an overlap advisory takes over a peer work-item or bypasses a file lock.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-12",
      "title": "Interface impact",
      "intent": {
        "request": "Interface impact in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:10",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:14",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:18",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:24"
        ]
      },
      "model": "An interface-change report identifies the reference-fixture client mismatch.",
      "bar": "An interface-change report identifies the reference-fixture client mismatch.",
      "barKey": "R-12",
      "barHash": "6495fc3cfa0575751ec1121f731e81a1703fc225c729a05b8cb68db851cbcacb",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-014",
        "P-019",
        "P-026"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "e2e",
        "integration"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-014, P-019, P-026 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "A changed response field is accepted without exposing its incompatible known consumer.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.e2e.test.ts"
        ]
      }
    },
    {
      "key": "r-13",
      "title": "Evidence freshness",
      "intent": {
        "request": "Evidence freshness in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:18",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:24"
        ]
      },
      "model": "A changed evidence source prevents its prior proof from being treated as current.",
      "bar": "A changed evidence source prevents its prior proof from being treated as current.",
      "barKey": "R-13",
      "barHash": "9a10d4f51a046861662a6a00a73b86a7570aba4f8fbec066e2cd8648e450c751",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-015",
        "P-026"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-015, P-026 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "A prior passing evidence binding remains current after the source fingerprint changes.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-14",
      "title": "Documentation drift",
      "intent": {
        "request": "Documentation drift in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:18",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:24"
        ]
      },
      "model": "A changed documented interface creates a source-linked documentation update candidate.",
      "bar": "A changed documented interface creates a source-linked documentation update candidate.",
      "barKey": "R-14",
      "barHash": "6e482ce912950d09bbbd34b504fbbcf95d03499ac67e696e06ec8a6ba4e87e73",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-016",
        "P-029"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-016, P-029 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "A renamed documented symbol remains presented as current without a drift candidate.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-15",
      "title": "Runtime provenance",
      "intent": {
        "request": "Runtime provenance in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:18",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:24"
        ]
      },
      "model": "A runtime-specific answer identifies the artifact loaded by the selected current-build runtime and distinguishes it from the edited source tree.",
      "bar": "A runtime-specific answer identifies the artifact loaded by the selected current-build runtime and distinguishes it from the edited source tree.",
      "barKey": "R-15",
      "barHash": "b06b4e041e512316079d76a577da1dd5d6fc2528b6747ca9be5594fbc402591d",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-017",
        "P-026",
        "P-027"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "e2e",
        "integration"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run runtime-provenance integration and e2e fixtures for P-017 and P-026 on the selected current-build runtime; bind loaded-artifact and source fingerprints. Verify exact final release provenance separately under R-24/P-027 at shipment.",
      "driftMarkers": "A staging-only source change is reported as loaded on the final release runtime.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.e2e.test.ts"
        ]
      }
    },
    {
      "key": "r-16",
      "title": "Evidence-based diagnosis",
      "intent": {
        "request": "Evidence-based diagnosis in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:18",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:24"
        ]
      },
      "model": "An incident brief labels a static graph path as a hypothesis until distinguishing runtime evidence supports it.",
      "bar": "An incident brief labels a static graph path as a hypothesis until distinguishing runtime evidence supports it.",
      "barKey": "R-16",
      "barHash": "5a16308e1c2bfdfba4eaed264ceee8743547056a3b0a6f175ae5735271ffe8d8",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-018",
        "P-026"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "e2e",
        "integration"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-018, P-026 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "The brief asserts causation from graph connectivity alone.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.e2e.test.ts"
        ]
      }
    },
    {
      "key": "r-17",
      "title": "Cross-repository scope",
      "intent": {
        "request": "Cross-repository scope in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:12",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:18",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:24"
        ]
      },
      "model": "A cross-repository relationship query respects the registered workspace scope.",
      "bar": "A cross-repository relationship query respects the registered workspace scope.",
      "barKey": "R-17",
      "barHash": "519eaf9a6dd78f9df68a395be3a0f3600be81466dcebfd93bf2c2433260812f1",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-019",
        "P-026"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-019, P-026 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "A query returns relationship evidence from a repository outside the caller's allowed scope.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-18",
      "title": "Architecture discovery",
      "intent": {
        "request": "Architecture discovery in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:10",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:14"
        ]
      },
      "model": "A concept-search result is labelled as retrieval evidence rather than compiler truth.",
      "bar": "A concept-search result is labelled as retrieval evidence rather than compiler truth.",
      "barKey": "R-18",
      "barHash": "8a5fff0a49bc26de036cbfcbb23219447ad489eaebc0404be17d7dcb3f874fc7",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-020",
        "P-026"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-020, P-026 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "A semantic/cluster result claims an authoritative dependency without source corroboration.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-19",
      "title": "Bounded context",
      "intent": {
        "request": "Bounded context in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:12",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:18"
        ]
      },
      "model": "An evidence bundle exposes its omitted detail through a stable expansion reference.",
      "bar": "An evidence bundle exposes its omitted detail through a stable expansion reference.",
      "barKey": "R-19",
      "barHash": "8e0cf5468f3815c1b858dd4d82fc2aa26bff16ffbb5e109d32f56412bde10b4a",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-021",
        "P-026"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-021, P-026 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "A capped bundle silently presents its retained subset as complete.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-20",
      "title": "Dream source grounding",
      "intent": {
        "request": "Dream source grounding in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:20"
        ]
      },
      "model": "A graph-enriched Dream packet passes current-source verification.",
      "bar": "A graph-enriched Dream packet passes current-source verification.",
      "barKey": "R-20",
      "barHash": "d3ae3abab1f8e7fbebf25f032501a48eddd495e2697573a60318b6b3f6246f15",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-022",
        "P-025"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-022, P-025 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "An enriched packet remains eligible after a cited source hash changes.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-21",
      "title": "Dream candidate provenance",
      "intent": {
        "request": "Dream candidate provenance in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:20"
        ]
      },
      "model": "A graph-proposed sampler relation is bound to both capability source versions.",
      "bar": "A graph-proposed sampler relation is bound to both capability source versions.",
      "barKey": "R-21",
      "barHash": "a8265bb9c8acef010dd9549f765cf72c630cb76d0cc027c2fa94777ee4c469e2",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-023",
        "P-025"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-023, P-025 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "A relation from an old capability version enters the current structural sample.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-22",
      "title": "Dream prior-art review",
      "intent": {
        "request": "Dream prior-art review in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:20"
        ]
      },
      "model": "A proposal matching the existing integration fixture is classified as duplicate or refinement.",
      "bar": "A proposal matching the existing integration fixture is classified as duplicate or refinement.",
      "barKey": "R-22",
      "barHash": "4670105abc37461212103e7d35724ac251dee2d23d6a51f9d21a9b0e8e4a1573",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-024",
        "P-025"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-024, P-025 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "The same proposal is accepted as a verified novel integration.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-23",
      "title": "Dream useful outcomes",
      "intent": {
        "request": "Dream useful outcomes in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:20"
        ]
      },
      "model": "The matched Dream study records independently assessed useful outcomes against its frozen budget.",
      "bar": "The matched Dream study records independently assessed useful outcomes against its frozen budget.",
      "barKey": "R-23",
      "barHash": "38b43be06da19fa9a2863e6d54a2bc160f429f1b198caca8197e6ad173f32efd",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-025"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-025 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "The study reports success using only proposal volume or reviewer acceptance.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-24",
      "title": "Measured GitNexus disposition",
      "intent": {
        "request": "Measured GitNexus disposition in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:1",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:6",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:26"
        ]
      },
      "model": "The retirement decision accounts for each inventoried GitNexus consumer.",
      "bar": "The retirement decision accounts for each inventoried GitNexus consumer.",
      "barKey": "R-24",
      "barHash": "f5ab09eb9d92f200ca19b3308d5a7aeddd6a84fe29af30eb3440f28005320f5e",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-027"
      ],
      "evidencePlane": "deployed",
      "evidenceRuntime": "release-operator",
      "requiredTestLayers": [
        "e2e",
        "integration"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "P-027 verifies the final deployed GitNexus disposition against every consumer inventoried by P-001 and replacement proof produced by P-009/P-026. Baseline and replacement items supply prerequisite evidence; only the final handover can discharge this deployed integration/e2e outcome.",
      "driftMarkers": "A retained consumer loses its backend during retirement without an approved disposition.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.e2e.test.ts"
        ]
      }
    },
    {
      "key": "r-25",
      "title": "Graph visualization evaluation",
      "intent": {
        "request": "Optional graph visualization in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:10",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:14",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:26"
        ]
      },
      "model": "A graph UI inspection reveals the source provenance of the selected edge.",
      "bar": "A graph UI inspection reveals the source provenance of the selected edge.",
      "barKey": "R-25",
      "barHash": "62d2576ea76c3094f6084ca50c32edf340f95832604cd74b2e09376596d66b71",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-028"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "e2e"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-028 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "An edge is shown without its source scope or uncertainty.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.e2e.test.ts"
        ]
      }
    },
    {
      "key": "r-26",
      "title": "Architecture document evaluation",
      "intent": {
        "request": "Optional architecture documents in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:10",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:14",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:26"
        ]
      },
      "model": "A generated architecture statement cites its supporting current source.",
      "bar": "A generated architecture statement cites its supporting current source.",
      "barKey": "R-26",
      "barHash": "2cd6a47ced7474c632be7bce507777e9afb9b64f01badfa01147bd540a415835",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-029"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-029 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "A generated wiki asserts an uncited code relationship.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-27",
      "title": "Bounded expert query evaluation",
      "intent": {
        "request": "Optional expert queries in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:10",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:14",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:26"
        ]
      },
      "model": "An expert graph query terminates at the configured traversal budget.",
      "bar": "An expert graph query terminates at the configured traversal budget.",
      "barKey": "R-27",
      "barHash": "ef62768eb7655518f72d90b69e611cb7c367b94d86d4e9690950b142be63d786",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-030"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-030 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.\n\nReuse graph:query trace/impact instead of creating an arbitrary graph language. Detector controls are first-party-traversal.test.ts \"terminates cyclic traversal at max_depth\", \"bounds multiple paths and explicitly reports the omitted path\", and \"bounds call sites without inventing a partial successful path\", plus first-party-traversal.integration.test.ts \"terminates a cycle at the requested depth and exposes a path only within that bound\" through the actual exposed worker.",
      "driftMarkers": "A cyclic or wide query exceeds its registered scope or traversal bound.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.test.ts",
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts",
          "packages/operator-core/lib/code-intelligence/first-party-traversal.test.ts",
          "packages/operator-core/lib/code-intelligence/first-party-traversal.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-28",
      "title": "Dependence/security evaluation",
      "intent": {
        "request": "Optional dependence/security in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:10",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:14",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:26"
        ]
      },
      "model": "A security-analysis claim passes the admitted positive/negative reference cases.",
      "bar": "A security-analysis claim passes the admitted positive/negative reference cases.",
      "barKey": "R-28",
      "barHash": "b85e87d670f509baf11555286d890007c58ac19a6f6d9ef89e27d5d4fe65d8ec",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-031"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-031 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "A taint finding is promoted as verified solely because a call graph contains a path.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-29",
      "title": "Unreached-code evaluation",
      "intent": {
        "request": "Optional apparent dead code in the native code-intelligence roadmap",
        "constraints": [
          "Agent-derived implementation detail under Avi's approved AUTO/self execution recorded in D-003.",
          "Reuse the existing platform surface and preserve explicit uncertainty."
        ],
        "sourceRefs": [
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:10",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:12",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:14",
          "session_turn:codex:01a11e0e-d352-75f3-a157-2ed8aa1f62a2:26"
        ]
      },
      "model": "An apparently-unreached result discloses dynamic-entry uncertainty.",
      "bar": "An apparently-unreached result discloses dynamic-entry uncertainty.",
      "barKey": "R-29",
      "barHash": "d0ab31e1726f391f9a2b95592363d095b071ab0c9d7fcc1df91606cd9e7bca93",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-032"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-09T17:46:11.714Z",
        "declaredBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b"
      },
      "method": "Run the canonical tests and acceptance fixtures owned by P-032 against the exact changed source; bind recorded results and fingerprints at the selected evidence plane. Review the stated counterexample before grading.",
      "driftMarkers": "A fixture with a dynamic public entry point is labelled safely removable.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/code-intelligence/native-ecosystem.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-30",
      "title": "Measured native use",
      "intent": {
        "request": "Measure the use of native code intelligence",
        "constraints": [
          "Owner directive #1853 (Avi, 2026-10-14) recorded in D-009.",
          "Reuse the existing invocation ledger, activity record and rubric machinery; state what the instrument cannot observe."
        ],
        "sourceRefs": [
          "turn:54f63cd0@2026-10-14T06:03:28.626Z"
        ]
      },
      "model": "A scheduled rubric check reports native code-intelligence adoption from the deployed operator's ledgers.",
      "bar": "A scheduled rubric check reports native code-intelligence adoption from the deployed operator's ledgers.",
      "barKey": "R-30",
      "barHash": "8a30bb5a5bfe484117e818011eecaa894dde115c877a285e70342803726940d3",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-033"
      ],
      "evidencePlane": "deployed",
      "evidenceRuntime": "release-operator",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "legacy-backfilled",
        "declaredAt": "2026-10-09T22:30:56.861Z",
        "declaredBy": "su-87f0aa6a-d766-4913-80fc-4c9014971d9a"
      },
      "method": "Run the code-intel:native-adoption-measured instrument (packages/operator-core/lib/code-intelligence/native-adoption.ts) via scorecards:emit fromLedger on the deployed operator and confirm the scheduled rubric-rescore produced it; native-adoption.test.ts and native-adoption.integration.test.ts cover per-operation volume, reach, failure classes, follow-through and substitutable raw-text lookups. The check binds the deployed instrument rather than the test files because the bar is a deployed-ledger outcome; native-adoption.test.ts and native-adoption.integration.test.ts remain its required unit/integration layers.\n\nDetector verification uses packages/operator-core/lib/code-intelligence/native-adoption.integration.test.ts assertions \"measureNativeAdoptionWindow → ratings (R-30 / R-31)\" and \"rates unknown (not pass) when the subject window is still open\", plus packages/operator-core/lib/check-results-ledger.integration.test.ts assertion \"scheduled adoption measures the real activity ledger, records regression, and grades from the stored result\". These integration layers verify the detector; outcome PASS requires code-intel:native-adoption-measured reading the deployed release-operator ledgers, with the serving /api/health SHA recorded. Tests alone do not establish this deployed outcome.\n\nThe instrument must report NATIVE_ADOPTION_CANNOT_OBSERVE on every measurement; native-adoption.integration.test.ts \"reports observability limits on every real-ledger measurement, including an empty window\" exercises both populated and empty ledgers. Its scope is the reported invocation and native-command ledgers, with the listed visibility limits.",
      "driftMarkers": "BROKEN if any one: no scheduled code-intel:native-adoption-measured rescore result is recorded from the deployed release-operator ledgers; its evidence lacks the serving /api/health SHA or uses a non-release ledger; a still-open subject window rates pass rather than unknown; a declared per-operation volume, agent reach, failure-class, follow-through or substitutable raw-text dimension is absent; the result omits what the instrument cannot observe.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "code-intel:native-adoption-measured"
      }
    },
    {
      "key": "r-31",
      "title": "Good native use",
      "intent": {
        "request": "Make sure the native code-intelligence system gets good use",
        "constraints": [
          "Owner directive #1853 (Avi, 2026-10-14) recorded in D-009.",
          "The adoption target is frozen from P-033's baseline window before interventions; never an invented number."
        ],
        "sourceRefs": [
          "turn:54f63cd0@2026-10-14T06:03:28.626Z"
        ]
      },
      "model": "Post-intervention native code-intelligence adoption meets D-011's frozen target.",
      "bar": "Post-intervention native code-intelligence adoption meets D-011's frozen target.",
      "barKey": "R-31",
      "barHash": "188a9b82590c4b84c044e7645898b667705946f3be832a8c007e029288c1bd0f",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "P-033"
      ],
      "evidencePlane": "deployed",
      "evidenceRuntime": "release-operator",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "pass"
      ],
      "barProvenance": {
        "lifecycle": "legacy-backfilled",
        "declaredAt": "2026-10-09T22:30:56.861Z",
        "declaredBy": "su-87f0aa6a-d766-4913-80fc-4c9014971d9a"
      },
      "method": "Compare the frozen baseline window (D-011) with a post-intervention window of equal length on the deployed operator using the code-intel:native-adoption-good-use instrument; report negative or inconclusive results rather than adjusting the target. The check binds the deployed instrument rather than the test files because the bar is a deployed-ledger outcome; native-adoption.test.ts and native-adoption.integration.test.ts remain its required unit/integration layers.\n\nThe exact D-011 comparison remains a frozen 72-hour baseline and an equal post-intervention window, beginning only once the intervention is verified deployed. Detector falsifiers are packages/operator-core/lib/code-intelligence/native-adoption.test.ts \"frozen R-31 target (plan D-011)\", unknown until frozen, and inconclusive below the sample floor; native-adoption.integration.test.ts \"rates unknown (not pass) when the subject window is still open\" guards an unfinished window. These tests verify the detector; outcome PASS requires code-intel:native-adoption-good-use on the deployed release-operator ledgers meeting every unchanged frozen bound.\n\nRATING BASIS: record the release-operator serving /api/health SHA at the exact post-intervention window start, containing deployed-build evidence for each P-033 intervention path, and windowEnd at least windowStart plus 72 hours. Missing serving/intervention/window evidence rates unknown. A runtime start-after-mtime heuristic alone does not prove the code executed.",
      "driftMarkers": "BROKEN if any one: the post window misses a D-011 bound (agentAdoptionRate < 0.12, nativeCallShare < 0.14, or refusalRate > 0.088); the post window is shorter than 72 hours or begins before interventions are verified serving on the deployed release operator; any D-011 baseline, bound or derivation rule differs from the decision; a window below 464 lookups rates anything but unknown, or a bound miss is reported as anything but fail.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "code-intel:native-adoption-good-use"
      }
    }
  ],
  "ratingScale": [
    "pass",
    "fail",
    "unknown"
  ],
  "criteriaHash": "40d0f3ac45bb1a1de010269febea7bd0ed920b823a0776daa8b9aa7906bcd7d4",
  "methodRef": null,
  "gradingAuthority": "independent",
  "status": "active",
  "createdBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b",
  "proposedBy": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b",
  "ratifiedBy": null,
  "createdAt": "2026-10-09",
  "updatedAt": "2026-10-14T16:42:35.890Z"
}
