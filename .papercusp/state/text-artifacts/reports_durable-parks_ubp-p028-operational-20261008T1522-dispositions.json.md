---
rel_path: "reports/durable-parks/ubp-p028-operational-20261008T1522-dispositions.json"
updated_at: 1791472930738
_body: "content"
---

{
  "schemaVersion": "ubp-p028-cohort-receipt-v1",
  "runId": "ubp-p028-operational-20261008T1522",
  "generatedAt": "2026-10-08T15:22:10.114Z",
  "selection": {
    "kind": "bounded conservative nonP2P cohort",
    "excludedPattern": "p2p|federation|shared[- ]hive|shared[- ]workspace|lib\\/sync\\/",
    "reportPopulation": 157282,
    "totalParks": 503,
    "selected": 370,
    "excluded": 133,
    "scopeCompleteness": "unknown: conservative subject/payload exclusion is not the fleet canonical scope predicate"
  },
  "dispositions": [
    {
      "id": "EI-10",
      "title": "P-020 follow-on (optional/supervised): invert work_items physical base + make base triggers kind-aware",
      "parkFingerprint": "0c66dd85d4b4a4f01d4d71e18b53c7e1e64ab5ec8120f155453d5e9ed5c11574",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "DEFERRED BY DESIGN — parked so it stops burning drain cycles (2nd holder to claim+release unchanged). Gated by its own filing: (1) physical-base inversion = cosmetic and HIGH-risk bare RENAME of a table referenced BY NAME in CDC + 3 triggers; needs a supervised pass + plan-owner coordination; ZERO functional change today. (2) kind-aware triggers only matter once a non-feature row exists; none do. UNPARK: supervised pass, or 1st non-feature create.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-10874",
      "title": "Type errors surface in a STRANGER'S gate: operator-core has no typecheck test, so its errors red operator-vite's ratchet and land on whoever next needs a deploy",
      "parkFingerprint": "c2da31b7a88d8b59ebaeb55864745605274762400c22463cd8a13e8e3f764da6",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-10907",
      "title": "A hooks migration silently DROPPED two declared hooks and nothing alarmed — no liveness assertion on hook last-fire",
      "parkFingerprint": "0eaca07d723cc5b36e74e4b0656f781f56038b2ea2f5ed24147e747ead29dfcf",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-11171",
      "title": "Routine engine intermittently STARVED — dead-routine \"overdue >10m\" alerts flap (fire+recover) repeatedly, correlated with PG pool-starvation routines-tick sheds",
      "parkFingerprint": "9988d27c6a54bfb462e2cc1b7e063ed24f0f26ee89e067ddc32b06b7228df16e",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-11343",
      "title": "cluster-fork supervisor misdiagnoses an EADDRINUSE worker-death storm as \"UNBOOTABLE (MODULE_NOT_FOUND / boot-time throw) — run npm ci\", sending incident response down the wrong runbook",
      "parkFingerprint": "eef1a92e12179dc5101a191f96f476116f3af25dd91cbd71a4ba514c33bc9d52",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-11404",
      "title": "Bounded result projection can erase every useful recipe result and return an unusable rerun instruction",
      "parkFingerprint": "980b1878e75726f65d482bafb0999ae02c797dff5430ea6e1e4b9515d9c720df",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-11409",
      "title": "coord:orient should activate a task-sized tool schema pack so agents do not spend a third of their calls rediscovering and wrapping known tools",
      "parkFingerprint": "e9f3ba3c263beb682f8b31cadeb8bc37dbc51b651f5c9fc3422481a7301c4610",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-11519",
      "title": "Brainstorm partner chat turns fail with \"claude-code exited ?\" (exitCode null = spawn-fail or signal) on BOTH /adv brainstorm and the new quick-panel — pre-existing, owner's own earlier message also failed",
      "parkFingerprint": "9c5abf329518801c70d0ff135b6dc9f6cb143d25c62bbcac1565c0e60f884ebf",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-11601",
      "title": "Kettle loop fires every 120s but has been skipping the mandatory pot-coordination-health scorecard emission",
      "parkFingerprint": "c58ef3ea0a43424a9de9a957c29f93f8f178787801500e33a410be5f5a3e6814",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Validation complete; human-gated process/prompt change. Preserve claim hold so scheduler self-selection cannot re-admit it until the owner authorizes a strategy.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-11619",
      "title": "Rubric scorecards accept undeclared rating keys and pollute rubrics:trend",
      "parkFingerprint": "681f4c9ce0dde1dd300fdf7eabb14817aad51ff666a5af99a6afbd8ec0d54aac",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-11653",
      "title": "Unit-test env should hard-block live PG connections — live-state time-bomb tests pass/fail on dev-box DB accumulation (WI-4754 class)",
      "parkFingerprint": "6370c66942c899c5b132603f2feb0399bdc0172c56d85aa12a43687650951f6d",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-11718",
      "title": "code:run dryRun does not intercept write effects dispatched through tools:invoke",
      "parkFingerprint": "f72d8763ca923b307420faf17b6902d79e84c16cba3d40ee3bf2e23c9ba0c75e",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-11894",
      "title": "System-health routine tick can go stale for 37 minutes before self-recovering",
      "parkFingerprint": "96358529558b9769c52e0f03397f70d5a2358a4630381e47ae0dca0cadea8fd0",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-12895",
      "title": "Bytebot desktop-agent instances unusable: task model rejects plain string spec, and proxy route configured with literal \"dummy-key-for-proxy\"",
      "parkFingerprint": "563a752ce4f241f9c2d1d0d14fcfb1f94ad7ef0a78d2676364a34583197f0db4",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-13268",
      "title": "Completed work routinely lands in-tree but is never written to the work-item ledger — items sit todo/cursed and burn re-placement cycles",
      "parkFingerprint": "924f64ca14d3f11fd05c8e83abdbe8e5e62b215a2583ba1688d64dd1a6f0e46d",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Out-of-scope accidental review claim released; preserve the existing human/gym process-design gate and prevent re-placement until its gate owner resolves it.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-13587",
      "title": "Untracked runtime DDL: bak_20260717_unify_* backup tables in harness_shared, created outside any migration file, after owner parked the underlying WI-453 unify-work-items initiative",
      "parkFingerprint": "6b5eca319ec1f08107739f4eefd50d949d6d127f1bc8fa55ba90f44f6d01fa7c",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-13623",
      "title": "Release-checkout deploy wedged 11h+ on a git-sync sweep-boundary inconsistency (new lib's workspaces entry landed before its files) — both swap AND rollback targets broken",
      "parkFingerprint": "78ed88a53eadb29d2b5b83b2a4473136a88394909754785ccb09e11ab16c69e2",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Parked as protected release-path needs-human/agent-review residue after the current workspace-build guard passed 4/4.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-16685",
      "title": "coord:inbox-wake (always-armed inbox-wake) repeatedly delivers a BACKLOG of stale/already-read old messages with expired nonces, instead of only the latest unread state",
      "parkFingerprint": "1453aa6e85d33371e47396f715822ca06959a08c7455541fb9d7ebef69a0050d",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked on WI-5510 (priority-1, in-progress fix by su-37977cd5) — same root-cause family as EI-16648 (already parked pending WI-5510). Parking to avoid duplicating the investigation; will verify + close once WI-5510 lands.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-16883",
      "title": "Mid-session cache invalidations are ~50% of the fleet's prompt-cache write bill — 550 full-prefix re-writes/48h, concentrated in MCP-flap sessions",
      "parkFingerprint": "11efdbc547b112436d4de9d05fab2515f8abe83ea29125ffcb052c12c35f307b",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-17287",
      "title": "work_items.attempts is 0 across ALL 20,244 papercusp rows — even via the topology-independent EI-203 bumpOrResetAttempts path in orchestrator-loop.ts (DBOS dispatch loop)",
      "parkFingerprint": "fef0bc512b38cda57853b7a7ed30d7e1a66907566ecc8f7f9aa119c429a9e1f1",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "EI-17287 validated and parked needs-human: unified open retry bypasses the EI-203 increment predicate; protected DBOS path needs human fix and integration regression coverage. Release stale claim and keep excluded from scheduler self-selection.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-18135888257691152",
      "title": "Add an automatic/cadence-based cold-boot-drill runner so the 'claude-headless' class can ever reach minDrills=1 for P-021 cold-by-default",
      "parkFingerprint": "babd00d158fb6a5029226f0108bd5d72f264edb96d4610ab3cbf0babe08dc34c",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "owner grade on the ledger row is cleared, or the item is resubmitted as a distinct idea",
        "owner": "su-bac83da3-7929-4bbc-99a3-6296aa56abcf",
        "trigger": "work-item:claimable",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-08 11:17:54.886777-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-19478108227825847",
      "title": "workspace facts scope sits AT its 50-fact cap, so every facts:assert silently evicts another agent's durable authority",
      "parkFingerprint": "3595d06daca731242f37a776f0bbce9a2fac93cae723a71092bd96342db7e567",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-19483689516127637",
      "title": "The default release cut REUSES the committed corestore, so a degraded coreSparseFrom:0 core is grafted forward forever — no sparse fix can ever reach production",
      "parkFingerprint": "c4734f4a20c8b2f937a8681230599fec3876d1d64a97ff3ff4cbfd264a00633e",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-19485284578135530",
      "title": "reclaimWedgedSpawns is structurally inert for 4 of 5 spawn classes — EI-18729995135827661 closed after fixing only its dangerous half, leaving the missing-floor half",
      "parkFingerprint": "ea12e62abd801dd1f01094efaae0d3cdbeb0da0b5ee0794da6fb26b0c882c479",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-19967260725602869",
      "title": "Repeated 2-call tool dance across 18 agents: code:run → code:run",
      "parkFingerprint": "c534f5d120224e0fbdc70a3693343e4fd9a93ed61674268a1cf453d2b2ee3b15",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20074719498966502",
      "title": "tauri-agent-tools capture aborts ALL artifacts on a Wayland box missing grim — DOM/console/logs need no compositor but are never attempted",
      "parkFingerprint": "bec76d4c8dd63320285713fe3e9aeb2155d97d0a9c52ae603bec6a60ed8f3991",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Needs-human external blocker: upstream tauri-agent-tools maintainer/package release required; no local Papercusp fix exists.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20077125623815751",
      "title": "The guard-of-guards' corpus test classifies by QUOTED extension mention, so it is blind in both directions — 4 guards invisible to the shrink-only baseline, and an INI-only guard sits in it",
      "parkFingerprint": "707d393f50fe230e2aea4cd2e7fdf8112be1a28f463de4b8586820d27e2b9f23",
      "lease": {
        "by": "su-c7d44fd4-e5b1-4085-a15d-77fadde3458a",
        "reason": "Parked needs-human: item carries an active policy-tier human review gate (triageDecision=gate; agentReview pending) and its earlier static regex-widening prescription was retracted. Durable behavioral-census correction requires accountable review before implementation.",
        "at": "2026-08-21T09:57:57.631Z"
      },
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Released after needs-human disposition; preserve claim hold until policy/review gate clears.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20082312471440722",
      "title": "Goal stop's placement tier is structurally inert: nothing auto-pairs a goal to a pot, so goal_pots is 0 rows and goals:update{paused} gates placement on nothing",
      "parkFingerprint": "b7e1c1f2a31218b113d773666004c8ee902c577bbd5c4e53ce1a9276e8f720c5",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Parked after stale-premise remeasurement; awaiting product decision on dedicated-pot association.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20191870574700529",
      "title": "Owl audit source probes need wiki-link markup tolerant variants",
      "parkFingerprint": "13598966d079ace4434ea5ebc5a1bdf134ba0c1b7771f99159dd144b31fd641f",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20192339459004669",
      "title": "capability:bash auto-backgrounded a 200ms script at the 120s cap, then reported it `running` for 7+ min after its process was dead and with no output file ever written — TaskOutput block:true on it would wait forever",
      "parkFingerprint": "1d00ab390bb2897c4840e66c4bababa0ca3bc62b2d521873b62cdae49dc8c05c",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20200247707626194",
      "title": "Scout ideator transport death PERSISTS after P-003 was closed — 0 healthy accounts while 2 healthy codex accounts sit unusable (codexConfigured:false)",
      "parkFingerprint": "9aa5b58b3b49588a82331c9ed2bf26d709fd99e34716a41dbc203a442194b486",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Owner-only Scout account-routing decision is pending; item is durably blocked and parked until Avi chooses pinned account or gateway auto failover.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20204139154935996",
      "title": "Schema AHEAD of code: the live DB has applied migrations this running tree does not ship",
      "parkFingerprint": "c4e085c08b06570d6fea607b17a770793cd16020662003841c6409541838ab71",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked on live db:check_drift schema-ahead dependency; keep out of self-select until migration parity is reconciled.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20205289076999667",
      "title": "operator-core typecheck baseline regression in _harness-scope.test.ts",
      "parkFingerprint": "620a4f761e7e6face17d6563614b07c53d2e0f0e529bc59bbd753897f47ac102",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked on su-70b6af5b's live _harness-scope.ts lock; keep parked until the helper owner releases or hands off.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20224530966164417",
      "title": "MCP proxy sheds work_items:get at admission ceiling during staging terminal close",
      "parkFingerprint": "ff8f7af125f0f9b4fa82397e9e01f2e911065c42fe77d50c9f7e2d851bce1932",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked: peer classifier fix is non-duplicate; proxy.ts and proxy.test.ts are held by live agent su-a895672e for adjacent reserve work. Evidence/checkpoint refreshed with current 85/85 focused pass. Release this claim while retaining hold for future owner.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20342237035251887",
      "title": "Fresh 0.0.17 seed fold leaves build-box identity in Corestore WAL",
      "parkFingerprint": "30d7cc6d55136ac66b336a3bcedefa342a8944628f1c0b2eda6ef2eee5996025",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Protected release path requires fresh green source pin and human-policy authorization for the full release precheck before a corrected 0.0.17 cut.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20357575123348185",
      "title": "Mac release VM cannot request one-time Recovery boot through root nvram",
      "parkFingerprint": "7bb947a2dae13b982d1278cc735e81c7d48443a0694c24cff06fd014385f9954",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20386584937642609",
      "title": "fleet:launch-on-plan with count<=liveMembers is a suppressed NO-OP launch that still re-stamps the fleet claim spec — silently clobbering an authored multi-plan spec",
      "parkFingerprint": "600ecbde2d30bbb90d663be93e03618eee771dca7a12c48ff0ea08f068813fc5",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Stale carried claim after compaction; explicitly do not revive this item.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20402188135645864",
      "title": "@papercusp/dock-workbench: passing `className` silently REPLACES the dockview base theme, undefining ~29 --dv-* variables",
      "parkFingerprint": "fe5908aa1a4f55a8c2b3ffa8a717783cbc1240dad7c374611b7d5b9cbb855906",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20445868109303312",
      "title": "Rescue/preserved copies of an uncommitted file exist ONLY on local disk — no off-machine durability, and sweeps did not capture it",
      "parkFingerprint": "bb2e97a4db90ca0a8da5c27a9bc1632a212af26f03d576c2ea9abd543c693c1d",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20446695640851636",
      "title": "Android 16.1 UI AVD SurfaceFlinger crash-loops under swiftshader_indirect region sampling",
      "parkFingerprint": "87728c0588729c51a7748b6462f2358601bb436de0fe8b53461a4e7279f749d5",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20454083413033688",
      "title": "Pinned green Papercusp release dependency tree reports 111 npm audit advisories including 5 critical",
      "parkFingerprint": "319e7eee438f6b62f622404c6b04e260ab4dd9616ac1eb5409ee0c46c6411667",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Parked as needs-human after bounded dependency reachability/dedup review; dependency-owner/security review is required before any upgrade or mitigation.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20456781705482029",
      "title": "SideStage production deployment briefly serves SPA HTML with HTTP 200 for /api/catalog",
      "parkFingerprint": "918cf2725096b6ef0fb5c037290907357040b2221658f7ccd92f72bdca6093f2",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Validated and parked needs-human: historical SideStage SPA-HTML response not reproduced; external SideStage deploy-owner review is required. Keep out of scheduler until human clears the gate.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20459482864153129",
      "title": "SideStage web test can observe a mixed git-sync snapshot and emit a false-red gate",
      "parkFingerprint": "6af96e576e64ff55e6cd6cd58c287209c4d78e1732ff42b2b8cdccb87db54ef3",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Validation is complete with needs-human evidence; release my assignee while preserving the owner-gated claim hold so scheduler capacity is available without re-admitting this item.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20474637863061047",
      "title": "SideStage full test can abort when package-lock changes during npm workspace pretest",
      "parkFingerprint": "69f5c89975c8608c30cab240588439ba4d0eef7c39766e472f9018482f629d7e",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20485358533942031",
      "title": "Stale green-checkpoint RED alert is injected after authoritative run is already green",
      "parkFingerprint": "8c3dc150b099b82553a4827e3ba5225e80276785090c25773f8d510852a36225",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20495291773775521",
      "title": "Packaged release exposes the full debug/dev tool console at /dev",
      "parkFingerprint": "6683eb41ba2c7dfac1961dabd1ad9056627ce72870a01acdfc61df62f66ec6ef",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Parked needs-human after current-HEAD validation: packaged /dev remains exposed and focused tests pass without a packaged-absence guard; D-010 plus the item's installed-evidence boundary forbid source/release mutation until the governing release-audit freeze is cleared or explicitly superseded. Resume only in an authorized release-fix lane with the shared visibility gate and recurrence tests.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20539604747473027",
      "title": "record-release-cli defaults --workspace to 'papercusp-workspace', so recording ANY other product's release silently pollutes Papercusp's public release page",
      "parkFingerprint": "a6b7e1cd0f9f05e48b92fa7bfa52284b9b3a77b4e1db8c5e5758e31dad7bf866",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Parked needs-human under active D-003 protected release-path policy gate after live reproduction.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20565859968567853",
      "title": "Dark-flag allowlist needs owner review",
      "parkFingerprint": "4fb7483cead0ba9d22aa61c27c192041865a10f985afcc8ac2cb15e7e9fe4357",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20576535595925497",
      "title": "Completing a SUB-LANE work-item silently closes its parent plan item: sibling rows share one payload.plan_item stamp (126 plan items affected, 51 still live)",
      "parkFingerprint": "a61dadd5a166435e0cb5773c9dfb0a25017d3fe123e9aba41b058256af8d8e58",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Capacity replacement requested by fleet kickoff. Prior deployment verification is gate-blocked (complete.ts on staging, not in main/deployed); checkpoint preserved. Durable claim hold prevents reassignment until the authoritative gate transition.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20577421906951067",
      "title": "A plan-linked work-item auto-closed by plan-item-reconcile cannot be reopened by ANY documented route — the mirror is done-ward only, and work_items:set_state refuses the write while pointing at the mechanism that cannot do it",
      "parkFingerprint": "7390f4a441cab856ee7e9f6250209ff8f376c68b6daec49dca1815d4e3f26185",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20580419609576585",
      "title": "The attestation-wall \"degrade around it\" path also suppresses the .deb REPACK, so local_matrix can never pass while the owner-gated GitHub wall stands — the non-GitHub legs are not independently measurable",
      "parkFingerprint": "f83d86c4fdd611a08209de0a38446271bdf3c6314f40f7cafb0a1fc9cc9faf36",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20589765301078360",
      "title": "Quiet-window host op: shrink the 2TiB /mnt/data/swapfile (only ~160G used) to reclaim ~1.8TiB on the 92%-full volume — ⚠ swapoff right now would OOM the box (measured)",
      "parkFingerprint": "1f5b3c0af1a31877c8d27e06726d46198ff73c7713662c76e3b660fe5377a50c",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "UNPARK WHEN: the ~199 GiB of unreaped scratch under /mnt/data/tmp has been reclaimed (EI-22397721986169369). Zero-risk reclaim must precede this risky one — it recovers space on the SAME volume with no OOM exposure and widens this item's precondition gate. The procedure itself is DONE and verified: scripts/shrink-swapfile.sh (dry-run default, 10-min stability requirement, resumable) + packages/operator-core/lib/shrink-swapfile-gate.test.ts (8/8). Read the item checkpoint's 6 checks before acting",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-20965384912390907",
      "title": "functions.exec parallel batch aborts on one invalid workdir",
      "parkFingerprint": "1f9ef5902a7e52cff68050708f6d0abbf38b5f9906b23b5c9ef732c06d538ef4",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21053798857109512",
      "title": "Host memory PSI full pressure recurred during EI-210512 verification",
      "parkFingerprint": "5ad6b03a4aea003d6574119c5d119052a339b8a649fa1593095c18a0f89a1d50",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21056595762114670",
      "title": "Green-checkpoint stateful Vitest lane rapidly accumulates unreaped shell zombies",
      "parkFingerprint": "979ced3934e6d6bcbba90aa276bd8efb314aabe7245da82818be5851d3f78504",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Cannot progress from a cold claim — the specific process group (PGID 1041288) is 12 days gone and current live state shows no reproduction (20 scattered zombies, not one mass-PGID accumulation). Root-causing requires being live during a NEW occurrence of the symptom to capture the offending PGID/parent PID before it exits. Unpark condition: the NEXT time the green-checkpoint gate's stateful Vitest lane shows the same runaway single-PGID zombie-accumulation pattern (checked via a live ps snapshot",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21072900319774164",
      "title": "Acceptance author gate strands recovered sessions behind ephemeral owner IDs",
      "parkFingerprint": "392cfa8b8dc17281ee8ec374b3a75667b1eefae677718fb3d866313061c84b57",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked pending shared release-gate promotion; focused verification is complete and evidence is recorded on the item.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21109934479293631",
      "title": "Oddsmith's alarms have no delivery path off the box: cron-alarm fired 142x in 24h into journald + an error_events table inside the very sidecar that was down",
      "parkFingerprint": "3c80f4ab6614236503b18704589c2af24512827ca9c589b0891785e79944a252",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Keep parked until the external aviynw/oddsmith owner supplies access or lands the alarm-delivery fix; this Papercusp checkout cannot implement it.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21123893604873334",
      "title": "consult archive reuse matched an unrelated acceptance-rubric vetting answer at 0.83 similarity",
      "parkFingerprint": "9a3a1ebaca9976571d012385d9206e4468237162fe6ca56827000d3730ad1c6b",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked on live shared release-gate repair; exact regression and deployment evidence are checkpointed.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21124130013334057",
      "title": "project-history generate work_items:export harness row limit blocks complete live export",
      "parkFingerprint": "266649550b6343b0d33727d732ac707299c855c6b882bcec1e7e6bdb3f0f8c56",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21146949285164737",
      "title": "work_items:complete returns ok:true but leaves the item `wip` — a false success on the documented completion path",
      "parkFingerprint": "244f733102befd422fe98a57ff4214f0c2b7949e62b1509662fc239a499a9a70",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21172597553319764",
      "title": "tauri-agent-tools capture ignores --pid when resolving X11 window",
      "parkFingerprint": "5e2d4c49218fe719cb27a6d7419be28d6f13d9cb35d68bae0afbc456713b4d22",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21204249963618684",
      "title": "apply_patch rejects metadata-only file moves as empty hunks",
      "parkFingerprint": "5e2042009b2cf1222490d7cb9fa2e0dc4b508b7ed2519b35afd353239401f478",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21269301967233941",
      "title": "MCP proxy re-saturated at the 192-request admission ceiling during replacement-fleet burst",
      "parkFingerprint": "583771d38d3920f8558134a5e9f91ec9b359a8dac84fbaa0d98a4f4a43e5e8b1",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked validation residue remains parked after stand-down; do not self-select until the generation-2 qualification and promotion evidence arrive.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21275523571820186",
      "title": "A cold wake can deliver a SUPERSEDED loop carry-note, and the successor's loop:checkpoint then silently destroys the newer one (single-slot, no compare-and-swap)",
      "parkFingerprint": "af16facc73b392a9ec19ebb97bef19c09f1040f3e37fc1167e9c8c8338e407b1",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21297345529573928",
      "title": "dev:restart cannot coordinate the supervised mcp-proxy service",
      "parkFingerprint": "4b82d11387e3a71b6ff3802b0a99d21c68c4c4d098e856a622e2417d33db89c1",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked on terminal fail-closed WI-40086 release authority; preserve claim hold until a future authorized green deploy makes live-schema verification possible.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21306560247518837",
      "title": "capability:inspect tool-call failure (MODULE_NOT_FOUND)",
      "parkFingerprint": "87598a1db6d3b56dde88bec608b59d388a857485192391be24071f2bb3678242",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Unpark only after release:trace and dev:pipeline_position show 768c5d609 inMain=true and deployed=true; current gate is deliberately paused under WI-40086.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21314203320677717",
      "title": "Codex V8 scratch base64 decoder lacks TextDecoder",
      "parkFingerprint": "4eeabe5fa16f55d6397fb77589aaf27edfa10888f68c682602408613045de4db",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21314288888643029",
      "title": "Papercusp green-checkpoint verdict wedged stale behind repeated skipped-locked ticks",
      "parkFingerprint": "3eea130e52e3c497b1b32f8ddc157db5e1e54ab9888e6c4f5438942ed2ca2e20",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21331231608827224",
      "title": "MCP proxy ECONNRESET blocks loop checkpoint write",
      "parkFingerprint": "c77a0ced329a0a60b567e4e0302a52bcd29b2119801a4479a53ae5b5570571ff",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21371682507889533",
      "title": "work_items:complete tool-call failure (invalid_args)",
      "parkFingerprint": "5afffeb112f819f3ede7b762b3a3027b15eea19bae6ece4d1299ca6487afd213",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21387713518605329",
      "title": "LOOP WEDGED: 'rt_papercusp_loop_su_4d40b627_f3eb_4814_bf0f_b7d407d484d1'@papercusp turn died — permanent (owner su-4d40b627-f3eb-4814-bf0f-b7d407d484d1)",
      "parkFingerprint": "04082bb840aa99ec416a5bf476e7268402375b13c685d9b0b0eadb5e38d271cf",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Validated current source/tests; blocked until green-checkpoint promotion clears D-042/WI-40086 and the fix reaches :3070.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21401078531195034",
      "title": "Running plans:audit schema rejects current activation-audit fields",
      "parkFingerprint": "12923764cc60a07b28f41164f2a078a34e6f93b879a4a5638833177c22c8c487",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21463709493970152",
      "title": "Cross-repository git-sync deploys schema readers before migration submodule",
      "parkFingerprint": "d4a7d587b6b5cb28c3104ee2dd08ae3bbd6c7cfcc5a4000cbf273bb85c22f9c9",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Deferred until WI-41491 completes and the green gate produces a fresh typed verdict that can advance the staged fix.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21509610544515350",
      "title": "Resilient MCP proxy (:9071) restart window surfaces one hard transport error per attached session — candidate fix: systemd socket activation",
      "parkFingerprint": "41ee597577e70ff6c2a55ca1ddf4e90820d60b13bdf1ba93b442d360dff12a65",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Design-lane scope: proper fix is systemd socket activation / SO_REUSEPORT handshake on papercup-mcp-proxy (touches deliberately dependency-free proxy.ts) — not a drain-class unit. Self-heals in place; retry-via-tools:invoke is the standing recovery. Unpark when the proxy topology plan picks it up.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21574140812992625",
      "title": "Signed Server 0.0.18 exits status 1 on pristine clean-VM first boot",
      "parkFingerprint": "9204fad1cbe4f6491ec3632563b5b4ae882f38af811f5e5e6b52e2cfb41970a0",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked on a permitted release-build + clean-VM boot-gate cycle (source fix verified 3x now, unregressed at HEAD 6e898b6cf8); unpark when papercusp-desktop version bumps past 0.0.18 or bin/build-desktop-sidecar.sh / bin/repack-deb-xz.sh changes, or when the release-build boundary is confirmed lifted.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21598928263266889",
      "title": "git-sync committed fleet launch-on-plan.ts as a zero-byte file during a live edit",
      "parkFingerprint": "4b7e9916332f9746b0c9b27fefcd8d2474f0c2966d53f901f3d08168e569600e",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21650778607314454",
      "title": "docs:search times out on required engineering-doc queries",
      "parkFingerprint": "4b68b95c35a90cef4ce1a4fb97dfe3c3914b13dacd8b45a312ea598b4b93f2e0",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21739876962689902",
      "title": "release:repair-queue tool-call failure (invalid_args)",
      "parkFingerprint": "1e3ef3f5453c01e484993919f1c011dcda80d24b0ea58f7cc9e545cb2f3a03cf",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Explicit no-new-item decision after verifier wake reconciliation; no source work or reproduction was started. Park until an explicit future scheduler directive clears the hold.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21826691153288625",
      "title": "rubrics:propose silently replaces an EXISTING acceptance rubric authored by another agent, invalidating its attestation and the revision its grade was emitted against",
      "parkFingerprint": "ddbc77999d477fdc280bd547b234ef711923974e636073f2f808f12c6cd15793",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Fleet is winding down; preserve this real open rubric-protection bug for the next implementation pass. Unpark when the fleet resumes normal DRAIN work.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21830206847941732",
      "title": "A release-audited sidecar build cannot pass on the shared tree: its HEAD-move publish guard is unsatisfiable against a git-sync routine that commits every 3 minutes",
      "parkFingerprint": "0efba64f228a5bddbf091be02d41b546f6cf8be50d369b068b4400955e3a5d06",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Wind-down after post-compaction reconciliation; pinned-deps half already landed, remaining HEAD-move guard is handed back to the fleet leader for disposition.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21832870754385692",
      "title": "Release-fixer 'newest checkpoint log' guidance can select another harness's concurrent run",
      "parkFingerprint": "9c91f5a7d03d4e373dac0809136363a91558a1e240f4b0d0c73e709cdb739ae2",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Leader superseded this repair with the P-001 evidence-only lane; do not self-select EI-218328 until the leader explicitly reopens it.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21840279029154242",
      "title": "git-sync:lock-retry event can time out after the named lock releases and sync completes",
      "parkFingerprint": "81a77d62bf473be316ef9b05e36cf72fb406a986896fbe3920c05b1afb7a5684",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Fleet pause stand-down: checkpointed current state and releasing this member claim without making a new pull; preserve claimHold until the fleet resumes.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21845797990573046",
      "title": "Fleet-read validators lack a shared fleet-scoped detail query contract",
      "parkFingerprint": "c328dea13ab010f52aa612a33750a0a647f08353ecd3459e85cafec75d45ee9c",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Fleet wind-down: checkpointed read-only investigation; leave the item parked until explicit fleet resume.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21860262943616012",
      "title": "Explicit two-file test:affected run stalls inside affected-tests.mjs for over 36 minutes with no task child or output",
      "parkFingerprint": "8e8872dfb7ffd9c03f9a49a8d20ce82090efad81c16cff1519d6c47c503b7add",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Fleet wind-down after required reconciliation and bounded reproduction; checkpoint and evidence preserved for later resumption.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21878448249294823",
      "title": "affected-tests: a task whose durable admission record fails to persist (PG lock timeout 55P03) exits 1 and is counted as a test failure, and the retry hits the same error",
      "parkFingerprint": "4d8891942588442328a1b6dc77a4f8f788cdf25435c9f326c575e0f7b2cc2027",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Deferred, not abandoned. Fixing this needs an edit to scripts/affected-tests.mjs, and EI-21845350544347182 forbids editing that file (plus pc-heavy.sh, vitest.config.ts) without a reproduced scheduler defect. The green-checkpoint gate is also currently red (75 consecutive) and owned live by su-93714fb3, so touching the shared runner now risks interfering with the active fixer. UNPARK WHEN: the gate is green (or unowned) and affected-tests.mjs is safe to touch. Evidence is complete and on the ite",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21879070086171922",
      "title": "affected-tests: timedOutTasks under-counts — the task with the MOST vitest timeout signatures (9) did not increment it, so a timeout-dominated red is reported as an indistinguishable assertion red",
      "parkFingerprint": "d518b3e1cfd8fcf48e87af0cdec98a48d7426c0e97a9ef11a4b86953a436a744",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Deferred, not abandoned — same gate as EI-21878448249294823. The fix needs an edit to scripts/affected-tests.mjs, which EI-21845350544347182 forbids without a reproduced scheduler defect, and the green-checkpoint gate is red (75 consecutive) and owned live by su-93714fb3. UNPARK WHEN: the gate is green or unowned and that file is safe to touch. NOTE the evidence got sharper today: the 9 timeouts this item is about are now KNOWN to be collateral of 3 assertion failures in affected-tests-budgeted-",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21900917015282132",
      "title": "Focused test lane can yield at the 30s heavy-slot boundary",
      "parkFingerprint": "ae2179b84241941d48df969f12efb522ba487fc3b1a6ba79659328649b7e2c52",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Fleet pause stand-down after completing the current read-only diagnosis; preserve durable claim hold until the leader resumes the lane.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21902342018364206",
      "title": "Host memory PSI and blocked-process pressure observed during P-008 wait",
      "parkFingerprint": "d9f9f8958b113fcc4d4a550fa61d0ebc53b29af9e27f0436f250a1962eb16bea",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Corrected mechanism and evidence are checkpointed; P-046 owner su-064f is the fix owner. Park until caller guard/test and second-cut verification land; avoid duplicate investigation.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21949915395361184",
      "title": "Result-door spill files add framing and footer text that breaks JSON consumers",
      "parkFingerprint": "e9fde168cf460dbda111f8d409b30aadf3427c1218ca791b4406899f54bc4e32",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21977856051718176",
      "title": "scheduler:get_next reports a claim cap against a newly changing 'Queued inference admission' receipt even after the…",
      "parkFingerprint": "feb346d5c272a51022ad6ea89471a5eff8c64f2752fb916c6408b697fe143a18",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Typed live-dependency blocker is recorded; release leader claim while waiting for deployed scheduler to include the staging receipt-filter fix.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21985109959023423",
      "title": "deployed release:repair-queue lacks source converge operation",
      "parkFingerprint": "3ae6d1cefd0ab1cbb9f891822077dfd141043eb287ea143db13296beea7659d3",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-21995168909138861",
      "title": "tools:find tool-call failure (attempt-timeout)",
      "parkFingerprint": "99908c14a6cf1f9beb9b7bfc0ea0cb136e1ba23455bdf02ba784b5e40851387a",
      "lease": {
        "by": "su-6c382a1c-8a44-4f18-9434-d5a7dd2f65be",
        "reason": "blocked",
        "at": "2026-10-07T07:26:49.067Z"
      },
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Re-evaluate whether this reporter/runtime identity case remains active when the owner scope answer arrives or new reporter/invocation evidence appears.",
        "owner": "su-6c382a1c-8a44-4f18-9434-d5a7dd2f65be",
        "trigger": "conversation:answered:conv-muxpnf5l-0000-9b2d5bd358f245289a0fb53f3c148101",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-22087522698744146",
      "title": "frozen-candidate-repair-queue wait-for-fixer has no progress/turn-liveness guard at attempts>=1 — a parked-but-heartbeating release-fixer holds the frozen candidate until the 8h wall clock",
      "parkFingerprint": "4b348b4a24d2e95b55a92f83f77991331431352dbfcd94866a68b8e2d636b509",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-22126055661840542",
      "title": "Live cloud portal renders soft-404 panes because it embeds /portal-panes/* from :3070 (green operator), whose bundle predates those routes by 13 days",
      "parkFingerprint": "14707a97fd9a2066d1d0f29578ec5d0471ae7a050071f9681574bd4709985342",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked on WI-212675 (green-checkpoint gate red streak, 94 consecutive reds) — unpark once dev:pipeline_position for apps/operator-vite/src/routes/portal-panes/chat.tsx shows positions.deployed:true or the gate reports green.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-22136767702523358",
      "title": "routines work-item-admission-delta-sweep / work-item-admission-promoter fail with \"The usage limit has been reached\" after 2 retries on papercusp-bg-host",
      "parkFingerprint": "3b39e38f51abbb22d2a9df3bb3fe10b5eadb35142ed02202981dfd21e7ffadc4",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked on green-checkpoint gate promoting+deploying fix commit b0c90a607 to :3070; re-claim once dev:pipeline_position shows deployedSha past b0c90a607",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-22154020611570329",
      "title": "Work-item admission promoter is stale for papercusp",
      "parkFingerprint": "ce55e330cc333aec3770b79c69f6bb3b09537e797f7be72313e6ef06401bde0f",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Diagnosis complete and fully checkpointed; blocked on an external codex capacity wall (ref capacity:codex-usage-limit-reached/work-item-admission-promoter), linked caused-by EI-22136767702523358. No engineering work is actionable until codex capacity returns, so parking it out of self-select rather than stranding it on my claim. Re-claim by id when accounts:probe-capacity { provider:'codex' } shows a non-empty unwalled/serving.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-22172165391844433",
      "title": "A fleet member whose only output is a provider quota refusal reads as live+working on every liveness surface",
      "parkFingerprint": "21eb4881a371ae7f5e72af61e8136accedbb2ca272d2da3bffe023c0c2dfd49c",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-22184290586148280",
      "title": "workspace-host release gate: privileged-conduits check passes on clean-room evidence while no provisioned host ever gets the conduits",
      "parkFingerprint": "d8bd15d2882a23e38757a6283fc9ebb9dcc9f65419ec19a215fbfdc9736282bf",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-22190822851012325",
      "title": "work-item-admission-promoter fails its whole tick on account starvation and silently degrades duplicate screening to the 60-minute fail-open path, with no signal that screening stopped",
      "parkFingerprint": "9f5af569e9abe25c333eaac656d8d6186fd1f84c0311d2eb88aa67b5a2256555",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-22191295137734941",
      "title": "wake-pump delivery rendered a bare `/clear` slash-command as user speech in the same envelope as an await-event payload, with the provenance hook reporting a hash mismatch",
      "parkFingerprint": "5433b2c4f8aedf542254c366d4326181d2b7f24f06a1119c5301df7631ec53c2",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-22201349964242175",
      "title": "work_items_claimable still costs 11.4M buffers per read — migration 1100 parallelized the work, it did not reduce it",
      "parkFingerprint": "c661514e42be654caf98fd08ba0e339efbb0056d4998b7e7b8dcc52ddbc8f18f",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Superseded by tracked plan work (work-item-claim-floors-batch-rewrite-2026-09-03, linked via plan_item P-001) — a multi-hour architectural redesign, not a quick DRAIN pull. Two DRAIN wakes already re-diagnosed and released this identically; holding it out of self-select to stop the churn. Unpark condition: work the plan's P-001..P-005 items directly; close this EI (citing the new post-redesign buffer measurement) once P-005 lands, or clear the hold if the plan is abandoned/superseded.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-22269006575539289",
      "title": "Portal TypeScript boundaries lack production-consumer and wire-contract pins, allowing declared data to be unreachable or drift silently",
      "parkFingerprint": "140606318c0c058b1b823ada8165d8912a3be4457445761245f90f3e939999c5",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "BLOCKED ON A VERIFIED OWNER PAUSE, not on difficulty. Diagnosis measured TRUE at portal HEAD 54e6ed39 — all 3 members real and open (shell.tsx:861 passes no onTurn and zero tests mention it; handle roomName has no production reader; WorkspaceStats declared in 4 files across host/UI). Not implemented because both asks are product decisions the owner is actively reviewing: owner-typed turn 2026-09-03T11:39:55Z \"after writing the plan show it to me for my review then pause yourself\" (session_turn:c",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-22351774127289970",
      "title": "Workspace-host operations lack a durable reconciler that drives cleanup, readiness, and billing obligations to verified completion",
      "parkFingerprint": "071414b74be86d11e2aabdd09d4147d511834ff165d5ce24ee4096ec17c73d58",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-22365715996548478",
      "title": "GOAL-mandated cross-harness fleet:launch-on-plan is rejected by the holder session's hive scope",
      "parkFingerprint": "2c48036aa073b862aec1333e07e9726ac20e1b2169ccfcdd1dfaccc6cd7ffbc1",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Do not self-select: nothing implementable. Fix already on staging (8335fafe82); blocked purely on promotion. UNPARK WHEN state:read { cell:'deploy.3070.sha' } no longer returns 6e898b6cf88316fcf1574f049554a6caf16318f0 — then verify and close. Do not take the green gate: held live by su-29689cbe (WI-212675).",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-22365947616851657",
      "title": "Performance regression history is stale and current route/CSS coverage is incomplete",
      "parkFingerprint": "cd53ef28412fc2cf60f637f6e48c5c5f3cb40a6aab3a82703cab039346181a85",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Promoted plan P-001 WI-10002823 and P-007 WI-10002829 are terminal with backend performance freshness and native route coverage verified; then settle this older parent issue without duplicate work.",
        "owner": "su-e7e09464-ab82-49e6-aa65-c02b2594724f",
        "trigger": "work-item:done:WI-10002829",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-02 20:26:38.201148-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-22389690972438581",
      "title": "WOE drain holder broadened positive goal claim spec after zero-match refusal",
      "parkFingerprint": "7a5f831aa3d9eaa1c57ac23a105548caf1284f46a4cd4585e761848b7cb44409",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-22454855871337477",
      "title": "work_items:complete tool-call failure (invalid_input)",
      "parkFingerprint": "360cb26be398a64976e6e75e3d2f43ed5f35ad3fcf74904e674a2d6f8c862dd9",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked on the explicit deployed-only gate/live dependency gate.greenCheckpoint / release:deploy; preserve the item for re-placement after a fresh green promotion and deployed runtime exercise.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-22463621859793399",
      "title": "scorecards:emit on production cannot resolve rubric applied and readable on staging",
      "parkFingerprint": "f17a2800e374d882383ffa430d12d77081e6397d223744a4f1704955ac8626c6",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "A normal green-checkpoint verdict for target 6fe401a2e1d811b51f4d931d30ccbbf7796a0bb0 is recorded and the target is eligible for promotion; then resume exact release trace and post-promotion rubric A/B.",
        "owner": "su-41d804b2-2752-4a24-b5f9-958b4078ed1b",
        "trigger": "release:green:papercusp",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-02 06:54:23.659806-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-22534455599889250",
      "title": "[gate-red-streak:papercusp] Re-green current 9aa9e788 candidate and restore staging promotion",
      "parkFingerprint": "1ef69fe3b5e997b70cb47ea6a8f30ec329d5ccb3bceb8d03b150ae35826cb9b5",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The non-terminal qualification transaction ff5deff9c2be4313ca385534 ends; reconsider only if papercusp has not reached a green verdict.",
        "owner": "current green-checkpoint qualification",
        "trigger": "release:green:papercusp",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-02 06:54:23.659806-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-22561332581031302",
      "title": "dev:pg_query unbounded tool-invocation JSON search times out under tenant scope",
      "parkFingerprint": "4ba21d4e90eec5d47463b32cd51986fc7e19ae37dedde2388672e44e7ecf8393",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Fleet leader repairs or reassigns EI-22561332581031302 so its current title/payload and checkpoint refer to the same incident; then re-read all identity fields before closure.",
        "owner": "su-745536c5-c15c-495c-9880-0e2e03f5fe68",
        "trigger": "work-item:status:EI-22561332581031302",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-12 20:44:32.324635-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-22573378735962647",
      "title": "checkpoint-run qualification transaction conflict leaves repaired head unjudged",
      "parkFingerprint": "d375de677937909bc6f70b013486a22059b8e5a76d84b28a9bee6c2e24d34c3d",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "The live gate owner completes EI-22573378735962647 and the item emits its done event.",
        "owner": "su-a5dc537f-e81a-4d94-935a-d0cfb121d4d5",
        "trigger": "work-item:done:EI-22573378735962647",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-22612198786401976",
      "title": "admission-pending claim remedy is blocked by work_items:create duplicate identity",
      "parkFingerprint": "372b2301b4016b9a6354d83007003c66f7daef9b2704b24b9873eb7452e70f2c",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Owner-directed system-wide pause is lifted and this lane is explicitly resumed by the fleet leader or owner.",
        "owner": "su-8b26009e-a5c7-4653-93df-5c9c0e372194",
        "trigger": "coord:inbox-wake:su-8b26009e-a5c7-4653-93df-5c9c0e372194",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-08 19:44:39.538136-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-22624091515777603",
      "title": "Installed PUI real Claude greeting does not render a correlated reply",
      "parkFingerprint": "ed067f8aeb86b2d1249b9c94c1b28da9fc8ed9504596b3c9f4eb41776fe29c18",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "The active provider:claude-default-weekly-limit blocker is cleared or an eligible Claude provider route is available for the documented PUI_REAL_ENGINE acceptance.",
        "owner": "provider:claude-default-weekly-limit",
        "trigger": "work-item:unblocked:EI-22624091515777603",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-22636478173319782",
      "title": "plans:audit tool-call failure (bar_requirement_parse_failed)",
      "parkFingerprint": "745585da1184e4c5c9398fc18d289efe6bdeaff45f49718289f27dfb51fe08bc",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Sibling EI-22636613539857225 completes the shared plans:new acceptance-BAR validation fix and this duplicate item can be verified/closed.",
        "owner": "su-04436973-b490-4123-9cd9-bca7ac89189c",
        "trigger": "work-item:done:EI-22636613539857225",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-08 07:03:56.941301-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-22652026189997504",
      "title": "P-305 carried lifecycle subnet was removed before the managed real-host run",
      "parkFingerprint": "09d87b8c635ca8d207cadc19eb2583658fad5998649e73c734f7b756204b0044",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Fleet byoc-alpha-ship-2026-09-05 resumes after owner-directed system-wide quiesce",
        "owner": "@fleet-leader:byoc-alpha-ship-2026-09-05",
        "trigger": "fleet:byoc-alpha-ship-2026-09-05:resume",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-22654192845271658",
      "title": "P-305 bootc GCE host never becomes OS Login ready over IAP",
      "parkFingerprint": "46e0286c2dc0d317290e07bdc05f65afe1ce55b7ed2442169d4a6cfb00ee67c1",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Fleet byoc-alpha-ship-2026-09-05 resumes after owner-directed system-wide quiesce",
        "owner": "@fleet-leader:byoc-alpha-ship-2026-09-05",
        "trigger": "fleet:byoc-alpha-ship-2026-09-05:resume",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-22658739524772526",
      "title": "SharedMap constructor creates absent LMDB during read probe",
      "parkFingerprint": "ca63fdde3a50128574323c6f100c2e8724cc68ccefb54e62553979f645d7b9a6",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "An approved Storewolf-Libs checkout or canonical mirror/edit lane is established and the external-repository-scope blocker is cleared.",
        "owner": "fleet leader su-4fe9b076-cea9-457b-97d1-1c61bcf6f5e9",
        "trigger": "work-item:unblocked:EI-22658739524772526",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-22689667926628326",
      "title": "Windows VM SSH banner unresponsive during native archive diagnostic",
      "parkFingerprint": "5cb7c177c01542e5a4e83f6783f455927b163654f8c6bd21ddb7262327fffff1",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Governing P002 acceptance work WI-10000249 reaches a terminal outcome; then re-evaluate this historical SSH diagnostic item.",
        "owner": "su-71c97257-a2e8-4068-b9a7-5493f43aae62",
        "trigger": "work-item:done:WI-10000249",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-22728510169731463",
      "title": "Staging API listens but stops accepting while gate repair waits for current-build reload",
      "parkFingerprint": "09c24b4197fabd9679dfc0b62b7f83eac278e690475b6577a89ba2da572aa064",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Avi issues a new owner-verified RESUME after the 2026-09-08T23:40:15.756Z system-wide pause",
        "owner": "Avi",
        "trigger": "owner-resume:papercusp-pause-20260908T234015Z",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-09T07:56:48.957Z",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-23072498415228085",
      "title": "Manual Codex lock mode still auto-acquires PreToolUse apply_patch locks",
      "parkFingerprint": "eafad1ffd7cadd49b97aa6bca9fde8e79d588146d4a7b241de52f70ba0cf4024",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "WI-10004473 is terminal and su-372cf034 has been restored on canonical gpt-6.1-sol:xhigh with its carry verified",
        "owner": "su-63e07693-3cd0-4c55-af38-0b39889b93ed",
        "trigger": "work-item:done:WI-10004473",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-23089691512961732",
      "title": "Deployed work_items:complete schema is stale versus current v2 contract",
      "parkFingerprint": "34d7c2f84554f334800cf6db0fd2beaf9f5198dc7e5e6691aceb356ce7c75d6d",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Release owner promotes a v2-containing staging commit to green main and deploys it; then the deployed work_items:complete v2 probe can be rerun.",
        "owner": "release owner",
        "trigger": "release:deployed:<sha>",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-23104872088967928",
      "title": "Exact P-003 affected gate has four remaining shared-tree red clusters after CLI-entry repair",
      "parkFingerprint": "f29d49a3dd72e67b556362574a7614df0ac0cad1eaa75802ac21dab3aadc1293",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Owner lifts the system-wide stand-down and asks the exact R6 gate to resume",
        "owner": "owner",
        "trigger": "coord:inbox-wake:su-4681f418-2a55-4162-8664-aa50343f109e",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-14 11:50:15.906572-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-23114289156469178",
      "title": "work_items:complete tool-call failure (invalid_args)",
      "parkFingerprint": "0facfe199c31d77aa9f6478a48fb9b910e4cefb2fe1111a77ed05d25b10dea5f",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "The source v2 completion contract is present in the deployed runtime and release:trace confirms the tested SHA equals the deployed SHA.",
        "owner": "su-494456e1-2cf7-4ac1-afbd-2ddcd54827a1",
        "trigger": "work-item:done:EI-23114289156469178",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-23114970667874892",
      "title": "work_items:complete rootCauseVerification schema rejects required contrastive evidence fields",
      "parkFingerprint": "96095e4cb915d27b394e22b2fca8371c3ff720e68612ce7ab71e8ffeff97a950",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Predecessor EI-23114289156469178 receives deployed-only verification or this duplicate is explicitly re-routed by the fleet leader.",
        "owner": "su-494456e1-2cf7-4ac1-afbd-2ddcd54827a1",
        "trigger": "work-item:done:EI-23114289156469178",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-23118301286086331",
      "title": "Deployed work_items:complete schema lags current v2 completion contract",
      "parkFingerprint": "46d237468860bf2e2ddaf055e8c67a54040249cd273558c4d866f35fb44b51d9",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "WI-10000288 reaches a terminal state after the registered gate owner evaluates and ships the first eligible candidate containing staging b95853141c; the next claimant must still rerun the default-endpoint v2 validateOnly probe.",
        "owner": "su-76ef8aec-d9fd-49d3-b6b8-f9473d9e560d",
        "trigger": "work-item:done:WI-10000288",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-15 22:24:42.843892-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-23128731257365930",
      "title": "Live evaluator schema is stale versus current replay implementation",
      "parkFingerprint": "81d4cb1e14a6369b5115c49cc456c7f35f94d20ddf96d11658a23231c980c671",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "WI-10000288 reaches a terminal state and a fresh default-endpoint replay probe can determine whether the live evaluator accepts specRevision/specFingerprint/replaySnapshot.",
        "owner": "su-76ef8aec-d9fd-49d3-b6b8-f9473d9e560d",
        "trigger": "work-item:done:WI-10000288",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-15 22:24:42.843892-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-23131698743858234",
      "title": "Default operator testing:run rejects canonical harness and recheckReason fields",
      "parkFingerprint": "61bf11e7a798da6a59726c07c4aad491f44299418d0aa47b996b266c77ab4e75",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Default operator deployment has advanced past e66be3c4ff and testing:run accepts harness plus recheckReason.",
        "owner": "su-76ef8aec-d9fd-49d3-b6b8-f9473d9e560d",
        "trigger": "work-item:done:WI-10000288",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-15 22:24:42.843892-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-23216061848335411",
      "title": "Current-host release:repair-queue dry-run exceeds MCP transport and returns unknown outcome",
      "parkFingerprint": "bb05c6c3a6e84fdbd301707afb4db4099bba55db9ced793b37686adadeb9afc6",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The live repair-queue owner releases the deployed-only control-plane lane and the queue is ready for a non-duplicative replay decision.",
        "owner": "su-76ef8aec-d9fd-49d3-b6b8-f9473d9e560d",
        "trigger": "release:deployed",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-02 08:06:29.847347-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-23342012907179632",
      "title": "work_items:complete tool-call failure (invalid_args)",
      "parkFingerprint": "ee06f432e0f15ff4faa1a83c30e1d032814d0137de46876f3ab5f2770d79d644",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The exact schema-change commit 5ffe830060c19274d7c76e86ebaad229f56eaa72 is deployed to Papercusp :3070; then rerun validateOnly for completion.verification.workOutcome and record the result.",
        "owner": "su-4ae71ea2-7d7f-4e34-919b-6c4668f2dbb7",
        "trigger": "release:deployed:5ffe830060c19274d7c76e86ebaad229f56eaa72",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-25 10:58:50.775746-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-23379068490085254",
      "title": "51.6% of the catalog's 1.22 MB argSchema wire cost is .describe() PROSE (627 KB) — ungoverned; and the $ref fix is refuted, the lever is prose + the single/batch duplication",
      "parkFingerprint": "867e0e3cc5bacffb1e07475d4107f21d0a5f22a62ccfb5d96173eda80387ec5d",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "The owner rules on the D-001 structural fork in conv-mu47zp1k-0000-0094b5901ea24864bba8bd534a05990a: either (A) ratify a higher wire ceiling, or (B) hold 256 KB and authorise cutting spine tool NAMES. Until one of those lands every composition-preserving route is measured-dead and there is no agent-side work that can advance this item — a claimant would only re-derive three refuted levers. Full state + resume contract is on the checkpoint.",
        "owner": "su-5115b977-3de4-4cad-b8ed-5f3144c05048",
        "trigger": "conversation:answered:conv-mu47zp1k-0000-0094b5901ea24864bba8bd534a05990a",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-23890073128532843",
      "title": "loop:end reports fired composed-root anchors as surviving awaits",
      "parkFingerprint": "cfae7a9a17e93c6847f29ef159b748c9be037fe3967565235c0f7be2161a8139",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The linked blocking work-item WI-10002662 reaches terminal state so this implementation can resume.",
        "owner": "su-143d8d53-95ec-40df-988f-dfec83c2017f",
        "trigger": "work-item:done:WI-10002662",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-27 05:19:46.884229-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-23898141191931290",
      "title": "Hybrid owner-directive capture has never captured anything in production — orders:capture-pending is undeployed and the hook swallowed every failure silently",
      "parkFingerprint": "76c8f02903d1b0cb935d5079e47079c534ad4ed43e1e70ebcd6adce824b4812e",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The staging commit currently recorded for this item reaches :3070; then verify orders:capture is registered and clear the blocker only after successful verification.",
        "owner": "release-gate",
        "trigger": "release:deployed:457f3c14612ce75edc66f0f8d1bc31d36aa0c7fe",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-25 10:59:00.880731-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24049475385752228",
      "title": "Grading-audit cascade double-dispatched two auditors for one scorecard (EI-24048956071430282) — reservation lease did not hold across a transport drop",
      "parkFingerprint": "2bdde314f5f05bc3bcb6839875732c8011aba4120df4fece0ee6259d4a58370e",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "A newer explicit owner resume has been verified and the reservation-epoch candidate in EI-24042135255703680 has been revalidated; only then may this item be reconsidered.",
        "owner": "owner",
        "trigger": "coord:inbox-wake:su-0c70ddfa-7079-4d85-a05e-b58db9363712",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-24 17:01:02.829171-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24049493019209339",
      "title": "Grading-integrity audit double-placed: consult fork launched for EI-24048952049646665 while a reserved auditor settled it 4 min later",
      "parkFingerprint": "cb22f864cd0194fa70bbeab0314da64a11ec4c5f0c13debd7f6036937a85ff40",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The overlapping reservation-epoch fix is completed; re-check whether it prevents a second auditor from being recruited after the first reservation owner settles the exact card.",
        "owner": "su-aae8dddd-6fde-4c86-bd73-6e4710c75bc7",
        "trigger": "work-item:done:EI-24042135255703680",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-23 20:02:34.241218-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24126173486972791",
      "title": "Canonical task-manager store integration suite reds on asynchronous task-terminal event warnings",
      "parkFingerprint": "548cf5bf5b4858392fc770c90bb149abd73783b9338072b2168f753de8d9e083",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Avraham explicitly resumes this session or schedules the async terminal-event integration bug",
        "owner": "Avraham",
        "trigger": "coord:inbox-wake:su-41305f47-7c06-49e9-90f1-23bea142fbd0",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-27 01:22:35.776485-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24135275786510268",
      "title": "P-001 adequacy source fingerprints include mutable whole-plan evidence report",
      "parkFingerprint": "d4fe1f789993ba23be7ad057e3864f22dcab7db24ec045a2c1e7e5463000416f",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The existing P-001 repair WI-10002823 is terminal; then re-check whether EI-24135275786510268 is fully covered and close as a duplicate if it is.",
        "owner": "su-e7e09464-ab82-49e6-aa65-c02b2594724f",
        "trigger": "work-item:done:WI-10002823",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-26 19:24:08.882189-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24136843101349997",
      "title": "Lifecycle judge selects permanently retired mug role and can never launch",
      "parkFingerprint": "b071c751385ddfba8741689380063e1d46cdbc09b5cc273c400421787ea4bda3",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Avraham explicitly resumes this session or the D-011 lifecycle-judge acceptance lane",
        "owner": "Avraham",
        "trigger": "coord:inbox-wake:su-41305f47-7c06-49e9-90f1-23bea142fbd0",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-27 01:22:35.776485-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24153986934343683",
      "title": "Intermittent empty Claude UserPromptSubmit output in isolated native GOAL hook integration",
      "parkFingerprint": "b3c5a1ef53efd461f52c40e39a539a71e9f344c0dbba243a3ce2f5e9a7ff98d0",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "A new concrete recurrence or distinguishing stage-level diagnostic is attached to EI-24153986934343683; re-read the checkpoint/comment and explicitly clear the hold only if it adds evidence beyond the current request-start, receipt, elapsed-time, and cursor snapshot.",
        "owner": "su-ef6886ef-be73-4be0-93c7-1b21aedcd73f",
        "trigger": "work-item:status:EI-24153986934343683",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24186314282539757",
      "title": "orders:clear is documented in session instructions but absent from the runtime tool catalog",
      "parkFingerprint": "9652dfd89b8e3f37486cf1e19860c1b098617f2f0e412aea8a1f196a97274a97",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "WI-10003058 reaches terminal done, ending this system-wide pause.",
        "owner": "su-0bee59ae-2be5-416f-ad19-ed758492e106",
        "trigger": "work-item:done:WI-10003058",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-24 19:45:17.694811-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24226528944019664",
      "title": "Green-checkpoint cgroup runs pinned at memory.max (1432 max events, ~40GiB peak); unmeasured candidate cause of wall-clock test flakes that turn the gate red",
      "parkFingerprint": "c163b39c975b591cd69656e03ee8666706b8fc85e02d12a9ed06746ea9a9b2da",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "WI-10004717 is completed; re-read its terminal evidence and this item, and resume only if it contains new per-test timing paired with cgroup memory.events/PSI or a recurrence.",
        "owner": "su-f35e5c5a-3d93-40aa-b5bd-864f3c31519b",
        "trigger": "work-item:done:WI-10004717",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24359373316570369",
      "title": "Git-sync restart barrier lease expires at 60 seconds inside the supported 120-second drain",
      "parkFingerprint": "178de9785a6fb9bff4be205f0bf273f3de1ca4cb78e3a57cf793428ebe67c80a",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "WI-10001893 records a successful guarded bg-host restart using the corrected lease and verifies the live r54 controller",
        "owner": "WI-10001893",
        "trigger": "work-item:done:WI-10001893",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-01 14:22:22.812709-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24363753174870397",
      "title": "Fresh managed carry executes actionable nextAction during its loading turn before the benchmark task arrives",
      "parkFingerprint": "fc775a47eeef0d0de0b85dcc09c8291a6dc11e7edf35084dec2ed9711b2a792b",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Qualified current-source native carry-cohort proof is recorded by WI-10002839 owner and the skipped, drifting local attempt is superseded.",
        "owner": "su-ee7d4dd8-897e-4d8c-97a3-bceea7cb0749",
        "trigger": "work-item:done:WI-10002839",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24373052706582252",
      "title": "Canonical PUI acceptance scorecard cannot emit: five-file deterministic check exceeds 13-minute watchdog",
      "parkFingerprint": "56a1cc59f203cc4ca3a092b964d2e7a70654980ef695b63344e3ba3ef834e30f",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "WI-10003403 Docker host create/start blocker reaches a verified terminal fix and stock Ubuntu/Debian smoke succeeds",
        "owner": "WI-10003403",
        "trigger": "work-item:done:WI-10003403",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24526883774548932",
      "title": "papercusp-su MCP client returned ECONNREFUSED for ~1-2 min while :9071 and :3070 /api/health both answered",
      "parkFingerprint": "3b2836391575432b6cfbf687bda5fb0b5060544e2398235142c784d7bf27f4df",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Re-evaluate this Sep 28 incident after WI-10004525 records measured native Codex MCP endpoint and refusal-reconnect findings sufficient to compare its historical client path.",
        "owner": "su-c6ebfcdb-4118-495d-bbfa-d83998682668",
        "trigger": "work-item:done:WI-10004525",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-01 03:08:22.07121-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24732816653944961",
      "title": "Orientation fires 'MCP TOOLS NOT REGISTERED — 0 tool calls in 90m' on a judge session whose tools work (a false alarm)",
      "parkFingerprint": "fbc18b8772e5115f19d66e78354714ed6840eef16a735982dab77d7d82b2f36d",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The shared MCP-dark detector correction under EI-24732297217951452 has completed; re-evaluate this corroborating report against the corrected behavior.",
        "owner": "su-c6ebfcdb-4118-495d-bbfa-d83998682668",
        "trigger": "work-item:done:EI-24732297217951452",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-01 01:21:50.440122-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24732893599146488",
      "title": "coord:inbox (no args) via tools:invoke hung >120s for a judge session",
      "parkFingerprint": "aa1fa2c34e662fb65277a9b88b26405aee1157aa106ef950c9a808104dccb309",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Recheck and clear this park only after authoritative judge-principal request lifecycle evidence or a controlled reproduction is recorded and the external blocker is verified cleared.",
        "owner": "su-913e9e24-5840-4b81-81ee-0b6e0837306a",
        "trigger": "work-item:unblocked:EI-24732893599146488",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-01 08:57:09.824983-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24734613404917991",
      "title": "MCP proxy :9071 returned ECONNRESET (outcome_unknown) on a code:run wrapping scorecards:emit during grading audit",
      "parkFingerprint": "6422018669f215aaa66ae6e3c921545d6a5d166c8e5b73eb0b8cd95b3c363ba5",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The sentinel implementation item completes; recheck this exact reset trace for worker/request attribution and decide whether independent proxy work remains.",
        "owner": "su-aeaf3fad-4ab1-4c0b-b013-b5fb78c5f986",
        "trigger": "work-item:done:EI-24744827222668206",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-01 01:31:50.983942-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24734701627372225",
      "title": "papercusp-su tools:invoke/tools:find transport tool-call failure (transport-send-error)",
      "parkFingerprint": "b3e89c3894cbc5ea0ce445071cddd965b367dfb7fb83e65de895b685886e8af6",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Reconsider this investigation only when direct request-identity evidence is available or the current fleet leader supplies a scoped route; retain the existing blocker until one of those conditions is met.",
        "owner": "su-c6ebfcdb-4118-495d-bbfa-d83998682668",
        "trigger": "work-item:unblocked:EI-24734701627372225",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24734764483393480",
      "title": "code:run nested tools finder unavailable",
      "parkFingerprint": "236f1064d8c99a5076768651a5c04eb242655a78397d28c8dc37393cd180b0e0",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The active route investigation in EI-24404095648820288 reaches terminal; then verify whether its resolution covers this code:run/tools:find transport report.",
        "owner": "su-e6b3c00e-8f89-4702-b90f-126d8c4fcf97",
        "trigger": "work-item:done:EI-24404095648820288",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-01 03:08:30.926565-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24736916827820706",
      "title": "papercusp-su/tools:invoke tool-call failure (transport-send-error)",
      "parkFingerprint": "530741dd80bdb70d322c5958d4f99c23cf16ddd60a5efbd740e5ba8c0099dcee",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "The live owner of EI-24734701627372225 completes the same direct MCP transport investigation; then re-evaluate whether this separate report needs independent work.",
        "owner": "su-fd7898d2-6701-40dc-89cd-0711aaf115ba",
        "trigger": "work-item:done:EI-24734701627372225",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24736998768322011",
      "title": "papercusp-su MCP transport tool-call failure (TransportSendError)",
      "parkFingerprint": "8910d6fa85a2512950240bc92c82d34fb1a51ded0c8835b3a0c1f8d5fdb56ce6",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Reconsider this report after EI-24734701627372225 reaches terminal state and its root-cause evidence addresses whether the earlier 01:02Z :3170 direct-MCP failures share that cause.",
        "owner": "su-fd7898d2-6701-40dc-89cd-0711aaf115ba",
        "trigger": "work-item:done:EI-24734701627372225",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24737060549200876",
      "title": "Papercusp MCP transport refused three valid reads to staging :3170",
      "parkFingerprint": "1c96e0e3802ef680e42df271f9ed6a581d0ed81b06a9a3e757cf7827c125e89e",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "The owner of EI-24734701627372225 records a terminal correlation outcome that states whether the 01:02Z failures in EI-24737060549200876 share the later :3170 restart cause; then reassess this report for duplicate or remaining root-cause work.",
        "owner": "su-fd7898d2-6701-40dc-89cd-0711aaf115ba",
        "trigger": "work-item:done:EI-24734701627372225",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24737171007134326",
      "title": "[self-imposed] BAR method/rubric repair is sequenced after P-005 so it is written against as-built code; do not let…",
      "parkFingerprint": "988d7e9c3fdf34592ce782288e0b243dab3be16d84b6eed13daaaf4429811f64",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Owner answers the R-1 A/B ask",
        "owner": "su-b96d9ec7-fc10-46cd-b6c3-d48879793d32",
        "trigger": "conversation:answered:conv-mup4wikj-0000-a93f7637013944dcb0c1b84507390543",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-02 05:51:01.823796-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24737692217941901",
      "title": "papercusp-su/tools:invoke (including tools:find discovery) tool-call failure (transport-error)",
      "parkFingerprint": "3809834ab6c684d77b270ee5c360936ecef2d81988374178a73a3e5a4e9e0fcd",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "WI-10004525 reaches terminal completion and its result can be compared to EI-24737692217941901.",
        "owner": "su-c6ebfcdb-4118-495d-bbfa-d83998682668",
        "trigger": "work-item:done:WI-10004525",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-01 03:08:22.07121-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24737744910482104",
      "title": "tools:find tool-call failure (TransportSendError)",
      "parkFingerprint": "46aa146f4ef99d79a1ca1b5d11c07e667501654b69c97172d06791642f66a6b6",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "EI-24734701627372225 reaches a terminal root-cause finding, allowing this 01:12Z report to be re-evaluated for duplicate versus independent cause.",
        "owner": "su-fd7898d2-6701-40dc-89cd-0711aaf115ba",
        "trigger": "work-item:done:EI-24734701627372225",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24738131779428103",
      "title": "coord:send tool-call failure (mcp_proxy_upstream_error)",
      "parkFingerprint": "5561c7f73aecdb47b0a52d8f3bd7b0ecfba1cebd8e52d8308ca0b93de7d6b73c",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "WI-10004525 reaches state done; reassess EI-24738131779428103 against its completed Native Codex MCP recovery-proxy findings.",
        "owner": "su-c6ebfcdb-4118-495d-bbfa-d83998682668",
        "trigger": "work-item:done:WI-10004525",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-01 03:08:22.07121-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24740175833169816",
      "title": "MCP-dark orientation infers missing tool registration from zero-call telemetry in healthy judge sessions",
      "parkFingerprint": "00c50b73f5bae0b3f52399c55504efa80be27ddf39af943cd4bb2aa2438909f3",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The active same-root-cause investigation on EI-24732297217951452 reaches a terminal finding, allowing this aggregate report to be checked for distinct residue.",
        "owner": "su-7777eea6-6f36-4175-bbfa-a05dfcbccfda",
        "trigger": "work-item:done:EI-24732297217951452",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-01 01:21:50.440122-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24741227610433110",
      "title": "Shared :9071 upstream socket-reset burst interrupts grading MCP calls at 00:25Z",
      "parkFingerprint": "8b81b4dcbfc149b2dd93ce911467bb01654e437f34171e1205de7b06771ccdf0",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "WI-10004513 is marked done, so its related source fix is complete and this overlapping incident can be re-evaluated.",
        "owner": "su-1828c628-49bf-483e-93b2-a4a1de76dcf2",
        "trigger": "work-item:done:WI-10004513",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-02 13:32:59.411138-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24743928524063064",
      "title": "facts:list tool-call failure (data_plane_may_be_degraded)",
      "parkFingerprint": "ec148a9850f50c2755c32f7e9959ea85407a6c6982345d3a2a6a6b66dedd65e2",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The reporter or retained invocation history supplies the exact scope, key, and response payloads for both original facts:list calls, allowing the false-negative claim to be verified or withdrawn.",
        "owner": "su-aeaf3fad-4ab1-4c0b-b013-b5fb78c5f986",
        "trigger": "work-item:status:EI-24743928524063064",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-01 02:08:45.010698-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24744137224899170",
      "title": "Transient operator event-loop wedge recovered without a unit restart",
      "parkFingerprint": "d9207bcd8c763b07335405c1790fafe2999063c18237dc0adecff80b683ab5aa",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "A service-health DOWN transition for operator indicates a live :3070 failure window; inspect the sentinel log immediately and capture the current Node PID before the 20s kill threshold. A short worker respawn may finish between health ticks and emit no edge.",
        "owner": "papercusp service-health tick",
        "trigger": "service:down:operator",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 14:57:08.522862-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24746543990815240",
      "title": "papercusp-su tools:invoke transport while calling work_items:get tool-call failure (mcp_proxy_upstream_unavailable)",
      "parkFingerprint": "b8da5fcd943315dd1316fc7f9e984f031bce18bfc539e1a08b7c487132198057",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "EI-24734701627372225 reached terminal resolution so this exact 03:34 capture can be correlated before re-claiming.",
        "owner": "su-fd7898d2-6701-40dc-89cd-0711aaf115ba",
        "trigger": "work-item:done:EI-24734701627372225",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24748485635209632",
      "title": "docs:search via tools:invoke tool-call failure (timeout)",
      "parkFingerprint": "fbce5e3678a2e332a08beeecfa1444a6901d3a5ae302ae090e5258c95847412f",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "A new attributable invocation/runtime record or a fresh reproducible docs:search timeout is attached; re-evaluate whether the root cause is supported and only then clear the hold.",
        "owner": "su-407de828-3978-4f90-a7a3-5b6c39aa7740",
        "trigger": "work-item:status:EI-24748485635209632",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24748676680063512",
      "title": "Staging-api fails to reach its listening state during systemd start-pre, leaving :3170 MCP calls unavailable before dispatch",
      "parkFingerprint": "8fd358f7b60f619ec81787e15b4d3c3aefe07a002b694320c84f82df692e27f0",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Reevaluate this aggregate incident after the active audit/log investigation EI-24741224734319108 reaches its terminal state; determine whether the remaining reported outage is covered by the verified restart-handoff fix or remains a distinct issue.",
        "owner": "su-4d7e4d40-5423-4f31-8462-0972404e5cc7",
        "trigger": "work-item:done:EI-24741224734319108",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24749496961502088",
      "title": "testing:run returns ok:false error=no_report with completedFiles=[] although the router printed TEST_FILE_RESULT status=passed executed=1",
      "parkFingerprint": "5903438f967ecbcf5b97342c61091dec9c55484d9415c27017cb165aae6db20d",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": true,
        "condition": "a fresh testing:run no_report occurrence with diagnostics.reportDirEntries is attached to this item",
        "owner": "su-61776b5f-a7d0-4dad-a352-2d7b95609477",
        "trigger": "work-item:comment:EI-24749496961502088",
        "reachability": "blocked",
        "evidence": "no producer registration or catalogued resolver was found",
        "findings": [
          "reachability-unverified"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-24751301126508186",
      "title": "papercusp-su/tools:find tool-call failure (503)",
      "parkFingerprint": "01976f0736600a9ed8ba47169e003be4052d918d940d1ff238d4fd4294b6cdc4",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "EI-24734701627372225 reaches terminal done with completion evidence, then reassess whether its trace records establish a caller-correlated 503 for EI-24751301126508186.",
        "owner": "su-fd7898d2-6701-40dc-89cd-0711aaf115ba",
        "trigger": "work-item:done:EI-24734701627372225",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24751522998046115",
      "title": "work_items:get transport failure while reading fleet dependency",
      "parkFingerprint": "a91c4627f6d534e44747a545e6398acb5ddfaab7e03a6dc71f7a311c4b45c114",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Re-evaluate EI-24751522998046115 after EI-24741224734319108 completes.",
        "owner": "su-0fa6c01b-7962-4018-9f51-a12691da2625",
        "trigger": "work-item:done:EI-24741224734319108",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24754938270779111",
      "title": "sessions:timeline tool-call failure (mcp_proxy_upstream_unavailable)",
      "parkFingerprint": "9811ad4d02629531ee5fb2e2c9b91ed21a83b8f1b9a958745ba9d0327ab117e5",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Root-cause work item EI-24764000993570051 completes; re-check whether its fix covers this pre-dispatch sessions:timeline failure before this child is claimed again.",
        "owner": "su-4d7e4d40-5423-4f31-8462-0972404e5cc7",
        "trigger": "work-item:done:EI-24764000993570051",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24758685381095108",
      "title": "testing:run tool-call failure (invalid_args)",
      "parkFingerprint": "648223e85922bcf2da244614f3eb58a339bad9362be3ff934750bf84990397b0",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Peer fix EI-23680208818629006 is successfully complete; revalidate that tools:find exposes every required evidence.bindings field before closing this item.",
        "owner": "su-e6c54031-e9cb-4856-ac4b-6cdf303de285",
        "trigger": "work-item:done:EI-23680208818629006",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-01 07:42:18.070646-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24764000993570051",
      "title": "Shared staging MCP upstream at 127.0.0.1:3170 refuses connections, exhausting retries before dispatch",
      "parkFingerprint": "497b8e404088a2dbfc79b6da6fbd3740865148bd39ec17d52383b200634fb612",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The canonical aggregate EI-24772008911230982 reaches a terminal resolution and its finding determines whether this contributing report has independent remaining work.",
        "owner": "su-9afae98a-01f2-473c-8247-40fb17fae14b",
        "trigger": "work-item:done:EI-24772008911230982",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-01 09:01:27.926502-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24777693402228076",
      "title": "work_items:search tool-call failure (lock_timeout)",
      "parkFingerprint": "f0eca0d89c51770d143d2e785d8cefd88a1cda78eecff9d49ec0127ab2f1ef44",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Recheck the historical work_items:search lock_timeout after the owner of the related work_items:release lock_timeout investigation records a diagnosis; clear this hold only after verifying whether that diagnosis explains or excludes this search report.",
        "owner": "su-913e9e24-5840-4b81-81ee-0b6e0837306a",
        "trigger": "work-item:done:EI-24780569549840269",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-01 12:15:53.067125-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24790764229390066",
      "title": "Zero-byte shared-checkout .git/index breaks Git-backed commits, mutation probes, and census guards",
      "parkFingerprint": "d18632a06a3482014095449752335ebc71664e5d9a48655920e057859751e8ff",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Avi explicitly resumes the system-wide all-agent pause; verify the message origin and latest fleet instructions before reconsidering this item.",
        "owner": "Avi via coord-send-0742e00373a8a3ba1071ef8101ca566051cea98109ca57bbe34a92a63d709b6d",
        "trigger": "coord:inbox-wake:su-fd7898d2-6701-40dc-89cd-0711aaf115ba",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-01 14:18:04.509878-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24794678724264278",
      "title": "Hosted Android native gate exhausts runner disk while extracting 16 KB image after full host build",
      "parkFingerprint": "05eda7ee5741e346ce53056051f988e580a3cfa2287909ec5af85fa9a90aeff9",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "The active Android public-release P-006 implementation work item WI-10004697 is terminal; re-check whether its committed CI change resolves the hosted Android disk-exhaustion bug.",
        "owner": "su-232367a4-822a-4d58-ac1c-b96e26ece4a5",
        "trigger": "work-item:done:WI-10004697",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24795515671525426",
      "title": "coord:ack tool-call failure",
      "parkFingerprint": "bcdf4abd74eac90f8fbfe9246f807d851e56f205664737ed366a4d9ca3e93085",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Avi explicitly resumes the system-wide all-agent pause; verify the message origin and latest fleet instructions before reconsidering this item.",
        "owner": "Avi via coord-send-0742e00373a8a3ba1071ef8101ca566051cea98109ca57bbe34a92a63d709b6d",
        "trigger": "coord:inbox-wake:su-fd7898d2-6701-40dc-89cd-0711aaf115ba",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-01 14:18:04.509878-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24816298193979418",
      "title": "mcp__papercusp_su__coord_orient and mcp__papercusp_su__tools_find tool-call failure (pending_without_completion)",
      "parkFingerprint": "1fba98a4253f74b17aef014e7cbf56ee52f4a08bc311fbb5d0a83d0a0d8cfa55",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "The live model-facing timeout-versus-CLI investigation reaches terminal state; then re-evaluate whether this earlier combined pending report is fully subsumed.",
        "owner": "su-respawn-ec70d1273ff3abe8bb1d2dd0bdc78c67",
        "trigger": "work-item:done:EI-24817242796602056",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24818386658100528",
      "title": "Android pairing hint points at retired desktop Settings labels",
      "parkFingerprint": "4436971d9af3bad705d40abeec2368847180a25d83b961cb36697c352c162add",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "P-009 exact signed-candidate acceptance item WI-10004776 has completed, so its candidate-bound pairing evidence can be reviewed.",
        "owner": "su-a51ab73e-c242-481d-b0ca-134b18c7836d",
        "trigger": "work-item:done:WI-10004776",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24883083979180888",
      "title": "Tool locks:check_command returns a structural error (kernel-preflight-denied-tool-locks-check)",
      "parkFingerprint": "160359c71a9549b6301f6985fdebd637e70267a827609db31a2bad798c94d594",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "The class-level residual stale-artifact item EI-23772322660353682 reaches done after its serving-build verification; then re-evaluate this per-verb locks:check_command report against that deployed result.",
        "owner": "su-43f96fbb-b9b3-4910-9d3e-fca0a91b5e1a",
        "trigger": "work-item:done:EI-23772322660353682",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24940162932433128",
      "title": "Session MCP bindings lack reliable reinitialization across restart and carry-respawn boundaries",
      "parkFingerprint": "5610ba320c8e78353ecf93eeff4e90cc996fb8a8658a5b879acd948d7b4d94b6",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Recorded native initialize/tools-list acceptance with exact target lineage becomes available, or a new direct leader disposition authorizes a fresh acceptance case. The linked source completion is a reconsideration cue only, not proof that native acceptance is satisfied.",
        "owner": "su-3ae55b3b-8547-4852-bff2-07f7019f03f3",
        "trigger": "work-item:done:EI-24934041801291292",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-24952592377510798",
      "title": "Contract and grading definitions advance without a matching serving-generation gate",
      "parkFingerprint": "dd5ebfcebd7e83f6f35551c2e42599ee0721d6cd885a795cf2697596c714522f",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Re-evaluate EI-24952592377510798 after umbrella EI-24932442270076519 reaches terminal state; close as duplicate if its serving-generation fix covers the acceptance cases, otherwise re-queue only a specific uncovered consumer seam.",
        "owner": "su-d506c540-fc66-4a41-b60a-1707aef30886",
        "trigger": "work-item:done:EI-24932442270076519",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-05 12:27:08.054236-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24958912793275666",
      "title": "Code, migrations and published tool contracts advance without a shared serving-generation fence",
      "parkFingerprint": "32436a279038221577d35ec07f52ad21907760400d3381e03b113d05fdd2b71e",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "After parent EI-24932442270076519 completes, compare its completion evidence against this digest's 12 contributing work-items and determine residual scope.",
        "owner": "su-d506c540-fc66-4a41-b60a-1707aef30886",
        "trigger": "work-item:done:EI-24932442270076519",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-05 12:27:08.054236-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24958925432829957",
      "title": "Claim and worker liveness substitutes presence or age for demonstrated execution progress",
      "parkFingerprint": "e4e8034a72bdac46eb9d3cb0274da90907a8c5ab6160ce62adc8652e2e5948eb",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Re-evaluate only after work_items:get shows admissionReview.state is no longer pending and a reviewer outcome is recorded.",
        "owner": "system:work-item-admission-promoter",
        "trigger": "work-item:claimable",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-08 11:17:54.886777-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-24958947185653426",
      "title": "Source-text assertions substitute for behavioral guard reachability",
      "parkFingerprint": "954df2597701c2f6ae00296fecf0814b1b5c6a96016e0c057a6d19e326b659d4",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Recheck this aggregate only after WI-10006201 completes; read its terminal evidence and EI-19463270946869641's current state, and continue only if relevant strictness evidence or new admitted scoped work exists.",
        "owner": "su-26e81472-29ed-4d18-8b4b-4520850d8aef",
        "trigger": "work-item:done:WI-10006201",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-25152107634140832",
      "title": "scheduler:get_next tool-call failure (harness_scope_reader_error)",
      "parkFingerprint": "43b0f1ef894c7a0d15bd0bc888ed41070a10ca378b85428901306d0b966dc20b",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Reconsider the deferred scope-reader investigation after EI-24964729108914735 reaches done and the fleet leader confirms the lane should resume.",
        "owner": "su-f96cf8e8-fceb-459d-b9a0-b25cd9ff85cc",
        "trigger": "work-item:done:EI-24964729108914735",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-05 17:14:48.657417-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25156126066214223",
      "title": "work_items:link requires blocking the active dependant first",
      "parkFingerprint": "3bd432ee0db6de9f5a8a90f9a5f5b8315d0eaee6b07860a5da5963d2c921ec5b",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "The originator posts a substantive revision or explicit defense that addresses the existing grade-1 feedback: concrete guidance/classifier problem, current evidence, desired outcome, narrow scope, and executable completionCheck. Recheck before clearing the hold.",
        "owner": "su-6c740129-47fc-4079-a142-5d2ea506e5c5",
        "trigger": "work-item:status:EI-25156126066214223",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-25166161739773210",
      "title": "Test failing repeatedly: packages/operator-core/lib/agent-tools/claude-seed-wire-budget.test.ts",
      "parkFingerprint": "44698145eb9208f257f764ca8d5c41fb7efea224a7e55517b268118956439553",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Recheck whether WI-10006184 fixed the shared Claude seed wire-budget overrun; if the report is covered, close this EI as a duplicate with evidence, otherwise resume its remaining root-cause work.",
        "owner": "su-4423c124-7658-4efb-b892-77b6156d207b",
        "trigger": "work-item:done:WI-10006184",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-05 20:28:13.417414-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25178201520163798",
      "title": "locks:list tool-call failure (authorization_denied)",
      "parkFingerprint": "b51116a548334cdbc057bd176dc7977af831479a0dde7911b1b866f10305d5e8",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "A fresh failure record is available with a native-session ID plus selected-row identity, or an immutable snapshot linking both.",
        "owner": "self",
        "trigger": "work-item:status:EI-25178201520163798",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-25208075980534057",
      "title": "coord:presence tool-call failure (request_timeout)",
      "parkFingerprint": "491b3cda4034d43a9724e6030bdf439304398bc00850957085eff4edc6fbd676",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "A fresh successful current-HEAD reproduction receipt for the targeted coord:presence timeout is recorded on this item with presence-read-v1 phase data and exact query diagnostics.",
        "owner": "agent recording the successful reproduction evidence",
        "trigger": "work-item:status:EI-25208075980534057",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-25221154226289275",
      "title": "work_items:checkpoint tool-call failure (invalid_input)",
      "parkFingerprint": "dc5744ad85bfbafac4e552da20eaba2bcf0bafd89194cd1a4c6aed8aedc40820",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Re-evaluate only after canonical admissionReview is no longer pending and _admissionRecovery is no longer held; do not claim or edit source before admission is approved.",
        "owner": "system:work-item-admission-promoter",
        "trigger": "work-item:status:EI-25221154226289275",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-25262506441610830",
      "title": "Test failing repeatedly: apps/operator/e2e/adv-shell-nav.spec.ts",
      "parkFingerprint": "bc89aa60201c70218267a823b2c246db60c9fbec7a0c83431827fa1ff2dbe1f3",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "The live gate owner has completed WI-10006055, so the LIVE_GATE_OPS hold can be reassessed before this repeated-red-test item is pulled again.",
        "owner": "su-2b9fe461-077c-4fd4-8cd7-c43499f17892",
        "trigger": "work-item:done:WI-10006055",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-25263832272746079",
      "title": "coord:presence targeted owner lookup hangs (no response in 10-30s), twice on the same input",
      "parkFingerprint": "bf3dcfaa22fdd2a446c1c9501ed9c9ae0e4cfaa981de4df56ecf1f7274dc96ac",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Verified shared targeted-presence snapshot root repair completes; then original-selector acceptance is runnable.",
        "owner": "su-5bcbcf19-e213-4f86-b2c6-185c12636983",
        "trigger": "work-item:done:EI-25213409353115805",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-06 21:11:16.782999-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25286340925095718",
      "title": "coord:send replay aborted before persistence",
      "parkFingerprint": "12650fb7cb703480d054043e10ada7e4c008b21af93913200e68bd9a69601ca8",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Exact reproduction or invocation/runtime evidence is attached showing that the original or replayed coord:send returned an incorrect result.",
        "owner": "su-6c382a1c-8a44-4f18-9434-d5a7dd2f65be",
        "trigger": "work-item:status:EI-25286340925095718",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-25286381741837766",
      "title": "Judge successor recovery requires tools denied to judge role",
      "parkFingerprint": "00d561a78fea483f0d101bdcee56e4826afd2ecd67b847a17d5f7edf638c8216",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Re-evaluate the remaining judge recovery permissions after the canonical transcript/assignment fix settles; verify whether events:status is still a distinct blocker and keep any judge access scoped.",
        "owner": "su-dcd843d2-bf3a-4f37-a5cd-05ebddcd1d60",
        "trigger": "work-item:done:EI-25286491844937496",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 00:44:26.773888-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25286409713168872",
      "title": "Judge successor recovery cannot read required predecessor transcript",
      "parkFingerprint": "da7091bf6f692ce7a34ae85062c405101d09ce2d1caa20c7d4a0ee906b74ce72",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The active overlapping fix EI-25286491844937496 reaches a terminal state, then this duplicate report may be reconciled.",
        "owner": "su-dcd843d2-bf3a-4f37-a5cd-05ebddcd1d60",
        "trigger": "work-item:done:EI-25286491844937496",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 00:44:26.773888-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25286473017545396",
      "title": "Judge successor recovery cannot read predecessor transcript or live assignments",
      "parkFingerprint": "d4f9fe48e992670b145f46c503311dac44618e4eeebe213f20a4a8dfe12b8776",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Re-evaluate this duplicate judge-recovery report after the canonical fix item settles; determine whether this report is still distinct or can be closed as duplicate.",
        "owner": "su-dcd843d2-bf3a-4f37-a5cd-05ebddcd1d60",
        "trigger": "work-item:done:EI-25286491844937496",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 00:44:26.773888-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25286488575532802",
      "title": "Judge successor recovery cannot access required predecessor transcript or live assignments",
      "parkFingerprint": "9efd33b5cc816c802e6c8e4b4e57ec2da7757f1f14f32c2fb283d3de9b68d840",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Re-evaluate the remaining judge-recovery access reports after the fleet leader provides a scoped disposition for explicit predecessor transcript access.",
        "owner": "su-3ae55b3b-8547-4852-bff2-07f7019f03f3",
        "trigger": "coord:inbox-wake:su-0d943ae2-636d-42d4-aae5-05359fb11846",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 13:45:45.645491-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25286493488325561",
      "title": "Judge successor recovery cannot read its predecessor transcript",
      "parkFingerprint": "5d7b02771465dc3addceffc04f3341329f8e0bcfa02f5a02bad0204cd7e42ab4",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Re-evaluate the remaining judge-recovery access reports after the fleet leader provides a scoped disposition for explicit predecessor transcript access.",
        "owner": "su-3ae55b3b-8547-4852-bff2-07f7019f03f3",
        "trigger": "coord:inbox-wake:su-0d943ae2-636d-42d4-aae5-05359fb11846",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 13:45:45.645491-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25286563275692599",
      "title": "Judge successor recovery requests tools excluded from judge role",
      "parkFingerprint": "3b5309c3f15e88ddde6ed7c567492732fa5143dbe2b91e5144a1d8734b9155e8",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The fleet leader completes comparison of the judge-recovery duplicate cluster and sends a disposition for EI-25286563275692599.",
        "owner": "su-3ae55b3b-8547-4852-bff2-07f7019f03f3",
        "trigger": "coord:inbox-wake:su-b4ff91fe-a301-4cf2-937b-20cb495fb2f8",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 00:14:30.620818-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25286577618942027",
      "title": "Judge successor recovery cannot read designated predecessor transcript or verify live assignment",
      "parkFingerprint": "788a830eb0254c028c133d6ece21712a729564bba65c8ead205d4f37920835ca",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Re-evaluate duplicate judge recovery validation after the active sessions:read fix item EI-25286491844937496 is completed and its verification is recorded.",
        "owner": "su-dcd843d2-bf3a-4f37-a5cd-05ebddcd1d60",
        "trigger": "work-item:done:EI-25286491844937496",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 00:44:26.773888-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25286588611893475",
      "title": "Judge successor recovery cannot access its predecessor brief or live assignments",
      "parkFingerprint": "b67fb8ec84ce83b0c20b654f622b0c6232cb4c34b56918807fbb5e967dd6a303",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Re-evaluate the remaining judge-recovery access reports after the fleet leader provides a scoped disposition for explicit predecessor transcript access.",
        "owner": "su-3ae55b3b-8547-4852-bff2-07f7019f03f3",
        "trigger": "coord:inbox-wake:su-0d943ae2-636d-42d4-aae5-05359fb11846",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 13:45:45.645491-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25286623196084187",
      "title": "Judge successor recovery denied predecessor transcript read and search",
      "parkFingerprint": "8859b6c7b42711df4996fec9f05a7528203a1c0a1d27120cb79ff61452646592",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "EI-25286431862833439 reaches terminal completion; then re-check whether this item's Judge predecessor transcript recovery gap remains after the self-only reader and denied generic search are verified.",
        "owner": "su-059e1b4e-e4fb-49d1-a4ab-085e052d4690",
        "trigger": "work-item:done:EI-25286431862833439",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 01:20:18.071895-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25286741911883615",
      "title": "Judge successor recovery cannot access predecessor transcript or live audit state",
      "parkFingerprint": "af59b69cfc2686887874498327bada6b8cb42f71f4abbb1bbe969a7ece274d55",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The primary judge recovery fix completes and its verified coverage is checked against this item's predecessor transcript and live assignment requirements.",
        "owner": "su-dcd843d2-bf3a-4f37-a5cd-05ebddcd1d60",
        "trigger": "work-item:done:EI-25286491844937496",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 00:44:26.773888-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25286759666076169",
      "title": "Judge successor recovery cannot read mandated predecessor transcript",
      "parkFingerprint": "4a46fee1c1ebda1efd24211a08d3cf863949a8435fc1aee642c4fd97b9d7fb43",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "EI-25286431862833439 reaches terminal completion; then verify whether this reporter's Judge transcript and live-assignment recovery remains blocked.",
        "owner": "su-059e1b4e-e4fb-49d1-a4ab-085e052d4690",
        "trigger": "work-item:done:EI-25286431862833439",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 01:20:18.071895-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25286839297504346",
      "title": "Judge recovery orientation cannot verify assignments",
      "parkFingerprint": "8183efc4d0581513ca360dc4dbf297ecf735e5d2a460f8db401a35f3dea962aa",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Revalidate this item's assignment-orientation case against the current build after EI-25286431862833439 settles; check whether EI-25286491844937496 remains active before taking implementation work.",
        "owner": "su-7b3fff24-81ea-4624-93d7-4a2a23ea8cf5",
        "trigger": "work-item:done:EI-25286431862833439",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 01:20:18.071895-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25286874227477106",
      "title": "Judge successor recovery cannot read required transcript or live assignment state",
      "parkFingerprint": "8586531e679f600416209c0477f31ef22f1065233ce7d8618b9ac16ce46d1eb5",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Revalidate the current-build events:status and predecessor assignment scope after EI-25286431862833439 settles; check whether EI-25286491844937496 remains active before implementation.",
        "owner": "su-7b3fff24-81ea-4624-93d7-4a2a23ea8cf5",
        "trigger": "work-item:done:EI-25286431862833439",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 01:20:18.071895-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25286885519711590",
      "title": "Judge successor recovery requires transcript and lease reads denied by judge ACL",
      "parkFingerprint": "852f29f2d37dc34761405cf27524cc774c33da80f1036ace4d397b16c5633917",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Re-evaluate the remaining judge-recovery access reports after the fleet leader provides a scoped disposition for explicit predecessor transcript access.",
        "owner": "su-3ae55b3b-8547-4852-bff2-07f7019f03f3",
        "trigger": "coord:inbox-wake:su-0d943ae2-636d-42d4-aae5-05359fb11846",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 13:45:45.645491-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25286888969181808",
      "title": "Judge successor recovery cannot read prior session through sessions:read",
      "parkFingerprint": "a10dac6bfeb0d9314058cf62a19d2b5f3cb8bafb54d78bdb894ff8ea52db6c08",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Revalidate the current-build sessions:read and assignment recovery case after EI-25286431862833439 settles; reopen only if this report is distinct.",
        "owner": "su-7b3fff24-81ea-4624-93d7-4a2a23ea8cf5",
        "trigger": "work-item:done:EI-25286431862833439",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 01:20:18.071895-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25286891297181987",
      "title": "Judge successor recovery cannot read its own transcript through sessions tools",
      "parkFingerprint": "b763ff3af6b9c452b0fa800f2c650bb72641c0ed6a980426ec37c2883a5860d6",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "EI-25286431862833439 reaches done/resolved and the active shared-path edit is ready for current-staging validation.",
        "owner": "su-059e1b4e-e4fb-49d1-a4ab-085e052d4690",
        "trigger": "work-item:done:EI-25286431862833439",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 01:20:18.071895-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25286928210917579",
      "title": "Judge successor recovery cannot access required predecessor transcript",
      "parkFingerprint": "f6bd209598230e60803d49c5cabed9d1dbeba64b47d029368a670311398996cb",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Revalidate the current-build predecessor transcript and identity-alias recovery case after EI-25286733165839812 settles.",
        "owner": "su-7b3fff24-81ea-4624-93d7-4a2a23ea8cf5",
        "trigger": "work-item:done:EI-25286733165839812",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-25287966304966129",
      "title": "coord:inbox tool-call failure (request_timeout)",
      "parkFingerprint": "99e3bf967176596476ce1619f9383407e1bec616627a77ddddfed9fb8cec28ec",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "The exact pending-rebootstrap phase/query for one of the two timed-out coord:inbox invocations is attached to the item and the fleet leader verifies the evidence before returning the item to the bug lane.",
        "owner": "su-3ae55b3b-8547-4852-bff2-07f7019f03f3",
        "trigger": "work-item:status:EI-25287966304966129",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-25294464042258236",
      "title": "Goal-brief legacy behavioral clauses cannot be satisfied by current measured-layer evaluator",
      "parkFingerprint": "c4d2cd9a2b9493328b7c90fac2f3502c577dc21148af1307cf05c82e95c13280",
      "lease": {
        "by": "su-f685e5bb-5716-4aa5-ab3f-93a419738d63",
        "reason": "blocked",
        "at": "2026-10-08T05:56:37.760Z"
      },
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "P-003 rubric vet/attestation and current first-class live evidence for AUTO-BAR-R-2-P-003 are recorded on plan goal-brief-to-claimed-plan-work-2026-09-23; then re-evaluate EI-25294464042258236.",
        "owner": "su-f685e5bb-5716-4aa5-ab3f-93a419738d63",
        "trigger": "plan:acceptance:goal-brief-to-claimed-plan-work-2026-09-23",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 13:28:24.46271-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25303334727767704",
      "title": "code:run recovery reads fail during result-door spill",
      "parkFingerprint": "366baca80a4f7bc39240a5701783be03081043dcd569319904c8c75769d033de",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "EI-25304677620490090 reaches done; re-evaluate whether this code:run spill report is independently unresolved using that item's fix and test evidence.",
        "owner": "su-respawn-78a1739f77e4338214bd25b427cca743",
        "trigger": "work-item:done:EI-25304677620490090",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 05:53:52.294582-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25303887576103817",
      "title": "tools:invoke tool-call failure (output_spill_failed)",
      "parkFingerprint": "76dc438a7870c3f85527be68aedbce3b5336b076c8d31fa4084e3a98233c70e7",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The live owner finishes EI-25303697450023492; re-evaluate whether the committed shared spill repair covers this tools:invoke work_items:get path.",
        "owner": "su-b0977d54-e1e0-4e29-ad56-424f04b47db6",
        "trigger": "work-item:done:EI-25303697450023492",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 05:21:28.224039-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25303957084433784",
      "title": "events:status failed to spill an exact fleet member-dead watcher result",
      "parkFingerprint": "27fc32205ee6fb0861fd774c4e04bf02bd987a279fa8d20df99b1fcaa5ba3156",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The shared spill work item EI-25303697450023492 reaches terminal state; then re-evaluate whether its committed repair covers this events:status projection.",
        "owner": "su-b0977d54-e1e0-4e29-ad56-424f04b47db6",
        "trigger": "work-item:done:EI-25303697450023492",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 05:21:28.224039-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25304017024716803",
      "title": "events:status tool-call failure (spill-write-failed)",
      "parkFingerprint": "fc397120ca04efd44d9e44e1936c7ae396d67c67a9168fd74c078b9fa7c23b6f",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "EI-25303697450023492 reaches a terminal state, after which this event-wide waiter spill report is rechecked.",
        "owner": "su-b0977d54-e1e0-4e29-ad56-424f04b47db6",
        "trigger": "work-item:done:EI-25303697450023492",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 05:21:28.224039-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25314721835459313",
      "title": "scheduler:get_next tool-call failure (spill-write-failed)",
      "parkFingerprint": "efff6ac010890a6bd1b96fcf87fcca9e4cebff5857c7df22347405702847d0d2",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "New measured containing current-build runtime and diagnostic receipt, or an explicit governing fleet-leader disposition, changes the saved unresolved acceptance qualification. Existing source proof alone is insufficient; original timeout cause remains UNKNOWN.",
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "trigger": "work-item:done:WI-10007106",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-25328516650438565",
      "title": "work_items:get tool-call failure (output_spill_failed)",
      "parkFingerprint": "405ee182a6101fb69a30b8555b599ffaa0ddff95c46075d6827524b2539a6e9f",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "The spill-record investigation EI-25327232452706390 completes, exposing occurrence-linked spillErrorCode/error detail and serving build, or reporting that these records are unavailable.",
        "owner": "su-d105c1cc-8100-496d-a95f-1e304bc4ffbd",
        "trigger": "work-item:done:EI-25327232452706390",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-25333711126476866",
      "title": "Shared result-door spill persistence failure leaves overflow responses and recovery pages unreadable",
      "parkFingerprint": "f2dc78af6237e25af260cf906b97b66cc585f6b52bdfdb160242bc6701e04464",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The active blocker EI-25314891261005918 reaches a terminal outcome; then compare its verified result with this item's four contributors and resume only for uncovered cases.",
        "owner": "su-respawn-038fde399787fd74498b02d016db3c6f",
        "trigger": "work-item:done:EI-25314891261005918",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-07 15:20:45.565632-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-25334433332398084",
      "title": "work_items:get tool-call failure (output_spill_failed)",
      "parkFingerprint": "7fa148b10234b7fd14619177beb35df7a17cf24af11d8124019ad527ea572530",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": true,
        "condition": "An original request-time result-door spill envelope or equivalent contemporaneous quota usage/eviction record is recovered for the 2026-10-07T15:19Z SCRATCH_QUOTA_EXCEEDED incident.",
        "owner": "su-e7fee03a-ec84-4706-a0f5-9d00e58ed136",
        "trigger": "event:work-item-evidence-recovered:EI-25334433332398084",
        "reachability": "blocked",
        "evidence": "no producer registration or catalogued resolver was found",
        "findings": [
          "reachability-unverified"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-25345661729272813",
      "title": "Resumed Sol6.1 fleet member config lost the previously verified unpinned Codex gateway provider",
      "parkFingerprint": "30044b3984bdb69ceca1139959cb70a4027607aa75f69d02188b79d0c7af9435",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "The active gateway-resume cluster owner evaluates this report and confirms it is redundant or identifies a distinct remaining repair.",
        "owner": "su-61a88fd2-510d-4ca6-8a71-fde8957fb3bc",
        "trigger": "work-item:done:EI-25315999254091150",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-25355584370404958",
      "title": "Test failing repeatedly: packages/operator-core/lib/doc-claims/judge-scaffold-version-consumers.test.ts",
      "parkFingerprint": "55e93d30fa6092984039be13dcd1747ec49a491015ce68515b0cd2ee2a000fac",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "The current live gate owner has completed WI-10006055 and the gate ownership cell is no longer held-live by su-6c740129-47fc-4079-a142-5d2ea506e5c5.",
        "owner": "su-6c740129-47fc-4079-a142-5d2ea506e5c5",
        "trigger": "work-item:done:WI-10006055",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-25373781226365668",
      "title": "Scorecard grading audit test-ledger read observed upstream retry/connection failure",
      "parkFingerprint": "0d902a3a9013c81dcd62b6f7e1a1a805846813994b4fd6c6b176f2f9eaa6f5e0",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": true,
        "condition": "One of the four checkpointed independent evidence sources appears for the 2026-10-08 01:45:06Z warning.",
        "owner": "su-c30b7c30-e853-49ac-a782-48e5a4eccf45",
        "trigger": "A new original result marker, timestamped proxy trace, archived CPU profile, or matching staging API trace falsifies its corresponding checkpoint check.",
        "reachability": "blocked",
        "evidence": "no producer registration or catalogued resolver was found",
        "findings": [
          "reachability-unverified"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-25383407875945735",
      "title": "scheduler:get_next tool-call failure (timeout)",
      "parkFingerprint": "88b0bd5604798def1a0df1e54471ec36aae2fa2eb9f0fe6448066a96fe049c18",
      "lease": {
        "by": "su-f685e5bb-5716-4aa5-ab3f-93a419738d63",
        "reason": "blocked",
        "at": "2026-10-08T06:06:13.049Z"
      },
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "The reporter identifies whether the original d5faa scheduler:get_next call ran on :3070 or :3170, and the endpoint's source is compared with staging before this item is re-evaluated.",
        "owner": "su-f685e5bb-5716-4aa5-ab3f-93a419738d63",
        "trigger": "work-item:unblocked:EI-25383407875945735",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-25387820146615255",
      "title": "Kernel preflight reports unavailable session-identity evaluation as authorization_denied",
      "parkFingerprint": "e0cb1ea95c1d6e5e2ad5991d67b025e8a74a05923774d7bfb74f4fd8d798b9cc",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Re-evaluate this aggregate item after the active historical authority investigation EI-25381874337304378 reaches a terminal state; its result will determine whether any distinct diagnostic fix remains.",
        "owner": "su-75b49fab-1bd0-4134-8b37-fd4809839f33",
        "trigger": "work-item:done:EI-25381874337304378",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "EI-25401753626944809",
      "title": "work_items:list tool-call failure (request_timeout)",
      "parkFingerprint": "683ceadc79125d719d258464043ce19042d5227e5654285255729f76212e010e",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": true,
        "condition": "An original failing client frame or correlated proxy/server trace for the 2026-10-08 09:09:55Z timeout becomes available.",
        "owner": "su-c30b7c30-e853-49ac-a782-48e5a4eccf45",
        "trigger": "A new native session frame or proxy/server trace is attached to this item or appears in a retained evidence source.",
        "reachability": "blocked",
        "evidence": "no producer registration or catalogued resolver was found",
        "findings": [
          "reachability-unverified"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-25405520875511094",
      "title": "coord:whoami tool-call failure (request_rejected)",
      "parkFingerprint": "8884382f7ac9c2c67043049e52d7d74e8302240f92095f0ad43824cb1eaa9207",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": true,
        "condition": "Re-evaluate after EI-25404514791880614 reaches a terminal state, or after its current holder confirms EI-25405520875511094 is a distinct root cause requiring separate work.",
        "owner": "su-83e97357-e571-4b82-89a0-6cf75adb65a2",
        "trigger": "Work-item done event for EI-25404514791880614 or direct disposition from its current holder.",
        "reachability": "blocked",
        "evidence": "no producer registration or catalogued resolver was found",
        "findings": [
          "reachability-unverified"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-25406260945506415",
      "title": "work_items:get tool-call failure (request_rejected)",
      "parkFingerprint": "e1e65a8c133cc6ee8b3140ca05d8cf3bb4a32b44cec9f688e85919c7d9886522",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Re-evaluate this report after source investigation EI-25404547767938594 changes status; remove the hold only if new source-owner or fleet-leader evidence identifies an unowned durable fix. Do not duplicate the active investigation.",
        "owner": "su-b7c19363-b01a-46ad-a273-0ff5ba5e9d85",
        "trigger": "work-item:status:EI-25404547767938594",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-08 11:02:37.646516-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "EI-2614",
      "title": "Implement-worker assembled prompt overflows model context window on boot (\"Prompt is too long\" DOA)",
      "parkFingerprint": "6a630613b50f132e4a0db194c294c4b97d8c45d99e604d923df09c829999a64a",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-554",
      "title": "fleet:spawn bee MCP umbilical rides shared endpoint-ipc.json — a staging (:3170) restart mid-bee-lifetime severs its coord voice (degrades to output_tail-only)",
      "parkFingerprint": "c4378114e71d278d887c76b81c54cf5d26562a1a88de2579c8e212793ace8c0d",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-7346",
      "title": "Storm-time LOCAL-model fallback tier for autonomous roles: route doc-steward/release-fixer to the certified ornith backend when the cloud pool is saturated",
      "parkFingerprint": "a8062a5f87e4a4bf8ebe5433c441d548b79b8a85481d26113a19a3b33960237b",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-8214",
      "title": "Recurring stalls (recurring 3–32×) stay open because stall handling is binary: either ignore the wedged cell or reap it. Reaping a slow-but-live cell discards in-flight work and re-triggers the same f",
      "parkFingerprint": "f31e33c5a74fca0a41838c17f35e92a7ee7cd7f903f50e35070410c13f88af67",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked on a precondition I am not implementing: every stall rung keys on spawned_agents.last_output_at, populated for 1/75 spawns (by design for 4 of 5 spawn classes). Evidence in checkpoint + comment 56012. Unblocks when EI-19485284578135530 / EI-18729995135827661 candidate 1-or-2 lands. Parked rather than held so it does not read as in-flight.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-8299",
      "title": "Separate auto-filed watchdog/telemetry work-items from the actionable drain queue",
      "parkFingerprint": "ae5aa5b6f8bd9f81ca3142a0dcf2e8e17be6ab6a5ef69cdbb08d16790d1d9837",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-8574",
      "title": "Command-output tee parser panics on a multibyte char at the truncation byte-offset (loses the whole output)",
      "parkFingerprint": "4707d713f8dbf8b8cdfbd6fbac96b18b6bae4b5ebcb5834be4009e31525222ea",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-8575",
      "title": "Integration tests that mock getOrgPg but not withWorkspace silently write to the REAL org PG — add a guard (env pin or db-org test-mode assert) so an unmocked withWorkspace under vitest fails loud instead of escaping",
      "parkFingerprint": "bb9eb29e9c8dcd6df6013b0bc58363251ee6d488b7a5cc12ff383264fdff64dc",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-8793",
      "title": "Release build: the self-improvement loop (edit → auto-commit → main) is structurally absent on a packaged install — papercusp registered as remote_hive VIEW, no git-sync routine, no hive-git store",
      "parkFingerprint": "91424be619fd43c6b5eb835c8c9d1ac50c676810b79acbb33621bb93c9f78d49",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-8913",
      "title": "Embedding-space desync: a runtime pref switch silently invalidates every stored vector, and search reports no error",
      "parkFingerprint": "b294f4b599ac3e8a238074fd773ccdde64dc2b32139a214cd71c6e255c531877",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "OUT OF LANE + RE-SERVE LOOP. Released once; get_next handed it straight back as the very next item, so a plain release does not break the cycle. claimHold:true is the durable self-select exclusion. Admitted to rev24 ONLY by { paths glob libs/papercusp/libs/db/sql/* } matching migration 530; a flat shared dir cannot express lane membership. NOT declined on merit — the work is real. Fact 3600; leader msaztl9d.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "EI-9250",
      "title": "AskUserQuestion in a headless/fleet psu session gets auto-answered by an unidentified layer (~25s, picks an option) — silently defeats the AUTO-off authorization gate",
      "parkFingerprint": "beae1028965d601e92fdd2df0b630df8b73eb43b9df82c3304e2d75d1737ce3b",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-10000392",
      "title": "Carry BYOC cloud plan from recovered session to verified shipment",
      "parkFingerprint": "967c342b570664dc6838c5c204ed1f1e7f3e898c1425c1db58d878113a66f9e5",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "New 21:07Z owner-verified system-wide pause lifted and BYOC fleet resumed",
        "owner": "su-f48fd476-39f2-4e33-b9d0-23c18c9c00e2",
        "trigger": "fleet:byoc-alpha-ship-2026-09-05:resume",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "WI-10000445",
      "title": "Activate and drive the approved code-capability dream plan through implementation",
      "parkFingerprint": "ece3232470cc48d12fb8b08a1d1730fe7c8301dadebd0934daa4ad52a7c909dd",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Avi answers the final Dream P-008 disposition/human-validation question or explicitly resumes this lane after the system-wide stand-down.",
        "owner": "su-47689c3d-58bd-475e-ac01-7249394c8aea",
        "trigger": "conversation:answered:conv-mu1b09fl-0000-e93db624a940465bb51e72c19d9c6348",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "WI-10000845",
      "title": "Workspace DB dump is stale after its latest snapshot hook degraded: /home/marsh-office/.papercusp-workspaces/default/db-dumps/pg-embedded.sql.gz is 233h old",
      "parkFingerprint": "c80ef29f091783d1587ef936543ae822cda274e3bd9d649ea8e9aad296f24140",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "papercusp-db-backup.service has safe host-tier capacity and a fresh successful STATUS.json/backup receipt",
        "owner": "su-d5e488b9-9880-4294-8116-5c9c59cebc57",
        "trigger": "work-item:status:WI-10000845",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-08 23:54:54.716979-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "WI-10001088",
      "title": "Reconcile R-6's precheck failure policy: a runner/setup failure must refuse publication with a typed actionable outcome; preserve D-002's e…",
      "parkFingerprint": "2672ef74e32361e3fee628dcefefc158fc64f3bf090fb8250ec8ef55e836a546",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-10001268",
      "title": "Run focused tests and a real Chromium :3801 timing replay; verify populated Orders appears within 250ms after expansion and record the cold-query improvement. (blocked by P-001 and P-002)",
      "parkFingerprint": "ce34d90156f034e4ff3129aa2671991654a3e06cfa332e68d25bbd51766f03e2",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": true,
        "condition": "owner records a literal route-change turn on plan hud-orders-instant-load-2026-09-13 (D-004)",
        "owner": "su-61776b5f-a7d0-4dad-a352-2d7b95609477",
        "trigger": "plan-decision:hud-orders-instant-load-2026-09-13",
        "reachability": "blocked",
        "evidence": "no producer registration or catalogued resolver was found",
        "findings": [
          "reachability-unverified"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-10001433",
      "title": "Audit Storewolf microservices architecture and deliver diagrams plus interview guide",
      "parkFingerprint": "f2fe3f416f341fe6de27eb10bd88bc16e6df22978597bfebb83c5f61cf122428",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Avi explicitly authorizes resuming the broader Storewolf architecture audit; the completed Transformer-only audit does not suffice.",
        "owner": "su-fc0a87ca-c4ae-4607-8328-0187209196a4",
        "trigger": "storewolf-broad-audit-owner-resume",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "WI-10001445",
      "title": "Wellfound SWE job applications for Avraham Weiss — dedupe against the 97-company AI_Agent_Job_Applications tracker, log in schemaVersion-2 format",
      "parkFingerprint": "4ddee35e3924405462e7a50633be2aaf28abc245f7a6662f3a8a503040923877",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": true,
        "condition": "Avi (owner) says go / authorizes submitting Wellfound applications in an owner-typed turn. No agent may self-clear this, and the sibling HN lane WI-10001452 is a separate mandate that confers no permission here.",
        "owner": "Avi",
        "trigger": "owner-turn",
        "reachability": "blocked",
        "evidence": "no producer registration or catalogued resolver was found",
        "findings": [
          "reachability-unverified"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-10001705",
      "title": "Non-author grading-integrity audit: emit the terminal spec-test-adequacy scorecard for R6-P009-PRECHECK-RUNNER-FAIL-CLOSED@7 (green-gate-zero-wait-convergence-2026-09-08)",
      "parkFingerprint": "ea40999ba65fe1152e2e7eb5972ef97a7dfc1fddf0bf91c095d337d186598576",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "su-a604a73a-08f7-4699-a4c1-05506614e161 completes the R6-P009-PRECHECK-RUNNER-FAIL-CLOSED evidence re-bind and lifts their explicit 'do not re-run yet'. Then re-run plans:evaluate-spec-test-adequacy and emit row.scorecardDraft (rerunRecipe is a key of scorecardDraft, not of the evaluator row). If it returns grader_in_implementer_lineage, STOP and tell su-a604a73a.",
        "owner": "su-a604a73a-08f7-4699-a4c1-05506614e161",
        "trigger": "coord:inbox-wake:su-4dbc7355-3bfa-4308-b4d8-e5223e782644",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-01 12:24:02.255396-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "WI-10001738",
      "title": "green-checkpoint RED (unowned, zero-attempt stalled): spec-test-adequacy.test.ts \"declares exactly the criteria the evaluator rates\" fails at frozen candidate 8b21e839d34b — blocks promotion + deploy fleet-wide",
      "parkFingerprint": "1142ac32d63c9137849c7cf5e23193882430ea0d9a026628924076a3db423576",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": true,
        "condition": "The live fixer on frozen queue 6686c70f is gone (fixerAlive false) or the queue is retired/green, AND gate ownership is genuinely unheld — verify with release:repair-queue { op:'get' }, never with the gate.greenCheckpoint.ownership cell alone, which read 'unowned' while this fixer was live.",
        "owner": "su-c68e6e76-bd39-4e8c-a0b0-899e63952d37",
        "trigger": "release:repair-queue:fixer-cleared:papercusp",
        "reachability": "blocked",
        "evidence": "no producer registration or catalogued resolver was found",
        "findings": [
          "reachability-unverified"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-10001907",
      "title": "Green-checkpoint red streak on papercusp: diagnose failing verdict and restore promotion",
      "parkFingerprint": "f69ef236b26ef5ccb1466e7a75c77d603809c23bec73bea6d50e3b48537acc61",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Canonical singleton gate item WI-10001906 reaches a terminal state; then retry closing WI-10001907 as its duplicate without claiming any live-gate responsibility.",
        "owner": "su-638ae8aa-ba1e-47a7-b96c-53216e41ae0b",
        "trigger": "work-item:done:WI-10001906",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-26 13:44:19.498019-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "WI-10001911",
      "title": "Green checkpoint red blocks 0.0.21-alpha promotion",
      "parkFingerprint": "47d1c4b2bbcef3974e41cbad1659982fdcdc8b76d17bde1ba885c380d1d3eb79",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "escalation mu89smb4-0000-9b5294bf77aa4347b800197586f138ec is resolved",
        "owner": "su-5715007e-6bb8-4b04-9e11-28c9276452b5",
        "trigger": "escalation:resolved:mu89smb4-0000-9b5294bf77aa4347b800197586f138ec",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-26 07:20:13.099926-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "WI-10001949",
      "title": "[release-trigger-freeze:papercusp] release-trigger is PAUSED on papercusp with 2982 green commit(s) stranded — silent fleet-wide deploy freeze.",
      "parkFingerprint": "7e51bc2232cf234403a82105b06821376ec5120596cf974681eb4cc2586ff39b",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "release-trigger-freeze:papercusp is resolved or the release pipeline deploys a green SHA",
        "owner": "system:release-trigger-freeze-watchdog",
        "trigger": "release:deployed",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-02 08:06:29.847347-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "WI-10001950",
      "title": "Green-checkpoint red twice: diagnose current failing tests, fix forward, rerun verdict, and restore main green",
      "parkFingerprint": "ebe6df6d024ee671574dd0b4f3f8f72975caca4635e2370da50e50dae88771ef",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Canonical gate owner WI-10001906 reaches terminal and the green-checkpoint verdict is fresh; then reconcile this duplicate item.",
        "owner": "su-638ae8aa-ba1e-47a7-b96c-53216e41ae0b",
        "trigger": "work-item:done:WI-10001906",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-26 13:44:19.498019-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "WI-10002037",
      "title": "GATED on the instrumentation signal, not on enthusiasm: extend the SAME primitive to claim-spec authoring (the owner already graded *4 a sibling preview/lint idea asking for match-count + sample rows…",
      "parkFingerprint": "4ed6cc93a3dd25af0faa54e2797e5758af0f13fbda8dd74634652aef3deaca62",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "dev:advisory_bet_signal returns a NON-indeterminate reading for the triggerTooNarrow falsifier — i.e. the P-002 partition advisory and the P-003 fire-writer are both live on :3070 AND a measurement window has elapsed against that live writer. The deploy is NECESSARY BUT NOT SUFFICIENT: unparking on the deploy alone reproduces the same false zero with a smaller denominator, which is the exact error D-002 exists to foreclose. Re-read the signal before unparking, never the raw count.",
        "owner": "su-7f549ee4-98fb-4a57-8522-cb18f9e2a10f",
        "trigger": "release:deployed:<sha>",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "WI-10002411",
      "title": "Green-checkpoint gate WEDGED and UNOWNED: checkpoint ends skipped-locked (no verdict) while the frozen repair queue awaits a dead fixer; operator-core test:lane-stateful red at repair head bcaeebfb",
      "parkFingerprint": "f265dda2249076098b1fa48395ceda92c92c0c13827bddc4473286dcafe056cd",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The active gate repair lane's exact predicate for verdict on repair head 557ba0ff26c45d353b712e78576ae00d0483afc0 fired; then re-check current ownership/candidate before acting.",
        "owner": "su-d06fbaa6-320a-45b2-b0a6-5e5ed2f8dc44",
        "trigger": "predicate:650beaa3-bbe5-4be1-8b57-5d804e198381",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-23 02:04:58.632746-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "WI-10002423",
      "title": "Cut and publish desktop release 0.0.22 from the latest GREEN main (owner directive #85)",
      "parkFingerprint": "8c35d01186f655fe3ea27d6af5b7fa746108ca8f47e00bc7a451b7e37b8ddcd5",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "EI-24294628776810491 is completed with the current orchestrator executing current producer tooling; successor must rerun release:cut preflight and require go:true.",
        "owner": "papercusp release-tooling fixer",
        "trigger": "work-item:done:EI-24294628776810491",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-26 16:18:32.865852-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "WI-10002866",
      "title": "Ended session loop can be rearmed through active system-wide stand-down",
      "parkFingerprint": "a2b26c5179728638720126953c3c9b692b3e9a186d3f9d8451c3511e342977d0",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "An authenticated interactive-owner directive explicitly lifts the 2026-09-24 system-wide standdown and authorizes source work.",
        "owner": "su-bce45d81-6ee6-47f8-bb83-fd8a803cd261",
        "trigger": "coord:inbox-wake:su-bce45d81-6ee6-47f8-bb83-fd8a803cd261",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-27 01:38:54.729332-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "WI-10003044",
      "title": "Independently grade installed PUI release candidate against acceptance rubric rev6",
      "parkFingerprint": "95ae6a848520a224e7dd30d3be1fd7fbb6765c7be7432312d3220c13d993fab4",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-10003192",
      "title": "hn-apply falsifiability-probe drift: 2 of 38 mutations report SURVIVED from stale probe anchors/expectation names, not weak selfchecks",
      "parkFingerprint": "8d76a00017d2b99aa956e70b4939adb4619390252666fcb0c50193dc1ac2cb54",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "A permitted hn-apply checkout/harness or isolated target is provided for WI-10003192, so its probe corrections can be tested without touching the shared dirty main checkout.",
        "owner": "su-c6ebfcdb-4118-495d-bbfa-d83998682668",
        "trigger": "coord:inbox-wake:su-deaa5f0e-098c-4f8d-bba0-b67c1f11cd7d",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-02 20:01:01.633282-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "WI-10003381",
      "title": "Run a small calibrated comparable-input/spend evaluation through existing Dream/Blender/experiment mechanisms; retain immutable prior study, human review gate, attributed model/reviewer/maintenance c…",
      "parkFingerprint": "1f9ad7afa30e75164270262d8fe0f90481953f93147013d632b5154ae2e4b5b2",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Required independent human source-cited calibration evidence is recorded and the approved solo implementation route is explicitly disposed before P023 operational comparison resumes.",
        "owner": "su-0da9d55e-30de-4a57-9380-8c81a7e3c99d",
        "trigger": "plan:acceptance:rem-dream-recombination-2026-08-17",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-02 00:52:08.670233-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "WI-10003946",
      "title": "Plan bodies rewritten at 19:47:41-19:48:53Z after the power-loss reboot without plan_revisions rows; generic-rag-chunking reverted to its pre-amendment text, erasing D-012",
      "parkFingerprint": "3236f6d63c6cdb7f71deaae1cc4abda959691cae3c304f68080f72a1eccc919f",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "A fleet leader sends this session a route for WI-10003946, or a direct inbox message supplies new evidence scoped to its source-attribution investigation.",
        "owner": "su-e0e49783-7554-4666-bc47-ee2ed2f94fde",
        "trigger": "coord:inbox-wake:su-e0e49783-7554-4666-bc47-ee2ed2f94fde",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-06 12:51:06.300631-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "WI-10004242",
      "title": "Hosted host: every boot re-runs the full workspace-host bootstrap, which restarts papercusp-workspace about 3 minutes after boot and kills any desktop opened in between (the units already report active)",
      "parkFingerprint": "d57dd239508ea56b1382d496361d7e14ed6228035692b5c5ebf06c12395e4d0e",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Re-evaluate WI-10004242 when the code-bearing staging SHA 1f73a7cf3d6275ba7d9b7006544e0776055427c4 reaches the live green :3070 operator; then verify that an isolated hosted-host release containing fix commit 0e239859 is installed on avi-test before running the reboot proof.",
        "owner": "release-gate",
        "trigger": "release:deployed",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-02 08:06:29.847347-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "WI-10004332",
      "title": "Staging operator (:3170) main event loop wedges ~24s and is SIGKILLed by event-loop-sentinel (2026-09-30 12:05:31 and 12:27:39 EDT; the second outage lasted ~5 min)",
      "parkFingerprint": "112ccc80e8e51ee176f3550781fd01fcc458b413fd84cea5d59ca531cfe78a9e",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "The current fleet leader explicitly clears this hold or routes WI-10004332 back for work after new matching evidence is available.",
        "owner": "su-c6ebfcdb-4118-495d-bbfa-d83998682668",
        "trigger": "coord:inbox-wake:su-ea6ee3af-928f-4fa9-8510-b8f1e3a4585a",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-05 20:07:19.67972-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "WI-10004642",
      "title": "Cupboard operator-public: routes/listings.ts should adopt the shared pinRefusalToHttp helper (dedupe refusal->HTTP mapping)",
      "parkFingerprint": "a318d1fa0116ec50fde0097125229ad03244b9c19bda3bc1f99a2c882048752e",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "cupboard-release-pipeline-content-trust-2026-09-16 P-010/P-011/P-012 finished so listings.ts is final; then adopt pinRefusalToHttp once and re-bind the 4 stale clauses",
        "owner": "su-cbf1bbd6-496c-4b19-8682-f480bb97dbb4",
        "trigger": "work-item:done:WI-10001655",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-01 06:50:41.130813-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "WI-10005119",
      "title": "Backfill-test the recurrence-evidence severity proposals before any auto-apply (follow-up to EI-23768242440859949)",
      "parkFingerprint": "95894921a5cd2f510e102fbedcc5806c95822132e0b3f86c3cfb7cb57eaaa1ec",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": true,
        "condition": "~2026-10-15 or later, once recurrence-evidence: comments exist in coord_thread_posts",
        "owner": "su-4a7d4f1d-e7a6-4886-97bd-e880eea7fdcb",
        "trigger": "manual:2026-10-15",
        "reachability": "blocked",
        "evidence": "no producer registration or catalogued resolver was found",
        "findings": [
          "reachability-unverified"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-10005450",
      "title": "Gate red at candidate 6ca43115: early changed-file typecheck (lint:tsc:workspaces, lint:tsc:operator, lint:tsc); main held at d740fc38",
      "parkFingerprint": "20551402022586e41c41e4e51e0843566ed9cadd9164f72caba168dfc53a748d",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "WI-10006055, the current live gate owner's work item, reaches done; the next claimant must re-read gate ownership before acting on WI-10005450.",
        "owner": "su-2b9fe461-077c-4fd4-8cd7-c43499f17892",
        "trigger": "work-item:done:WI-10006055",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "WI-10005804",
      "title": "Customer-cloud OMP cannot do any tool-using work: the pinned local model qwen2.5-coder:0.5b returns a final answer without issuing a tool call (GCP and AWS)",
      "parkFingerprint": "ba775b9f02d6a980ad6ecbc10064a836e0235f3246ccde46e312119154f804da",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Plan item P-012 in aws-byoc-gcp-parity-2026-10-01 reaches done; its explicit start gate for WI-10005804 then clears.",
        "owner": "su-e0e49783-7554-4666-bc47-ee2ed2f94fde",
        "trigger": "plan-item:done:aws-byoc-gcp-parity-2026-10-01:P-012",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "WI-10005829",
      "title": "Activate and ship remaining Papercusp monetization work under owner-directed AUTO",
      "parkFingerprint": "625b68995852067a6f1a8c839f0fadbc6f15efca91c082b89533ee1f0312036f",
      "lease": null,
      "assignment": "su-dae9d804-7887-4fc2-b09f-d62f9430b5ba",
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "Reconsider only when the original direct-self monetization route or its explicitly authorized successor is restored, or Avi changes papercusp-monetization-2026-09-04 D011/D013; fleet members must not implement this item.",
        "owner": "su-7bc9c327-070e-4aba-87af-e3eef1aa86df",
        "trigger": "work-item:claimable",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-10-08 11:17:54.886777-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "WI-10005884",
      "title": "V17 Git progress queue guard still reports idle expiry after parent-loop stall",
      "parkFingerprint": "880d3278d0c3d7528d06fe2e7a88ffdafa3495b2c714a15b8ea3d38592fee9ce",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Parent WI-10005128 reaches a terminal state; inspect its final evidence and resume this child only if it adds the original V17 child-exit/group-lifetime transition timing missing here.",
        "owner": "su-7a94555d-4fbb-42b8-a39d-ff28fade9e0f",
        "trigger": "work-item:done:WI-10005128",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "WI-10007100",
      "title": "improvements:capture requests shed after queue dwell",
      "parkFingerprint": "25772375728e48289df7daab06c16ded384def4760e82a79003c4a7e8e35f832",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": true,
        "condition": "Avi explicitly routes WI-10007110 and the EI-25275823759632311 consult follow-up to an authorized source session, or explicitly resumes WI-10007100.",
        "owner": "su-3ae55b3b-8547-4852-bff2-07f7019f03f3",
        "trigger": "A new owner conversation answer or directed instruction names the authorized recipient or directs resumption.",
        "reachability": "blocked",
        "evidence": "no producer registration or catalogued resolver was found",
        "findings": [
          "reachability-unverified"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-10007262",
      "title": "Reports unpublished-turn observation at journal seam",
      "parkFingerprint": "95e9dc994774becc55f48f892229b9813e2af4688ad93dcfac22fc8a8df22605",
      "lease": null,
      "assignment": "su-4375e570-0ffb-4d0f-8652-9d23635c5fe9",
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1030248",
      "title": "Use git-sync for the commit hop, obtain a fresh green-checkpoint verdict that contains the implementation commit, trigger deployment of that green pin, and verify :3070 serves the same candidate. Thi…",
      "parkFingerprint": "9d246fd7df7a715990eb839f873836a73cdd0e4e66acc0509aa0121d5f96deb2",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Owner narrowed the active mission to WI-1024071 mechanism only and explicitly excluded checkpoint/deploy/shipment work; park this shipment item until separately directed.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1031809",
      "title": "plans:revisions contentHash is identical across consecutive rubric revisions that change criterion prose — a staleness check keyed on it reads \"unchanged\" while criteria moved",
      "parkFingerprint": "65f99bcccf8b11b37f8b9de240f4c0bf87335d566385a55f4920eb6f2e906599",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Fleet wind-down: current checkpoint records the live evidence and no completion is justified; release this session's claim without pulling new work.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1194246",
      "title": "Decide + roll out a statement_timeout that actually survives PgBouncer for the org-admin pool (adminPoolStatementTimeoutMs is stored at 30000 but inert at connect)",
      "parkFingerprint": "4739816aacaae9ac112bc7c31bcb3b21e633199712d1747d0744a49b098f3d18",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Analysis COMPLETE (steps 1, 2, 4 resolved — see checkpoint); only the ALTER ROLE rollout remains, and the item's own rule \"Do not set a value during a red gate\" forbids it while the gate reads inconclusive/repair-in-progress (candidate edaf692e90e8, verdictStale=true). Held out of self-select so it is not repeatedly claimed-and-released while that condition stands. UNPARK when state:read { cell:'gate.greenCheckpoint.verdict' } is green, then run: ALTER ROLE harness_admin SET statement_timeout =",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1331172",
      "title": "Codex Luna requests on aviynw6_codex 429 and silently soft-fail over despite separate Luna quota",
      "parkFingerprint": "4db08b3d8b859f9e9c91cb0868b999bc6059f7595926f130c3c6dc491b487a9a",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Owner-directed fleet pause after checkpoint; preserve the unfinished Luna reserve work without allowing reassignment until resume.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1338374",
      "title": "readInbox() unbounded PG fast path (LIMIT 25,000, jsonb wide-body scan) fires ~32k times over 10 days despite every identified direct caller already being windowed/since_ts-bounded — the caller is unidentified",
      "parkFingerprint": "039e3131be8747d202eb3d6c40c07313de7cc0e4107a41c73a2944f443821757",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Parked: unadvanceable without deployed instrumentation (or a multi-minute pg_stat_activity sample); re-handed to me twice in one turn. Unpark condition is in the checkpoint head.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1386682",
      "title": "psu-pty-host: make quota-blocked sessions a first-class state — don't inject wakes into a rate-limited TUI, and never let any submit path kill one",
      "parkFingerprint": "47c3244ca1cf0bb75f55b433a8e04dcf6058c64f3797ba2f624b2922c5b74fc7",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "[fleet-pause:feature-change-drain-2026-09-01-v2] [owner:Aviyn 2026-09-01 ~22:52Z interactive] \"TELL THE FLEET TO GET TO A STOPPING POINT AND THEN TO PAUSE THEIR WORK\" — members: finish the current atomic step only, work_items:checkpoint every held item, release claims + locks, loop:end, ack the leader; pull NO new work. Leader su-60757119 keeps its monitor loop only. Lift with fleet:resume on the owner's say-so.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1439",
      "title": "Owner human acceptance at the mic: desktop round-trip + TUI `v` PTT and `V` session (the never-done human-acceptance items)",
      "parkFingerprint": "25efb0aad17cd512a82209e18c23df2b2b9fcacb2fdae2098c0337d12117afcb",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Cannot be executed by an agent: this item's acceptance criterion IS the owner human speaking at a microphone (desktop voice round-trip + TUI `v` PTT / `V` session). No agent can substitute for owner human acceptance, so claiming it can only ever waste a cycle. AUTO mode lifts permission gates, not physical capability.\n\nclaimHold:true (not a plain release) is deliberate: this is at least the THIRD agent claim in ~6h. Two codex sessions (5h and 6h ago) each recorded the identical outcome — claimed",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1447249",
      "title": "Migrate 3 oddsmith Unix crontab entries onto DBOS routines",
      "parkFingerprint": "39ca3b21330f152d9d7c32f84358516273be0acef93425b9e007ff64d8efe903",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "[owner:Aviyn 2026-09-01 ~23:00Z interactive] fleet feature-change-drain-2026-09-01-v2 paused then killed on owner directive; holders su-aa154bc7 / su-1f3de9d7 / su-0f11ccd2 / su-0bcdcbdc were SIGKILLed 23:04Z by fleet:kill. Releasing their claims with claimHold so the items stay parked (not self-selectable) until the owner resumes work; leader notes are on each item.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1607141",
      "title": "A transient provider \"model at capacity\" rejection kills a release-fixer, burns 1 of the repair queue's 3 attempts, and its diagnosis is then overwritten by the generic reclaim sweep so no escalation fires",
      "parkFingerprint": "8025a9b0461cdd293328164d4dc66b35c83ba743a439fd14eb9dd1b82340ff46",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked on the live WI-212675/repair-queue gate; preserve checkpoint and exclude this item from self-placement until the gate owner records the exact terminal transition.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1659159",
      "title": "Rail: decide whether a switched-OFF pot with armed lanes should collapse into the dormant tail (currently stays active; 7 of 28 live)",
      "parkFingerprint": "76f4c07a2a6dea24b14415734166a089e23119b9497ce08cd968570e07404dbf",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1671775",
      "title": "code:run script authors get fully-typed tool ARGS and an opaque Promise<unknown> RESULT — the runtime knows the real shape and only reveals it in a fatal error, after write-effect calls have already executed",
      "parkFingerprint": "899e3e633e3d030b0b1f6340287b1676fa5064f9060ae3d489260188bfb80c1d",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "[owner:Aviyn 2026-09-01 ~23:00Z interactive] fleet feature-change-drain-2026-09-01-v2 paused then killed on owner directive; holders su-aa154bc7 / su-1f3de9d7 / su-0f11ccd2 / su-0bcdcbdc were SIGKILLed 23:04Z by fleet:kill. Releasing their claims with claimHold so the items stay parked (not self-selectable) until the owner resumes work; leader notes are on each item.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1721713",
      "title": "Carry plan unified-web-portal-2026-08-29 to shipped: 11 remaining items + completion discipline (audit, rubric, independent grading, ship)",
      "parkFingerprint": "09a31e00b11eb9edaa3c285abda40d4566c35a4622f9122df53f5158d097b67c",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Canonical whole-plan custody is now live under su-421249e2-c0ff-4683-a5e4-f519b74d9a12 with all five remaining claims; release this stale duplicate umbrella claim while preserving the needs-human hold until hosted credentials/profile and downstream acceptance clear.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1849373",
      "title": "Migrate `agent-tools/operator/converse.ts:708`. Blocked by P-004.",
      "parkFingerprint": "a3ae16e81b414e7508e1bd16dc195c0af04969b26b4e2eaff6131507cc3891ca",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1849380",
      "title": "Migrate `agent-tools/fleet/place_batch.ts:578`. Blocked by P-005.",
      "parkFingerprint": "46b42373e47b175c020efa63944d81e578ee662400e01a139090df64dce9c18f",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1849382",
      "title": "Migrate `papercup/papercup-deep-delegate-deps.ts:152`. Blocked by P-006.",
      "parkFingerprint": "7cf8bdf6f785af322cd88a26f5e23786fb015fd67bd9b8f5d89d9d5905d8643a",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1849388",
      "title": "Migrate `fleet/spawn-relaunch.ts:90` — recovery machinery begins here. Blocked by P-008.",
      "parkFingerprint": "9a830436122367a3d36c0a9bfdd1a4e8f892903513857bb706802806a2df0acd",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1849389",
      "title": "Migrate `fleet/supervision.ts:175`. Blocked by P-009.",
      "parkFingerprint": "742f5d87bf40ff94ea3050fd25b670846dc9d98b9f64ff1b2830059d26810560",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1849391",
      "title": "Migrate `events/await/wake-executor-fresh-context.ts:92` — the riskiest; a blocking admit here delays the wake that recovers a wedged fleet…",
      "parkFingerprint": "61fdd24efbed320167ca7ac45495c4f6d723551f4df4ab0e22ccf3c13977b2e9",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1849393",
      "title": "Migrate `spawnAgentInHarness` itself onto `spawnGovernedAgentProcess` and retire the parallel `effectiveSpawnCeiling` ceiling once the seam…",
      "parkFingerprint": "2ed46fe9d9d3443bd7c539be65beeba17552a043acd135ee84a6e0eed4d58d87",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1849394",
      "title": "Lease-leak soak + rollback drill. A leaked lease starves every future spawn, so the acceptance bar is: forced-throw spawn, killed child, an…",
      "parkFingerprint": "5f2107b73af31757e1379b5ee807098ffa454862dac8f49668a74446b0dea328",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1849395",
      "title": "Migrate `iq-battery/bee-instance.ts:270` — the EIGHTH caller, found by census in D-012 and named by no earlier item. Same terms as every ot…",
      "parkFingerprint": "4dc6038e86836b05fb4e50980d627183af1a27146f4c8c2ee2167066550cf0b0",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1859229",
      "title": "Build a potato storefront app (from papercusp-app template)",
      "parkFingerprint": "8afa27709bcef1f77fdb6bd7b3a7f7a157f6f8222f18fbd3502a4bbde36de85b",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-189",
      "title": "Run the fixed no-Queen FIFO control on the 11 (then join it to the ladder rungs) → grade → the Queen-vs-no-Queen delta (hive resolved% vs F…",
      "parkFingerprint": "2545331a86fe82dfb6abe89256e64fc2c0fbebda4e8d51ea2531bc5b30236cde",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1929159",
      "title": "Repair frozen green-checkpoint candidate 5738f881 reds",
      "parkFingerprint": "d36f82c4631c84c5f3f2f1c8267fc961764a5b0fb8d8ae00578f762e8fe7e696",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1940863",
      "title": "Repair frozen green-checkpoint candidate 5738f881 failures",
      "parkFingerprint": "30cc4f97aa81747e2baf4581ba1ac5e0bf03d3d3738f5107e2ddcd537ef6c78d",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-1959728",
      "title": "Repair wave: fix measured gate reds on staging so frozen candidate 15da128b converges",
      "parkFingerprint": "22dda6c3e643b4dfd4d588dd1f79e4fa4b3d81b3d9b1aec8f4444dd3cea486e3",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2093354",
      "title": "Record a real occurrence of the everything-goal ENTERING audit when a lane stalls (c5 is proven installed, not proven behavioural)",
      "parkFingerprint": "1b3f5dff2d1d09d73fc77840b8e3b7552368d320376d88ec74d36e77844e7087",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked on a NATURAL occurrence (typed event blocker on the item carries the probe). Three surfaces verified-empty 18:39-18:42Z; nothing an agent can do now short of staging, which would not be the criterion's behaviour. Parked out of self-select; claim by id once the blocker's nextVerb SQL returns a goal-holder row.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2140337",
      "title": "Repair frozen green-checkpoint candidate b8de1000 lint failures",
      "parkFingerprint": "d2bf3a78ccd054581e9d0767899faabb8857c707cc81729e77b8ac2883dde4dd",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2140811",
      "title": "Repair frozen green-checkpoint candidate 5392cbe5",
      "parkFingerprint": "7f4bb7a7ae381ead62f3739572c9ba4c3c491d7f5c87806a8a084ddfebe6a78f",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2140843",
      "title": "Repair frozen green-checkpoint repairHead 188c78e4b2 lint regressions",
      "parkFingerprint": "81a674297a15776272965a29b2fb7c9552e0eb7827ddf9c8e89406f42fb16d67",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "LIVE_GATE_OPS — not my lane. Auto-claimed by the drain claim-spec (rev3 bug/change/task), not chosen. This is a delegated release-fixer repair for frozen candidate edaf692e90e8 / repairHead 188c78e4b2, assigned by s-1788294289351-41523380; the green-checkpoint gate has exactly one fixer and it is not me. Also likely STALE: it names candidate edaf692e90e8 from 2026-09-01, while the live repair queue has since moved on (freshness lane=validation, likelyStale=true, source+runtime SHAs both moved).",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2141073",
      "title": "Live card-vs-prose behaviour in the portal chat is unverified end to end — the residue the acceptance card pinned to WI-4950, which is already DONE and therefore carries nothing",
      "parkFingerprint": "a6822dd31ad167177a25058bca397010e08de802edf2fc90b9f8f35a43f908e9",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked on external deploy dependency (WI-7139 fix stuck behind WI-212675 gate-red-streak) — not self-selectable until that lands; releasing my concurrency slot to continue DRAIN pull.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2141796",
      "title": "Substrate merge on log cb54460d98d8 is PINNED at position 12048 across ~39 harness cursors — inbound coordination dead since 09:42Z; the frozen guard DOES fire (126x/5h) but no repair, and no durable EI (24h cooldown)",
      "parkFingerprint": "fa5c28a19344df26a9e1fd7ec7335051065bf3b5a2022467afbeb6f0bd2417e1",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Park — root cause genuinely unresolved after 3 agents (2 falsified hypotheses); the only remaining investigative lever (per-get latency vs host I/O pressure) must run INSIDE bg-host, which no tool-calling session can do. Unpark condition: (a) the stall recurs (remote_rows stops advancing again — re-open/re-claim then, evidence will be fresh), or (b) an agent with bg-host-internal execution access picks it up specifically to run that measurement. Do not self-select otherwise — re-investigating wi",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2142252",
      "title": "Standing-cooldown gate has no valid discriminator between a resumed episode and a genuinely new one (fault 1 of WI-2142025) — needs backtesting against WI-5762's flap dataset before shipping",
      "parkFingerprint": "c35b2fed648998707ee742e7fab1a7dbc88c652c8638e0b39ada356c50c74df3",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Needs a dedicated research pass (script-based terminal_owner-partitioned gap analysis), not another ad-hoc single-pass claim — three independent sessions have now re-derived the same 'too risky without more data' conclusion. See the 2026-09-02T20:32Z comment for concrete findings (resolvedAt/closed_ts contamination by hygiene/dup-collapse passes) and the recommended next-step design. Unpark once someone brings a proper backtest script or the owner makes the tuning call.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2142667",
      "title": "Acceptance rubric C1 clause 3 is a conjunction that can never fire once a deployment position is honestly recorded — the fail floor has a hole exactly where rev 3 aimed",
      "parkFingerprint": "032340583f6d1efb59ef9f88ac20c007cbb2714a8ff8ce4ec93f51d0c436ade7",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "PARKED BY DESIGN, not abandoned (plan silent-wrong-answers-2026-08-01, D-129b). The defect is real: acceptance rubric C1 fail-clause 3 is a conjunction that can never fire once a deployment position is honestly recorded, so an honestly-not-deployed remedy cannot reach fail. It must NOT be fixed now: any rubric revision bumps the pinned version and invalidates BOTH the standing author attestation (EI-22182186991565704) and the two banked independent grading cards, and I authored the rubric — so I",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2143424",
      "title": "DEADLOCK: the freeze-and-converge fix (WI-2141736) cannot deploy because deploying requires a green main, and main cannot green while the gate runs the pre-fix build 6e898b6cf8",
      "parkFingerprint": "c21cac7c32627afb2cadbb13ee7c5ce8c41f7f7beeae82a3e2c74d2ab37f4e5d",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2143626",
      "title": "A FAILED workspace-host destroy strands provider resources and nothing ever sweeps them",
      "parkFingerprint": "ab9c6aac278d140fb2bf58850ef3c8120e8cc37ed40b4465c1b6a2ceb32ad8a1",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2143725",
      "title": "Rotate the credentials now sitting in private GitHub repos: storewolf config.jsonc (38 secret / 9 credentials / 6 token / 2 password keys),…",
      "parkFingerprint": "5f0bfa5f7d039b163eeca61f8c7250fba215a94f173974a01fa713307516719b",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "UNPARK WHEN: Avi has re-issued the third-party credentials at the provider consoles (Amazon SP-API, AWS IAM, Product Advertising, eBay, OAuth refresh tokens). Until then no agent can advance this — D-020 measured the wall as a CAPABILITY limit, not a permission one, and it survives sudo. The GCP service account + self-issued secrets half IS agent-doable, but only after the third-party half, so the whole item stays parked.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2143726",
      "title": "Relieve /mnt/data disk pressure (97% full, 293G free). The 2.0 TB swapfile on the data volume is the largest reclaimable item and its I/O c…",
      "parkFingerprint": "0e59ae56b040e14bfc165af2552f6c3f01d6f89d5cb2c118683051e39b2d45be",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "UNPARK WHEN: Avi decides between (a) reclaiming one of /mnt/data/Backup 2.3T / back 547G / offload 520G, or (b) authorising the sdb swapfile relocation. D-008 permanently rules out swapoff on this host. Deleting a directory named 'Backup' during a data-preservation project is not an agent call, so this cannot self-select.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2144021",
      "title": "Nothing reconciles a deferred workspace-host spend obligation: `spendSettlement.reconcileAfter` is recorded but never read back, so a torn-down host's true cost is never learned",
      "parkFingerprint": "80be64027f472f5b02a907f606925cbf630ec0c4e33b58c54b37ad36cb555194",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "New 21:07Z owner-verified system-wide pause lifted and BYOC fleet resumed",
        "owner": "su-f48fd476-39f2-4e33-b9d0-23c18c9c00e2",
        "trigger": "fleet:byoc-alpha-ship-2026-09-05:resume",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "WI-2144618",
      "title": "Workspace DB dump is stale after its latest snapshot hook degraded: /home/marsh-office/.papercusp-workspaces/default/db-dumps/pg-embedded.sql.gz is 133h old",
      "parkFingerprint": "933bb6af0a79afba8032a24feeca34497b249437dafa128164b751292a7a38bc",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2144760",
      "title": "bg-host migration gate timeout bypasses PG merge-cursor injection",
      "parkFingerprint": "be06995ff8ecf0427b1571e51df5354e1c7ad5d044a995498a6869dee886afbc",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2145064",
      "title": "Ship-gate prep for fleet-friction-remediation: per-item code-truth audit of the 11 terminal items, then P-012's runnable suite half",
      "parkFingerprint": "1a6c41d778c27dfd52a828f7bb2b6168efb75b4e2205e1970981feb5cc89a931",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Stood down on leader order (coord-send-3370e6b3): fleet goal auto-killed 02:17Z on a spend-floor breach. Lane 1 (code-truth audit) complete and checkpointed; lane 2 deliberately skipped. Parked out of self-select so no agent auto-pulls it and spends against a killed goal — still claimable by id once the goal is refunded.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2146170",
      "title": "Code-truth audit of terminal items on tool-contract-class-sizing-and-non-vacuous-guard-2026-09-05 (P-001..P-004, P-006), preparing the ship path",
      "parkFingerprint": "e119d56d2f285d83682606a281b2ced0755cc2097c454f5791abac74f842bb60",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2146425",
      "title": "Commerce door 403 codes are an org-EXISTENCE oracle: not_org_member vs org_membership_unknown tell an unauthorized caller which org ids are real — latent until an org writer lands",
      "parkFingerprint": "9e8739aa81f38defdd7ac8083611ab79a9e83778f35c4a7bb3111c2de90dd3e4",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": true,
        "condition": "An organization writer lands and populates a verifiable organization roster.",
        "owner": "Commerce organization-writer implementation",
        "trigger": "org-writer-lands",
        "reachability": "blocked",
        "evidence": "no producer registration or catalogued resolver was found",
        "findings": [
          "reachability-unverified"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2146767",
      "title": "acceptance-tool-contract-repair-2026-09-05: import the drift markers into the METHODs and make the three sampling selections deterministic/adversarial (vetting findings, next revision)",
      "parkFingerprint": "8b8465fe04c96dfbfedd058bf49547c05ec1c4472385e7c940a3fc1db60645b1",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2147285",
      "title": "Independent acceptance grade: Gmail OAuth system-browser repair",
      "parkFingerprint": "85180996cd4c856f3c569a896b7a618915035da186050994a9aebd45daf2b2a2",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "satisfied-still-parked",
        "contractPresent": true,
        "condition": "A lineage-clear peer (not su-e092c904's lineage, not su-5f956832) has emitted a CURRENT meta-acceptance vetting attestation for rubric gmail-oauth-system-browser-2026-09-05-acceptance, clearing the acceptance_rubric_unvetted gate. Tracked by WI-10001615, which blocks this item. Until then this item is unworkable by ANY claimant: the gate refuses before grading, and the grading is already complete and preserved in this item's checkpoint.",
        "owner": "su-39e41ed7-a7aa-45f6-9fed-3f458fcf52c1",
        "trigger": "work-item:done:WI-10001615",
        "reachability": "satisfied",
        "evidence": "event fired at 2026-09-16 23:01:27.96799-04",
        "findings": [
          "condition-satisfied-still-parked"
        ]
      },
      "disposition": "reconcile-candidate"
    },
    {
      "id": "WI-2479",
      "title": "Persistent fleet headcount target governor: declare target N once and auto top-up via routine",
      "parkFingerprint": "d6de5bdc60b8e7eefde7d52906edfbab00b3415155e1502f4b82071e72525c8e",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-249919",
      "title": "Run the pilot; independent (non-implementer) grading via scorecards; record the verdict and per-tier deltas — note: Blocked — see D-041, up…",
      "parkFingerprint": "46c3b4ede1b79e0907348c9b92b408394cfdc942e42566d3f6b94285daa88537",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Keep dependent lanes parked while WI-212675 owns the sole gate operation; resume after terminal verdict reconciliation.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-2656",
      "title": "Backlog-clearance loop wake: pull + resolve next scheduler item (papercusp)",
      "parkFingerprint": "de642d9479310bd0082ac66db268a1334aff145ec704d6fca466bdc61bdc25eb",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-3065",
      "title": "papercusp-desktop submodule: 77 seed corestore blobs (~1.5GB, 50–99MB each) were git-TRACKED — untracked+gitignored 2026-07-05; history purge still needed",
      "parkFingerprint": "f6c464f73927aa1ef25fbd462ed91a0599b385bb36be10221bf7b0468971fc0e",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Re-released with claimHold: a plain release put it straight back into self-select and it was re-pulled 6 min later, which would churn indefinitely since its GO conditions are unmet and unchanged. Checkpoint (hash 99e50043b730) carries measured ground truth + a 6-step GO checklist; nothing to do until gate.stalled=false, checkpointRunInFlight.active=false and mainFastForwarded=true. claimHold only excludes SELF-SELECT — a direct claim by id still works when someone deliberately takes it on GO.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-307101",
      "title": "Deployed plans:audit still uses a stale staging-first guard while current staging already passes the canonical BYOC plan",
      "parkFingerprint": "e84c3bf76fb53a646048f59a3940505b0b67bfbcb0faa7264cdbbe9166f3077a",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked on current staging-first guard reaching deployed operator; live gate owner has evidence, so release this claim and keep the durable park while I drive P-046.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-320341",
      "title": "Repair frozen green-checkpoint candidate e7e9f4d2 typecheck regressions",
      "parkFingerprint": "a31076ab1826a58d57d8b255594dc7d45ef99a27f4c715d68bc40091ed09acaf",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-3328",
      "title": "Build-#5 fleet-launch E2E on the Windows VM (owner-directed): spawned agent creates a new pot + dummy app + fleet of 2 Sonnet agents; verify the fleet launches with NEW VISIBLE TERMINALS opening via the desktop bridge",
      "parkFingerprint": "8cce8058b932e9964203e312ec5ac400a5faf29eff147d0a82eb3a23b529eace",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked by WI-3360 (console-launch bridge never registers), verified live 2026-08-04T05:00Z: capability:terminal fails immediately at all 3 healthy VM operators. Parked so the default oldest-first claim spec stops re-serving an owner-directed E2E that structurally cannot pass. Full state + VM environment + reusable VM scripts in the checkpoint; unpark when WI-3360 clears.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-3386",
      "title": "mac GUI: webview cut off on the RIGHT — release button (far-right of env bar) off-screen",
      "parkFingerprint": "89922e8be9c0373c745c93dd592993c85537fa7aa6e65d5c15c14c54d6e7dbc5",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-3467",
      "title": "Full verification (supersedes restore-pot P-019): typecheck + test:all:integration + live fleet smoke (create pot → brain→cup placement → coordination/steering/wake under new names) + re-run release-…",
      "parkFingerprint": "43276abe64a6d74bcd4eed0fa7f4e9a02387e2920beccac513ae753d714bc5bf",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Leader park (su-60757119, 2026-09-01T19:23Z): WI-3467 'full verification' presupposes the cup-lexicon rename is complete, but member su-0f11ccd2 measured 38,515 residual non-kept lexicon hits (scan-lexicon.mjs @19:17:53Z, plan Decision cup-lexicon-full-rename-2026-07-09#D-004) vs the ~174 the plan assumed. Verification cannot pass until the residual rename lands; keeping it self-selectable would make every drain member re-pull and re-discover the wall. Claim by id only, after the rename residual",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-3573",
      "title": "Restart search: decouple Typesense collection from remote embedding provider (local MiniLM default + keyword-only degradation)",
      "parkFingerprint": "6e743e06be756e50cac20d2189cf002187bee3e3fa67ef58a49bf5c99e53fb3d",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Released unworked. (1) OUT OF SCOPE: I am a mobile-greenfield-build member (mission: execute-fleet-plan-only); this Restart/Typesense item was admitted only because claim spec fleet-launch-mobile-greenfield-build-kinds rev3 filters by KIND, not plan. Reported to leader as a spec defect. (2) OWNER-GATED ANYWAY: prior checkpoint (su-07374fbd, 2026-08-08) records Restart prod OPENAI_API_KEY quota exhausted, so its remaining scope cannot run. claimHold set; claimable by id once billing returns.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-361476",
      "title": "Run the focused seam suite on settled HEAD, then the conservative broad sweep, and finally the fresh canonical root `npm test`; preserve complete logs and terminal markers.",
      "parkFingerprint": "c379034a44f175c9cefac5fe5016f70db3f934c23e0e8efb7249d312116f5ddf",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Released un-started, and RE-PARKED (claimHold) because the park that should have prevented this pull has lapsed. scheduler:get_next handed WI-361476 to a NON-FLEET session at 13:06Z under the default spec; D-004 gates its broad/canonical verification on a fleet leader's bounded release (staging HEAD verified, named runner/test files clean+unlocked, host.memoryPressure ok), which a non-fleet caller cannot obtain. Prior leader direction on record was to retain claimHold and not scheduler-pull/clai",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-36794",
      "title": "Workstream H(a) ADOPTION — build the NIGHTLY bundle: tauri identity overlay + channel-aware data home + daily trunk cut (the model shipped in WI-36746)",
      "parkFingerprint": "518ceb0137b0155bc6793bce2ceca2be0839d5ac47286b2d95ed1d4a7420e4ca",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked on an unrelated already-owned red gate (WI-212675) and an open unassigned infra bug (EI-22047168222679674); a 3h real build already timed out once. Not suited to a fast drain-cycle member — see checkpoint for full diagnosis. Leader/long-lived-session pickup recommended.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-368584",
      "title": "Commit verified sync-resolver filter-field fix for WI-212675 gate",
      "parkFingerprint": "beca82eafaee01b3a97b8200ada7fd58863c2878d2824688b2f2576848902a0a",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Keep dependent lanes parked while WI-212675 owns the sole gate operation; resume after terminal verdict reconciliation.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-37393",
      "title": "Thread goal_id onto the work-item wire row so the GOAL chip and the ?hudgoal= cross-tab filter can exist — the column is stamped but no read path carries it",
      "parkFingerprint": "7753e5e826c40a84664a73b11305e57593bc2e374821aff305767376d0238563",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Ordering-blocked, and parked to stop the queue re-serving it. Both prerequisites are still open as of 2026-09-05T03:30Z — WI-37376 (P-021) and WI-37377 (P-022) — and the item's standing instruction is DO NOT START before both. I am the third holder to claim and release this unstarted, so leaving it self-selectable just spends another drain agent's turn rediscovering the same block. UNHOLD WHEN: WI-37376 and WI-37377 are both terminal AND the scoped non-terminal goal_id population is materially a",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-37476",
      "title": "UNEXPLAINED mass desktop death: 3 desktops died in one launch, 2 of them on ISOLATED target dirs that build never touched — mechanism undetermined, and the obvious explanation is ruled out",
      "parkFingerprint": "878e6e6138a601170f4f50417935275b240a4520e8adab4b9906d8d04f4146fa",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-37504",
      "title": "CHEAPEST-FIRST CASCADE rather than an always-on rewriter — the design that answers D-046's latency/cost objection instead of refusing it. T…",
      "parkFingerprint": "4199508cbc33afc80d19f0a020cdfe5bbab83d76c479f55f4d6a10c25ecd511c",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "P-019's remaining work is the ESCALATION TIER, which the plan (## Now rev 141) and plan-item metadata both mark OWNER-GATED to the parent plan context-injection-audit-2026-07-28's P-006. The predictor half is delivered, measured and verified (D-095/D-098). Holding the claim signalled work in progress that is not mine to do; claimHold parks it out of self-select so no peer auto-picks an owner-gated item, while it stays claimable by id when the owner opens the gate.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-38323",
      "title": "release-fixer: classify + clear green-checkpoint red at candidate 538813496d2c (3 test files + lint:guard-reachability)",
      "parkFingerprint": "ea5ced3b64ba35b1243f65a7d8d498fc6e41089ea8d52de3c624021ecce06e53",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-38341",
      "title": "A peer's git-sync hold is honored on the happy path but silently bypassed two ways — acquireLocks 'error' has NO caller branch, and CLAUDE.md's tier-3 probe recipe hands out a 600s TTL with no heartbeat while git-sync heartbeats its own",
      "parkFingerprint": "eec1038ad07c2c481fd956f24599e28d66b282c4a4e65f1960dd5ccfd972b5ef",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-38342",
      "title": ":3070's pinned PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB=12288 puts 16 request workers permanently between the GC trigger and an unreachable recycle — ~350 useless full GCs/hour, and the one lever that reclaims never fires",
      "parkFingerprint": "24c9b4a9271d02c02aff961e1982d60e3236d6c17bd644c9465afbb064ae48a9",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-3849",
      "title": "Follow-up: find + fix the exact native binding that throws Napi::Error/SIGABRT during substrate teardown under critical event-loop lag (needs live debugger/core dump)",
      "parkFingerprint": "e630d6666a8256bc2d32d71b5a6596ef2d7351df69d75b10bcdb8710a048661c",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-38508",
      "title": "Run bounded drain canary and prove net-negative admission flow",
      "parkFingerprint": "fc3b7177e3090ee58057969b5bfefa6e3677e1399e42fbc0dc42628cc1c23ad6",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-38602",
      "title": "Run the canonical npm run dev launch from the same audited source and drive the identical P-002 functional matrix against an isolated data directory. Record the actual command expansion, environment,…",
      "parkFingerprint": "b27dfc0326a71390c9399e529ed2bfd35dc1db41f966e1f238a0a22cefa97f46",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "UNPARK CONDITION: both :3270 AND :3274 return zero listeners (dev:listening_ports), or Avi authorizes a route. Blocked on D-008, which forbids the only three agent-available escapes — port substitution, operator reuse, and stopping Avi's live desktop — while PID 2067090 (the operator backing that desktop) holds both ports. Re-verified 04:0xZ. This item churned through 6+ agents in sequence, each re-deriving the same block and releasing it back into the pool; the plan-item `blocked` flip alone do",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-40148",
      "title": "Evaluation checkpoint: after ≥200 dreams, report the funnel + dedupe-survival vs. lens ideation to the owner; keep/expand/kill decision gate.",
      "parkFingerprint": "c6ca35e1edce39313e80422f7f47afd035b8cb7ca027c5061c55bb9abd78cbc7",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Avi answers the final Dream P-008 disposition/human-validation question or explicitly resumes this lane after the system-wide stand-down.",
        "owner": "su-47689c3d-58bd-475e-ac01-7249394c8aea",
        "trigger": "conversation:answered:conv-mu1b09fl-0000-e93db624a940465bb51e72c19d9c6348",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "WI-40195",
      "title": "Deploy and live-prove Ctrl+C-safe desktop terminal runtime",
      "parkFingerprint": "4f42645982e12fcc9bd4f90f370d7cb8c8b71e6a533054eee606f480811cf2af",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Protected by active validation-only stand-down: generation 2 remains declared/unfired with null actual_sha/fired_at/fired_by. Keep out of scheduler until the exact qualification event or explicit current admission allows serializer/checkpoint/deploy/source work.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-40435",
      "title": "Android 16KB-page emulator image (sdk_gphone16k_x86_64) cannot resolve ANY third-party launcher activity — install succeeds, `am start` returns START_CLASS_NOT_FOUND (-92)",
      "parkFingerprint": "256360fd1da52ebfa17e86e3317ecb260376a5f8242b1c9dcde458f4eab4e445",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Affected sdk_gphone16k_x86_64 / emulator-5560 is unavailable; delivery-time checks only find standard 4KB emulator-5554, so fresh 16KB reproduction cannot proceed. Park until that image is available.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-40532",
      "title": "Independently supersede the acceptance scorecard after the exact green checkpoint",
      "parkFingerprint": "c141904dca9980f7799bf1d7a29b50665f9e9c84e241df537d1bc460a97f57fe",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "[fleet-pause:finish-plan-acceptance-20260813] Owner-directed system-wide stand-down: finish the current atomic step, checkpoint/release cleanly, stop loops, and remain paused until explicit resume. | [auto-drain-stamp 2026-08-25T18:05:53.505Z · spec finish-plan-acceptance-independent-grade (spec rev 5)] 1 in-lane issue-family row(s) matched the fleet spec's filter; stranded by: taken=1 (buckets independent; 0 surviving ALL floors ⇒ the lane is genuinely floor-gated, not premature). Re-verify against the authoritative oracle (no hand-rolled SQL): scheduler:get_next { harness: 'papercusp' }.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-40939",
      "title": "E2E acceptance: live Slack mention launches a plan; live email produces a draft; both driven and verified through the desktop app (tauri-agent-tools); triggers docs page",
      "parkFingerprint": "a5db0871f01e66b8136e3f8a29e198c572801cab214b937bc2df112777bfb0ce",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-40972",
      "title": "Extend the existing scheduler rank DSL with dependency_unlock_score; compute and expose the score with deterministic explainability; add focused unit/integration coverage for ranking, ties, readiness…",
      "parkFingerprint": "a26da43f3cc37eb744643522ee2d12afc252c3c1da3c35cc1cf1b6beaa095dd0",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "BLOCKED, not abandoned. Implementation is already complete (writer commit 673815030cc1524d6d355a8c215d91db30df961f on staging ancestry, 104/104 focused verification). The only remaining step is ACTIVATION of claim-spec revision 48, which is gated on WI-40086 qualification. Verified 2026-08-24T04:0xZ: WI-40086 state=open, sole-held by su-08275825 (coord:presence sessionState=live, lastActiveSecAgo=6, actively editing setup-release-checkout.sh) — NOT qualified and NOT stalled. UNPARK WHEN: exact e",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-40989",
      "title": "Author porting plan: retired autoloop → standing \"work on everything\" goal",
      "parkFingerprint": "d7e428fcc760d34118a361e7fe9cba2842a387abe189a62b37e40ecd690a637a",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-40992",
      "title": "Replace BYOC Ox Alpha fleet members with Codex GPT-5.6 Sol xhigh and resume plan control",
      "parkFingerprint": "a48ac6c9f85da33f2b6c7b01fbc74141bc96ba55f9f8fb7c46752d20c82268c1",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "System-wide pause mt6v2lrf; resume only after explicit fleet/system resume and live gate reconciliation.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-41087",
      "title": "Admission control: per-server bounded queue + backpressure, per-agent fairness, priority classes; queue depth as a registered state cell and health signal.",
      "parkFingerprint": "be72c03322a162cbdc5c565e8470a0451e69ebfe97f657bd796e50d794285379",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "tracked",
        "contractPresent": true,
        "condition": "Successful P012/WI41095 current full1000 oracle/F2/full-tail and registered SLO evidence must qualify P004 accepted4 whole-BAR disclosure before certification; re-evaluate exact current bindings.",
        "owner": "su-25bc0450-2829-42b9-a2dd-1431c99e4ba8",
        "trigger": "work-item:done:WI-41095",
        "reachability": "reachable",
        "evidence": "a live resolver or producer registration can still satisfy the condition",
        "findings": []
      },
      "disposition": "retain"
    },
    {
      "id": "WI-41093",
      "title": "Licensing + notices pipeline: fetch-not-bundle default; per-version THIRD-PARTY-NOTICES manifest for any bundled exception; flag GPL/proprietary/licensed-runtime servers in the spec. Needs owner/lega…",
      "parkFingerprint": "793fecc91d4d280d7c2679f84ce7a2d163d397d3b7b5ed4e227113657967acd2",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-41158",
      "title": "Cloud tab-shell: a browser wrapper whose tabs are installed cupboard apps requires EVERY cupboard app to have a web target — so P-002 is it…",
      "parkFingerprint": "b0af8e816f6985cbae534321df0b941d7144e3418fbea4b8983056599a35ee1b",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked by unified-app-template D-008 until exact BYOC plan lands; checkpoint contains live scoped evidence.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-4119",
      "title": "Option B (deferred): work_items:subscribe { followBlockers:true } one-hop opt-in with auto-unsubscribe on unlink/settle",
      "parkFingerprint": "3a20dc42276093c666e92a8dd92fcfef3981ef9096c1981b3afb766a0fe6efeb",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Deliberately-deferred follow-up (D-003, linking-notify-family-hardening-2026-07-11): explicitly gated \"until the work_item_deps backend flip lands\", \"stays filed, not built\" until then. Not a bug, not ready to build — couldn't confirm from this session whether that specific backend flip has landed (367-work-item-deps.sql created the table long ago, but D-003's \"flip\" means switching reads to it, a separate step). Parking rather than building speculatively.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-4141",
      "title": "Update the app-wide audit and add recurrence guards for mixed REST-bootstrap + sync-overlay patterns; run focused suites, build, full release gate, deploy, and live-verify.",
      "parkFingerprint": "28c3a93dc56728337f50a3e9e4e7aed68d5c4674e4243bf122a8ccf2d048a899",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Release-scale plan item P-014 is explicitly parked by prior fleet checkpoint for dedicated acceptance/release lane; this small feature/change drain lane must not re-claim it.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-41686",
      "title": "Post-deploy: place the D-061 manual-run hold once release:checkpoint-config's scope arg is live",
      "parkFingerprint": "c9394d8c2ed1a0e9e27ae87a3a40c52899fd40aa6e73a6b2a93cafaf402a560d",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "UNPARK CONDITION: release:checkpoint-config { op:'get' } returns a manualRunAdmission field, i.e. the deploy carrying commit e21827381c77e has landed. Until then this item is not actionable and self-selecting it only burns a wake. It is NOT abandoned: standing fact d061-manual-run-hold-pending-deploy names it, and a directed claim by id still works for whoever is present when the deploy lands. Procedure is in the checkpoint; note D-071 has superseded D-061 as the governing withholding decision,",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-41775",
      "title": "Two SHIPPED plans certified release-gate guards that are never called — the code-truth audit verifies code EXISTS, not that anything REACHES it",
      "parkFingerprint": "8b10bf77a2ede2a35567e344953916ab1b9a88d880f3cf5f810dd4a6a9a38986",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Blocked by stable-candidate-related-gate D-082/D-085: the exact D-019 readiness event is still declared/not fired and WI-40086 remains live-owned. Preserve the explicit no-edit freeze; clear this park when the readiness event opens.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-4701",
      "title": "Heavy-command admission is a load-triggered TRIPWIRE, not a real cap: route the documented `npm run test:affected` (and other heavy npm scripts) through the pc-heavy.sh semaphore by default (Part 2 of EI-10913)",
      "parkFingerprint": "d3fe60313ff6ad63558fd1585079fb4cf35a7487fd3b2b026de7a192284d84fc",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-4995",
      "title": "Migrate legacy getHarnessPg().sql / getLegacyClient direct-PG sites onto harnessQuery(slug, fn) (PgBouncer routing)",
      "parkFingerprint": "946d21ee5ca7bcfa7896cf6edad318bd5475b37a131b9d95ba308e9e2dfd646e",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Decomposed into WI-5381/5382/5383/5384 (see checkpoint) — this umbrella has no more standalone actionable work; park it out of self-select until the sub-items are all done, then close it.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-5013",
      "title": "Update Center 3-platform E2E campaign [owner:Avi 2026-07-15 'make sure it is thoroughly tested on ALL 3 platforms']",
      "parkFingerprint": "d2f6406ac4cc4c3e58edc0920b2249a193b537bc2ea2d2d4fc1769717c1a9f8f",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-5014",
      "title": "macOS Update Center E2E: publish .app.tar.gz+sig to the rail, then VM-drive check→install→relaunch→revert",
      "parkFingerprint": "06c6c163a85fd82f6c777163e4c8a3772ece7df9dede6bc4c1c3694f87b306a4",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Same release-cut/E2E family as WI-5013 — blocked on a mac VM cut this fleet lacks, and a mismatch with the bug-drain claim spec (kind=task, severity=minor). A prior holder already filed EI-13488 for this exact scheduler-spec gap on 2026-07-17. Parking to stop re-serving.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-5015",
      "title": "Windows Update Center E2E: publish -setup.exe+sig to the rail, then VM-drive check→install→relaunch→revert",
      "parkFingerprint": "bcbec4cde77bc9014b6004e7a0614dd690d3008dd35c97c5f4c232fbb938b403",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Same release-cut family as WI-5013/5014 (EI-13488) — blocked on a windows cut + VM lease this fleet doesn't coordinate, and a claim-spec mismatch (kind=task, severity=minor). Parking; see EI-13488 for the durable fix.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-5108",
      "title": "VM joiner operator: hive-owner-key-health fires 🔴 'this box owns the hive' for papercusp-workspace/papercusp (loadHivePubkey null) on a NON-owner box",
      "parkFingerprint": "b2104ed01f2547d4f561e86f23b25d6623c43b40dbed3f3acb341649770588b3",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "D-022 canonical admission audit: WI-5108 is rig-only and excluded from this general drain; release this accidental loop claim and preserve the durable hold for one-for-one replacement.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-5389",
      "title": "Make papercusp + oddsmith pots fully functional SHARED pots (private repos, gh-allowlist admission incl. papercusp git account) — owner-directed 2026-07-18",
      "parkFingerprint": "f01c0b8d2932bb133f867f91fe8b82f444fc5ef8db6790dc63f779fbcb98051f",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Defer until papercusp substrate directory-topic health recovers (unpark condition: dev:dogfood_substrate_status{targetHarness papercusp} verdict:healthy, drain.undrainedCount:0) or WI-5861/5863/5923 close.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-5501",
      "title": "Loop engine: leader-wake session-limit/auth-wall deaths should attempt account failover via the inference gateway (EI-13818 item (b), deferred)",
      "parkFingerprint": "6b8396c41853a114afcfe3dc66349ee4cebfe432c890df6ddddf38b85de8fd96",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-590490",
      "title": "spawnAgentInHarness is a SECOND agent-spawn door that never crosses the governor admission seam — migrate it onto spawnGovernedAgentProcess",
      "parkFingerprint": "301ea5bb55817d128719e5b6a348119ae9e1808231a8640a04dd66cebc9dcaa9",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "TEMPORARY MITIGATION: P-004 remains externally blocked at 0 lifetime governor_observation receipts (positive control 6,962 spawns). Prevent fleet spec rev 2 from recycling this open umbrella. Re-evaluate and clear hold on the next bare release:deployed event; typed claimHoldRelease is committed in WI-141378 but not yet live.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-6292",
      "title": "Design the idea-fitness loop and PRESENT IT BEFORE BUILDING (design-shaped work per standing feedback): ideation output → the `cheapExperiment` already captured on each idea (hypothesis / method / fa…",
      "parkFingerprint": "d1efd1af4538a6deeba520ae0e19ec33e3d3aacc8216468efa4582785748be40",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Plan gym-real-fitness-signal-2026-07-27 is PAUSED at owner request [owner:Avi 2026-08-02]; P-007's design deliverable is already done + presented (comment 55198) and 4 decisions await the owner. Parked out of self-select so an unscoped oldest-first pull cannot re-hand it to another agent. Unpark on plan resume.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-636615",
      "title": "Restart deploy tooling is transport-invalid on GCP: ssh root@IP cannot work at any address, and three scripts still pin dead Hetzner hosts",
      "parkFingerprint": "b54a3bf7c1eff6b7541b3afc5a9d272f0e4a0cfcd3bf73baa7fbec5dedb2f3c5",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "OWNER-BLOCKED only — Avi must decide the disposition of ~/Restart's 61 uncommitted files; zero agent work remains. Typed blocker recorded (owner:avi:restart-dirty-tree-disposition). Parked out of self-select so no peer picks up an owner-gated item; still claimable by id once Avi decides. Full state in the item's checkpoint.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-6561",
      "title": "Verify the WI-6522 coord:send fix against live traffic (~24h post-deploy soak) — difference-in-differences, and do NOT count the old signatures",
      "parkFingerprint": "8ab86afbdfe90e7799fcaf390fe09c2f9152432791d270d5305f8bbf4fd73db5",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Prerequisite not met: positions.deployed=false for coordination/tools/send.ts (deployedSha 6760f8ec vs target daa240a4d, blockedOn gate, 42 consecutive reds, gate owned live under WI-40086). DEPLOY_TS does not exist so the ~24h soak has not started; measuring now would sample a window where the fix was never live. Clear the hold when positions.deployed flips true. Full reading recorded as a comment.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-6821",
      "title": "OWNER-REPORTED 2026-08-02: HUD \"+ new session\" popup sits on \"Starting up — waiting for this session to come online…\" — the launch dies and NOTHING ever marks it failed, so the roster advertises a dead launch as \"starting\" indefinitely",
      "parkFingerprint": "24e67f95fad6beb2e3e22a9d1f3979ebbc0b9d54740b1d8bac791868c08d595e",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-701",
      "title": "Enable `workerMode` on 1-2 NON-critical harnesses only; run real features and diff (su-a509b: owner greenlit wire+dark-launch on 1 non-crit…",
      "parkFingerprint": "2a47f930dea1d6036e24f2fcb65440baf75cdcbf123a0ccf5f5a77fab2a48380",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-726",
      "title": "Live tail of the P-015 dogfood (owner-gated): decide the invoke-route spawn-identity model (options a/b/c in ## Now \"final blocker\"), then …",
      "parkFingerprint": "ed6bd65271b3182773a1fea0c0e46944c35d74ca3fbb57e8e2929bf836409dd7",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-75008",
      "title": "Shared TMPDIR '/tmp' has too many entries on main-server-Precision-7865-Tower — something is leaking scratch",
      "parkFingerprint": "d29414f37ca4bf8cd251a610f3c67f195a33a16836414ef69b83829c7dca89fa",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Park parent validation after committed P-001; resume only after open P-004 recurrence guard and P-005 detector correction are terminal with evidence.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-792",
      "title": "[SU BRIEF] Drive Windows desktop PUBLIC-release readiness (parallel to the Mac drive)",
      "parkFingerprint": "dc5ff570050245e6a0fc005e8d90b5bec4a82e4a0ada62536d2a6716e203fbbd",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-missing",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-818362",
      "title": "Actuate the green-checkpoint watchdog auto-refire: retire the hardcoded ownerWallActive:true gate so the built refire decision stops being advisory-only",
      "parkFingerprint": "d5d12e55f87abb786e30bbb4b6d169e9de4861980c9f98161733dd16d1b1de94",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "LIVE_GATE_OPS ownership is held-live by su-a1fac1f7-de90-41da-a872-ca9ba4c2d370. Member is stopping this lane without source or control-plane action; hold prevents fleet spec rev 2 from duplicating the gate owner. Holder should clear when ready to own WI-818362 cutover.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-922851",
      "title": "Repair frozen green-checkpoint candidate 3bd20cc9 gate failures",
      "parkFingerprint": "857f8f0dc4fe11ab1d8a6038854b4002b079906519bf19491d83215d12fa195e",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-934440",
      "title": "Stale ElevenLabs-CDN scratch pages (el-bare-test.html / el-fresh-test.html) are LIVE on :3070 — removed on staging, still present on main; promotion blocked by the frozen gate",
      "parkFingerprint": "abc15ae1dce724466cc7cf83d487db72b524599fd236485be052539b4d84b6f8",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": null,
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "condition-ambiguous",
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    },
    {
      "id": "WI-989591",
      "title": "Concurrent loadOrGenerateDeviceKeypair callers mint multiple identities for one keychain ID",
      "parkFingerprint": "8d78d448483acd7620df3ce85572139a6b9b8c70612315d43c0e5dea2286515a",
      "lease": null,
      "assignment": null,
      "condition": {
        "status": "unverified",
        "contractPresent": false,
        "condition": "Release inherited claim; source fix is complete but live deploy/rig work is explicitly deferred until P-008 handback.",
        "owner": null,
        "trigger": null,
        "reachability": null,
        "evidence": null,
        "findings": [
          "owner-missing",
          "trigger-missing",
          "reachability-unverified",
          "evidence-missing"
        ]
      },
      "disposition": "route-or-unknown"
    }
  ]
}
