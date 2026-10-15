---
rel_path: "acceptance/open-source-release-2026-09-29/rev4-amend-1156957.json"
updated_at: 1791011724039
_body: "content"
---

{
  "rubricRef": "acceptance-open-source-release-2026-09-29",
  "criteria": [
    {
      "key": "r-1",
      "title": "Every open question has a decision",
      "intent": {
        "request": "Owner decides license, CLA, closed set, trademark, repo name and preview sequencing.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #916",
          "D-003",
          "D-004"
        ]
      },
      "model": "The plan records a decision for every P-001 open question.",
      "barKey": "R-1",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "method": "Read the plan Decisions against the Open questions list.",
      "driftMarkers": "A P-001 open question has no recorded decision.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-2",
      "title": "Public builds use the user's own Anthropic auth",
      "intent": {
        "request": "Anthropic terms compliance before public release.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #932",
          "D-005",
          "D-014"
        ]
      },
      "model": "A public build authenticates to Anthropic only with credentials the user supplies.",
      "barKey": "R-2",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "method": "Run anthropic-auth-policy.test.ts and inference-gateway/spawn-env.test.ts: public subscription relays and gateway reinjection are withheld, exact own-account opt-in and dogfood controls still work. These guards cover routing policy, not finished-build behavior. At the published public build, verify its baked public profile, user-supplied API key/unmodified CLI sign-in behavior, and a complete credential-free final-cut scan; retain actual live evidence. Service-owned hosted subscriptions are separately graded under R-24.",
      "driftMarkers": "A public build ships an Anthropic credential or routes the user through a shared account.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/anthropic-auth-policy.test.ts",
          "packages/operator-core/lib/inference-gateway/spawn-env.test.ts"
        ]
      },
      "requiredTestLayers": [
        "unit"
      ]
    },
    {
      "key": "r-3",
      "title": "The license gate blocks disallowed dependencies",
      "intent": {
        "request": "Replace the quick license audit with tooling.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #927",
          "owner:Avi 2026-09-29 #931",
          "D-001",
          "D-002"
        ]
      },
      "model": "The dependency license gate fails when a lockfile resolves a disallowed license.",
      "barKey": "R-3",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "unit"
      ],
      "passRatings": [
        "healthy"
      ],
      "method": "Run license-gate.test.ts, including real main() invocations over temporary lockfile fixtures: strict GPL must return 1/status=fail; measured MIT must return 0/status=pass; empty npm and unmeasured Cargo must return 2/status=undetermined. Report-only GPL may return 0 but must retain status=fail. Verify D-002's npm/Cargo gate wiring and distinguish the report-only installer leg. Helper classification alone does not prove the strict result path.",
      "driftMarkers": "The license gate passes a lockfile that resolves a disallowed license.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/license-gate.test.ts"
        ]
      }
    },
    {
      "key": "r-4",
      "title": "nodebox is gone",
      "intent": {
        "request": "Remove @codesandbox/nodebox (non-commercial license).",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #932"
        ]
      },
      "model": "No lockfile in the public cut resolves @codesandbox/nodebox.",
      "barKey": "R-4",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "method": "At the pinned final public export, enumerate every package-lock.json through the recursive lockfile census, with the root lockfile and a measured surviving dependency as positive controls. Parse each package population for @codesandbox/nodebox and @mdxeditor/editor as dependencies. Missing/unreadable/empty root measurement is unknown, not absence.",
      "driftMarkers": "A lockfile in the public cut resolves @codesandbox/nodebox.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-5",
      "title": "First-party files carry no conflicting license",
      "intent": {
        "request": "Verify ELv2 compatibility of the codebase.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #963",
          "owner:Avi 2026-09-29 #964",
          "D-003",
          "D-016"
        ]
      },
      "model": "ScanCode finds no GPL or noncommercial license declared by a first-party file in the public cut. Exported libs/generic submodule repositories retain their applicable declared MIT/Apache-2.0 licenses; in-tree generic directories that are not separately licensed submodules follow the root ELv2 license, as clarified by D-016.",
      "barKey": "R-5",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "method": "Run ScanCode over the exact pinned final public cut and classify every license finding. Inventory exported generic submodule repositories from the superproject gitlinks/MANIFEST and their declared licenses separately from in-tree generic directories governed by root ELv2. Require complete scanned-file coverage and a disposition for each first-party GPL/noncommercial finding; unavailable measurement remains unknown. Do not require a new permissive license on an ELv2 in-tree directory.",
      "driftMarkers": "A first-party public-cut file declares GPL or noncommercial terms, an exported generic submodule loses its applicable declared MIT/Apache license, or an in-tree ELv2 generic directory is falsely advertised as permissive.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-6",
      "title": "The AppImage refuses GPL-only libraries",
      "intent": {
        "request": "Replace or drop the GPL-built libavcodec and every other GPL-only bundled library in the AppImage.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #963",
          "D-013"
        ]
      },
      "model": "The AppImage build drops the GPL-only GStreamer plugins and fails when any library on the GPL-only list reaches the AppDir (D-013).",
      "barKey": "R-6",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "unit"
      ],
      "passRatings": [
        "healthy"
      ],
      "method": "Run the AppImage GPL guard tests.",
      "driftMarkers": "The AppImage build completes with a library from the GPL-only list in the AppDir.",
      "check": {
        "kind": "tests",
        "files": [
          "papercusp-desktop/test/appimage-gpl-guard.test.js"
        ]
      }
    },
    {
      "key": "r-7",
      "title": "The public target never publishes to the preview or a private repo",
      "intent": {
        "request": "Push the public cut to a new repository.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #916",
          "D-004",
          "D-016"
        ]
      },
      "model": "The public push refuses the papercusp-preview repository and the private repositories (Papercusp/papercup, Papercusp/papercusp) as its remote. It also refuses a remote head lacking export lineage before both a dry-run return and confirmed publication, leaving that remote unchanged (D-016).",
      "barKey": "R-7",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "unit"
      ],
      "passRatings": [
        "healthy"
      ],
      "method": "Run source-preview-public.test.ts: crossed/private target refusals have an allowed public target control, and a remote main without export MANIFEST lineage is refused in dry-run and confirmed modes with exact unchanged remote-head assertions. These checks do not replace R-22's actual published head/gate identity.",
      "driftMarkers": "The public push accepts the papercusp-preview repository or a private repository as its remote. A remote head without export lineage is accepted in dry-run or confirmed publication, or refusal changes that head.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/source-preview-public.test.ts"
        ]
      }
    },
    {
      "key": "r-8",
      "title": "Public updates are append-only",
      "intent": {
        "request": "Public updates must not break forks and pull requests.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #916"
        ]
      },
      "model": "Each public update is committed as a child of the previous public commit.",
      "barKey": "R-8",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "unit"
      ],
      "passRatings": [
        "healthy"
      ],
      "method": "Run the source-preview public-target tests.",
      "driftMarkers": "A public update force-pushes or creates a parentless commit.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/source-preview-public.test.ts"
        ]
      }
    },
    {
      "key": "r-9",
      "title": "The desktop shell is public",
      "intent": {
        "request": "Include the Tauri desktop shell in the public cut.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #916"
        ]
      },
      "model": "The public cut contains the papercusp-desktop source tree.",
      "barKey": "R-9",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "unit"
      ],
      "passRatings": [
        "healthy"
      ],
      "method": "Run the source-preview public-target tests.",
      "driftMarkers": "The public cut omits the papercusp-desktop source tree.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/source-preview-public.test.ts"
        ]
      }
    },
    {
      "key": "r-10",
      "title": "Trimmed content stays out",
      "intent": {
        "request": "Drop closed-layer apps, the prose corpus, noncommercial plugins and stale files from the public cut; internal docs ship.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #916",
          "D-004",
          "D-006",
          "D-012",
          "D-009"
        ]
      },
      "model": "The public cut contains no path from the content-trim list: closed-layer apps, the prose corpus, and the noncommercial gitnexus-bridge plugin. It retains eligible internal documentation under apps/operator/public/internal/docs and apps/operator-docs (D-009/D-012). Installer source selections and shipped plugin/tool populations also exclude gitnexus-bridge and its gitnexus tools (D-006).",
      "barKey": "R-10",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "unit"
      ],
      "passRatings": [
        "healthy"
      ],
      "method": "Run source-preview-export.test.ts and source-preview-public.test.ts. Tracked sentinel fixtures from both internal-doc roots must survive with exact bytes in the preview and PUBLIC export; installer parity retains both while excluding gitnexus-bridge, with surviving operator/plugin and node_modules controls. Preserve closed-layer/prose exclusions. Separately inventory applicable finished installer plugin/tool bytes and verify gitnexus-bridge/gitnexus tools are absent; source-selection tests do not assert finished-installer proof.",
      "driftMarkers": "A trimmed closed-layer/prose/noncommercial path is present, an eligible internal-doc root is omitted, or a finished installer exposes gitnexus-bridge/gitnexus tools.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/source-preview-export.test.ts",
          "packages/operator-core/lib/source-preview-public.test.ts"
        ]
      }
    },
    {
      "key": "r-11",
      "title": "Telemetry is opt-in",
      "intent": {
        "request": "Public builds carry no hardcoded service defaults.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #916"
        ]
      },
      "model": "A fresh public build sends no telemetry before the user opts in.",
      "barKey": "R-11",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "method": "Boot a fresh public build and watch its outbound requests before the user opts in; also review the opt-in path (telemetry-flush.ts and the setup-wizard telemetry_enabled state, D-010). Use a working capture instrument and an opt-in positive control; a broken or silent capture cannot prove absence. At the same pinned public build audit D-010's public defaults: environment-only services and absent desktop support widget, distinguishing permitted public-token defaults gated by opt-in from bundled credentials.",
      "driftMarkers": "A fresh public build sends a telemetry event before the user opts in.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-12",
      "title": "The root license is ELv2",
      "intent": {
        "request": "Replace the evaluation-only NOTICE with the chosen license.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #962",
          "D-003"
        ]
      },
      "model": "The public cut's root LICENSE file is the Elastic License 2.0 text. The generated public README and product metadata identify Papercusp as source-available under ELv2 and make no OSI open-source claim (D-003).",
      "barKey": "R-12",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "unit"
      ],
      "passRatings": [
        "healthy"
      ],
      "method": "Run source-preview-public.test.ts for exact ELv2 LICENSE bytes and generated README source-available wording, with positive export/manifest/NOTICE controls. Read the pinned exported README/product metadata for any OSI open-source product claim. Publication/release wording is additionally checked in the live R-22 launch census; synthetic fixtures do not prove remote published text.",
      "driftMarkers": "The public cut's root LICENSE file is missing or differs from the Elastic License 2.0 text. Public product wording claims OSI open-source status or omits its source-available ELv2 identity.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/source-preview-public.test.ts"
        ]
      }
    },
    {
      "key": "r-13",
      "title": "Public submodule repos are licensed",
      "intent": {
        "request": "License the already-public submodule repositories.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #916",
          "D-011",
          "D-016",
          "D-019"
        ]
      },
      "model": "Every approved public Papercusp repository in the release licensing population, including exported public submodule repositories and the additional repositories explicitly covered by D-011/D-019, declares its applicable license on its actual default branch.",
      "barKey": "R-13",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "method": "Establish the approved repository population from pinned exported gitlinks/MANIFEST plus D-011/D-019; enumerate it explicitly before querying. Read each repository's actual default_branch and its declared license at that branch head, preserving API response/commit identity. Distinguish unavailable API data from a measured null license. An incomplete or empty population is unknown, not healthy; do not substitute an unrelated all-public-org query.",
      "driftMarkers": "An approved population member has a measured missing or inconsistent default-branch license, or population/API/branch coverage is incomplete.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-14",
      "title": "Secrets are triaged",
      "intent": {
        "request": "Triage secret-scanner hits and rotate real credentials.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #916"
        ]
      },
      "model": "The secret scanners report no unreviewed finding on the public cut, and every finding classified as a real credential has a rotation record.",
      "barKey": "R-14",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "method": "Run source-preview-gate.test.ts: all detectors clean is a positive control; planted tokens, missing/crashed scanners and unparsable outputs must refuse. Then run the actual gate on the pinned launch cut and retain its complete finding ledger. Every finding classified real requires its own verified rotation record; reviewed false positives must match their exact value/hash. Guard tests or a clean final scan do not themselves prove rotation.",
      "driftMarkers": "A secret scanner reports an unreviewed finding on the public cut, or a finding classified real has no rotation record.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/source-preview-gate.test.ts"
        ]
      },
      "requiredTestLayers": [
        "unit"
      ]
    },
    {
      "key": "r-15",
      "title": "Distributed builds pass the installer scan with every finding dispositioned",
      "intent": {
        "request": "Third-party license compliance for distributed builds.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #927",
          "D-002",
          "D-013"
        ]
      },
      "model": "The Syft installer scan of a distributed build reports no UNREVIEWED finding and no disallowed license without a recorded disposition. A recorded disposition is either (1) a component entry in scripts/installer-components.json whose paths match the finding and which names the component, its license, the reason it may ship and its obligations, or (2) a plan Decision naming the license, the package and the reviewer. The owner made the installer leg report-only (D-002, [owner:Avi 2026-09-29] \"lets disable the blocking for now\"); GPL AppImage libraries are removed per D-013.",
      "barKey": "R-15",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "method": "Inventory the actually distributed/published finished installer assets; record release identity, URL and digest; obtain exact bytes and verify the signed manifest/signature/hash chain. Run audit-release-bundle.py --scan-artifact --licenses on each applicable finished installer, retaining Syft/scanner inventory. Map every finding to a matching installer-components.json entry naming component, license, reason and obligations, or a plan Decision naming license/package/reviewer. Missing, stale, incomplete or unavailable artifact proof is unknown/non-passing. D-002 report-only exit zero permits pipeline continuation, never an acceptance pass. Source scans, manifest unit tests and unpublished builds are not substitutes.",
      "driftMarkers": "The installer scan reports an UNREVIEWED finding, or a disallowed license with neither a matching installer-components.json entry (component, license, reason, obligations) nor a plan Decision naming the license, package and reviewer.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-16",
      "title": "Paid features are enforced server-side",
      "intent": {
        "request": "Keep the paid cloud tier compatible with the open release.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #916",
          "D-003",
          "D-015"
        ]
      },
      "model": "The cloud service refuses a paid feature for an account without a subscription.",
      "barKey": "R-16",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "method": "Run auth/hosted-entitlements.test.ts for missing/ambiguous/inactive authority negatives and entitled controls; these guard the resolver only. Inventory active subscription-gated cloud service operations at the pinned deployed build, trace each to the persisted/signed entitlement authority, and exercise its actual serving boundary with an account lacking subscription/authority and a valid entitled control. Require refusal with no protected result/bytes for the former and successful authorized behavior for the latter. A correct unused resolver/client flag or excluded service source is insufficient. Preserve D-015's separately tracked nonblocking marketplace-byte follow-up for nonexistent paid listings; do not invent a paid listing.",
      "driftMarkers": "The cloud service serves a paid feature to an account without a subscription.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/auth/hosted-entitlements.test.ts"
        ]
      },
      "requiredTestLayers": [
        "unit"
      ]
    },
    {
      "key": "r-17",
      "title": "Owner legal actions are tracked",
      "intent": {
        "request": "Trademark filing and lawyer review are owner actions that do not block launch.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #916"
        ]
      },
      "model": "A work-item assigned to the owner tracks the trademark filing.",
      "barKey": "R-17",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "method": "Read the owner-assigned work-items.",
      "driftMarkers": "No work-item tracks the trademark filing.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-18",
      "title": "Strangers can build it",
      "intent": {
        "request": "The public cut must build on a clean machine.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #916",
          "D-017"
        ]
      },
      "model": "On a fresh machine with no preinstalled toolchain, a clean clone of the public cut installs its prerequisites and dependencies, typechecks, and builds and boots the desktop app by following only the README.",
      "barKey": "R-18",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "method": "On a fresh VM with no preinstalled toolchain, clone the public cut and follow only the README: install prerequisites, npm ci, npm run lint:tsc, then build and boot the desktop app (headless is fine).",
      "driftMarkers": "Following only the README on a fresh machine with no preinstalled toolchain fails to install, typecheck, build or boot the desktop app.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-19",
      "title": "Public CI is green",
      "intent": {
        "request": "The public repository needs working CI.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #916",
          "D-017"
        ]
      },
      "model": "GitHub Actions passes on the public repository's launch commit.",
      "barKey": "R-19",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "method": "At R-22's exact launch SHA, read the shipped CI workflow and verify D-017's npm ci and lint:tsc steps plus safe PR triggers/permissions. Enumerate the expected workflow runs at that SHA and require complete successful conclusions. Empty, skipped, cancelled, unrelated or unmeasured run sets are not healthy. Do not claim a public test suite that D-017 explicitly deferred.",
      "driftMarkers": "GitHub Actions fails on the public repository's launch commit.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-20",
      "title": "Local surfaces are reviewed",
      "intent": {
        "request": "Security review of local surfaces before publication.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #916"
        ]
      },
      "model": "The security review records a disposition for every local network surface.",
      "barKey": "R-20",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "method": "Compare the review against the listening ports of a running desktop app.",
      "driftMarkers": "A local network surface has no recorded review disposition.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-21",
      "title": "External contributions have a path and a CLA",
      "intent": {
        "request": "Define how external pull requests reach the source of truth.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #916",
          "D-004",
          "D-008",
          "D-017"
        ]
      },
      "model": "CONTRIBUTING describes how an external pull request reaches the source-of-truth repository and names the CLA; the public repository carries CLA.md and a configured CLA check workflow.",
      "barKey": "R-21",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "method": "Run source-preview-public.test.ts to guard exported CONTRIBUTING/CLA/workflow bytes and a CLA bot that never checks out PR code. Then read CONTRIBUTING.md, CLA.md and .github/workflows/cla.yml at R-22's actual public launch commit and verify the source-of-truth PR route, configured CLA check, and safe workflow permissions. Fixture passes do not replace the live repository observation.",
      "driftMarkers": "CONTRIBUTING omits the pull-request route or the CLA, or the public repository lacks CLA.md or the CLA check workflow.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/source-preview-public.test.ts"
        ]
      },
      "requiredTestLayers": [
        "unit"
      ]
    },
    {
      "key": "r-22",
      "title": "The public repo serves the gated commit",
      "intent": {
        "request": "Launch the public repository.",
        "sourceRefs": [
          "owner:Avi 2026-09-29 #962",
          "D-003",
          "D-016"
        ]
      },
      "model": "The public repository's default branch head is the commit that passed the export gate.",
      "barKey": "R-22",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "method": "Read Papercusp/papercusp-app's actual default_branch, resolve that branch head and compare it with the exact exported/publication commit and complete successful gate receipt. Record both identities and the full gate population. Read README/product metadata and published release text at that identity to verify source-available ELv2 wording with no OSI open-source product claim. Missing/unavailable branch, publication or gate measurements remain unknown; never assume commits/main is still the default branch.",
      "driftMarkers": "The public repository's default branch head differs from the gated commit.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-23",
      "barKey": "R-23",
      "title": "Export integrity follows the pinned objects and dependency graph",
      "intent": {
        "request": "Preserve D-007's pinned-object, dependency and shared-tree integrity guarantees.",
        "sourceRefs": [
          "D-007"
        ]
      },
      "model": "The public export materializes the pinned superproject commit and submodule gitlinks at object level, never checks out/stashes/merges/creates a worktree in the shared canonical tree, and never reuses integration node_modules whose dependency set differs from the pin. Applicable export/cut scripts obey the resource-governor admission registry or Governor.admit route.",
      "method": "Run source-preview-export.test.ts for committed-content/gitlink controls and the divergent-dependency fixture: exact pinned lockfile/source bytes, no exported integration node_modules, and invariant dirty source/index/branch/head. Run source-preview-public.test.ts for PUBLIC target behavior. Inspect the pinned exporter/materializer and every applicable new/modified spawn/exec cut script for object-level operations and its resource-governor registry/admission route. For actual cut/installer builds record pinned dependency fingerprints, isolated build install provenance and shared-tree invariance; fixture success alone does not prove final build dependencies.",
      "driftMarkers": "An export uses working-tree/index/integration dependency content instead of pinned objects, alters shared source/index/branch/head, reuses a divergent installed dependency graph, or runs an applicable unadmitted spawn/exec script.",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "unit"
      ],
      "passRatings": [
        "healthy"
      ],
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/source-preview-export.test.ts",
          "packages/operator-core/lib/source-preview-public.test.ts"
        ]
      }
    },
    {
      "key": "r-24",
      "barKey": "R-24",
      "title": "Hosted customer workspaces never receive service-owned Anthropic subscriptions",
      "intent": {
        "request": "Enforce D-014/D-015's distinct hosted credential provenance prohibition.",
        "sourceRefs": [
          "D-014",
          "D-015"
        ]
      },
      "model": "The hosted cloud tier never provisions Anthropic subscription credentials owned or paid for by the service into a customer workspace. Customers supply their own API key or sign in using the unmodified CLI.",
      "method": "At the pinned hosted-control-plane build, inventory all credential source selectors, producer callers and delivery/admission boundaries for customer workspaces; prove population coverage. Exercise a forbidden service-owned/service-paid Anthropic subscription selector and require refusal before storing or delivering material, with no protected bytes. Pair it with allowed customer API-key/unmodified CLI sign-in controls and retain redacted source-provenance/authority receipts. Run this at the actual producer/delivery boundary under an isolated request/dependency seam using synthetic material; generic bundle serialization or public gateway tests are not provenance detectors. Any absent provenance discriminator, untested producer or unmeasured delivery is unknown/non-passing. Do not forward real credentials for the probe.",
      "driftMarkers": "Any customer workspace receives a service-owned/paid Anthropic subscription, the forbidden control stores/delivers material, or credential producer/delivery provenance coverage is absent or incomplete.",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    }
  ],
  "reason": "Repair independent review WI-10005835/post1156883: real strict gate and retained-doc detectors; D016 license populations; D003 source-available wording; explicit D007/D014/D015 outcomes; existing relevant guards with live proof preserved; exact CI/default-branch/license populations; retain R15 actual published-byte proof. Canonical suites currently verified; hosted provenance and serving boundary live evidence remains required, not asserted.",
  "expectedRubricRevision": 3,
  "expectedSubjectPlanRevision": 86,
  "idempotencyKey": "osr-rev4-1156883-1ba4c-20261003",
  "dryRun": true
}

