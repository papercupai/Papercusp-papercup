---
rel_path: "evidence/pui-public-rubric16-plan147/raw-1737bde672cbdcc87fe01be3d45596cf95f829c9cdfc0903fff1a961d4e1838e.json"
updated_at: 1791647934363
_body: "content"
---

{
  "schemaVersion": 2,
  "rubricRef": "acceptance-pui-first-party-public-release-2026-09-07",
  "rubricRevision": 16,
  "criteriaHash": "9dd8a68c940e70de35f5fa8e9ca3bb318ffbd299cc8fb0b609d76d6a35527b09",
  "planVersion": 147,
  "planContentHash": "c7ea8a7d4c71104b7e86bf2ee8c56c8c1278a278f17838d58cead5323964b53d",
  "testedSha": "f2d92cbc8ad685b843e70c83718ac7a8d1a45371",
  "retainedInputSha256": "a4a6d1cb8d1f94a2c902cf208787006b63de158bda0b2637bfe3aa7e22823776",
  "sourceSha256": {
    "packages/operator-core/lib/agent-tools/plans/spec-clause-compiler.ts": "9e0d17219fd5f3df1aee9cab076fc1c8e1088df71ab158803a221fb99af65387",
    "packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts": "bffd13d3215dd178cb89934a148ac08bee4750b131d56a5063d22134e58b4e38",
    "packages/operator-core/lib/pui-e2e/context-pane-cockpit-pty.integration.test.ts": "6e56ae67521250e81579686bc33c98e699a6246cc04bd38455434daae1b80a07",
    "packages/operator-core/lib/pui-e2e/public-package.integration.test.ts": "11364a9828fbbba4f128326e2bdb0837595a47af9e37e772d346da8d18376a78",
    "packages/operator-core/lib/pui-e2e/release-acceptance.integration.test.ts": "8970756983f33572811feacb7e9f8bd7c7896274062a36126e90a1c6ae86ae9b",
    "packages/operator-core/lib/su-session-capability-parity.test.ts": "18cf0faa6e4aff83e56a938a759c3d71b292ae0a2f63f5861d8e34dfe094cae7",
    "packages/operator-core/lib/agent-tools/plans/val-assertions.ts": "c447866340753c12d8fd6a92a921fc722912ec33f86285d4ea33c6e6b170d8df",
    "packages/operator-core/lib/su-session-attached-live.integration.test.ts": "856bed4d05cb35cbb91282cccc922b05fbb58f69e688892beb71e351fd0d6d7c"
  },
  "criteria": [
    {
      "key": "r-01",
      "title": "First-party interaction",
      "model": "Every ordinary chat interaction in the installed PUI completes inside PUI without a native Claude, Codex or OMP interface.",
      "bar": "Every ordinary chat interaction in the installed PUI completes inside PUI without a native Claude, Codex or OMP interface.",
      "barKey": "R-01",
      "barHash": "2e85109de885a74e8be64de3cdaf45a85748101267ff896081f486459fe4c645",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-07T05:45:21.152Z",
        "declaredBy": "su-84c127f1-787b-49ea-849d-47d1b6217757"
      },
      "method": "Run the committed installed-PUI PTY first-message, tool, approval, interrupt, and resume journeys with every native engine pane closed; inspect the transcript and pane census for any native-client dependency. NAMED CASES that fail for this criterion's drift (cite names, not lines): agent-chat-pty.integration.test.ts: 'P-030: bare `pui` opens the chat as the focused main pane with the workbench panes beside it'; 'first exact draft reaches the structured SU engine, streams tools/reply, and reopens'; 'P-009 END: ending the session from PUI ends it and leaves no native engine process'; 'greeting, real file tool, interrupt and continued reply stay in one first-party session' (positive control: 'R-01 control: a `pui hud` frame shows the chrome a default launch must not'). GOAL CLAUSE: plan pui-first-party-public-release-2026-09-07 ## Requirements R-01 (First-party interaction). GOVERNING DECISIONS: D-001 (Avi rejected the native Claude pane and expects our own full TUI), D-002 (approved replacement of the launcher-UI rule for PUI), D-004 (the installed-product journey is the release authority and must prove absence of unwanted native UI). RATING BASIS: the model is the pass floor and every numbered driftMarker is also rated; a degraded or failing rating names the marker number(s) that tripped.",
      "driftMarkers": "BROKEN if any ONE holds: (1) sending text opens or requires a native Claude/Codex/OMP pane; (2) creating or resuming a session opens or requires one; (3) answering an approval opens or requires one; (4) cancelling work or continuing a reply opens or requires one; (5) an external terminal opens without the user explicitly requesting it (an explicitly requested external terminal is the only allowed exception).",
      "replication": "REPLICATION DRILL: Run the bound agent-chat PTY tests \"first exact draft reaches the structured SU engine\" and \"greeting, real file tool, interrupt and continued reply\"; fail if any ordinary interaction depends on a native pane.\nREPLICATION SOURCES: packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-02",
      "title": "Reliable first-turn delivery",
      "model": "The first message sent from the installed PUI yields exactly one accepted owner turn with its correlated reply in the same transcript.",
      "bar": "The first message sent from the installed PUI yields exactly one accepted owner turn with its correlated reply in the same transcript.",
      "barKey": "R-02",
      "barHash": "ce168ed9a47d955c49fd97359644f7f938214e725866b145dda0addd9dc22af8",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-07T05:45:21.152Z",
        "declaredBy": "su-84c127f1-787b-49ea-849d-47d1b6217757"
      },
      "method": "Run the delayed-ready, durable receipt, duplicate suppression, interruption, and delivery-uncertain PTY cases against the exact candidate binary; verify one accepted owner turn and one correlated reply. NAMED CASES that fail for this criterion's drift (cite names, not lines): agent-chat-pty.integration.test.ts: 'delayed readiness sends the first draft once and accepts a follow-up after completion'; 'P-002: a first message survives the loss of its launching runtime and still gets a reply'; 'AUTO-BAR-R-02-P-009: %s keeps the draft and replays the exact persisted command without a second model turn or tool execution'. GOAL CLAUSE: plan pui-first-party-public-release-2026-09-07 ## Requirements R-02 (Reliable first-turn delivery). GOVERNING DECISIONS: D-004 (the journey must prove readiness, first message and correlated reply), D-012 and D-013 (real-engine evidence legs pin their model; Claude-scoped), D-024 (bounded-timeout fallbacks are recorded as evidence, not failures). RATING BASIS: the model is the pass floor and every numbered driftMarker is also rated; a degraded or failing rating names the marker number(s) that tripped.",
      "driftMarkers": "BROKEN if any ONE holds: (1) a delayed backend loses the first accepted draft; (2) the first draft is submitted or accepted twice; (3) the reply is missing or is not correlated with that turn in the same transcript; (4) the host does not acknowledge durable acceptance; (5) an uncertain delivery is blindly resent instead of being shown as uncertain and reconciled.",
      "replication": "REPLICATION DRILL: Run the bound PTY cases \"delayed readiness sends the first draft once\", \"delivery receipt and assistant segment\", and \"host refusal retains an editable draft\"; verify the accepted-turn count and correlated reply.\nREPLICATION SOURCES: packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-03",
      "title": "Full SU capability",
      "model": "An installed-PUI SU session on every advertised engine carries the full SU runtime contract, not a provider-only text completion.",
      "bar": "An installed-PUI SU session on every advertised engine carries the full SU runtime contract, not a provider-only text completion.",
      "barKey": "R-03",
      "barHash": "8bd363bf44a2cccc0e1dc1f920c64865ccb79345ba78b3e9cd5c713b986c6ae4",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-07T05:45:21.152Z",
        "declaredBy": "su-84c127f1-787b-49ea-849d-47d1b6217757"
      },
      "method": "Run the Claude/Codex/OMP capability-parity and attached-live suites plus the installed-PUI real-engine journeys. Verify persona, workspace, tool, permission, coordination, task, mode, history, and resume effects rather than provider text alone. NAMED CASES that fail for this criterion's drift (cite names, not lines): su-session-capability-parity.test.ts: describe 'P-006 su-session capability parity': '%s declares exactly the canonical command and feature key sets', '%s gives the PUI a usable explanation for every non-supported capability' (per engine), and 'never declares a capability as simulated — unsupported behaviour stays visible'. agent-chat-pty.integration.test.ts: 'P-016: a ${backend} chat runs ${backend}'s own identity outside every checkout and the SU identity inside one'; 'PUI-TASK: an SU-session task list is edited in Context by owner and agent and survives restart'; 'restores the same native conversation after the operator OS process exits'. GOAL CLAUSE: plan pui-first-party-public-release-2026-09-07 ## Requirements R-03 (Full SU capability). GOVERNING DECISIONS: D-003 (preserve the full SU runtime contract), D-021 (Claude default-mode approvals auto-allow only read-only SU tools; writes keep asking). RATING BASIS: the model is the pass floor and every numbered driftMarker is also rated; a degraded or failing rating names the marker number(s) that tripped.",
      "driftMarkers": "BROKEN if any ONE holds: (1) persona is lost; (2) workspace or project scope is lost; (3) tools or permissions are lost; (4) coordination identity is lost; (5) context or the task list is lost; (6) modes are lost; (7) session history is lost; (8) carry/resume is lost; (9) any of these is absent while a provider-only text completion still appears successful.",
      "replication": "REPLICATION DRILL: Run su-session-capability-parity \"all three engines agree on the key sets\" and \"never declares a capability as simulated\", attached-live integration, and installed-PUI real-engine PTY; fail on absent SU effects.\nREPLICATION SOURCES: packages/operator-core/lib/su-session-capability-parity.test.ts; packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts; packages/operator-core/lib/su-session-attached-live.integration.test.ts.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/su-session-capability-parity.test.ts",
          "packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts",
          "packages/operator-core/lib/su-session-attached-live.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-04",
      "title": "Usable session setup and history",
      "model": "Before any request runs in the installed PUI, the session visibly names its project, engine, model and account.",
      "bar": "Before any request runs in the installed PUI, the session visibly names its project, engine, model and account.",
      "barKey": "R-04",
      "barHash": "e2edeb7ee6d5b8a409c5137fbb6e122ba300fd941080c2701f35a42e8279055d",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-07T05:45:21.152Z",
        "declaredBy": "su-84c127f1-787b-49ea-849d-47d1b6217757"
      },
      "method": "Run new/switch/rename/archive/resume, legacy-history continuation, backend/model/account visibility, and authentication/setup PTY journeys against the exact candidate. NAMED CASES that fail for this criterion's drift (cite names, not lines): agent-chat-pty.integration.test.ts: 'AUTO-BAR-R-04-P-010: new-session setup reviews every effective choice and launches only from Review'; 'AUTO-BAR-R-04-P-008: legacy continuation preserves source identity, history and the unsent draft'; 'PUI-SESSION-LIFECYCLE: session browser keeps isolated history addressable and supports rename/archive'; 'PUI-SETTINGS-PICKERS: live pickers name defaults and reasons, and a launch-time pick on a running conversation opens a new session'. GOAL CLAUSE: plan pui-first-party-public-release-2026-09-07 ## Requirements R-04 (Usable session setup and history). GOVERNING DECISIONS: D-004, D-006 (one clear project/session at the front door), D-020 (a launch-time pick opens the New SU session form; About/Support in the palette). RATING BASIS: the model is the pass floor and every numbered driftMarker is also rated; a degraded or failing rating names the marker number(s) that tripped.",
      "driftMarkers": "BROKEN if any ONE holds: (1) a session starts with a hidden or wrong project, engine, model or account; (2) new-session setup, backend/model/account selection or authentication guidance cannot be completed within PUI; (3) legacy history has no explicit provenance-preserving Continue in new session action, or continuing silently changes engine or becomes the default dead end; (4) rename, archive or resume loses or silently changes history or engine.",
      "replication": "REPLICATION DRILL: Run bound PTY \"legacy continuation preserves source identity, history and the unsent draft\", \"session browser keeps isolated history\", and \"new-session setup reviews every effective choice\".\nREPLICATION SOURCES: packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-05",
      "title": "Complete editor and controls",
      "model": "An owner draft in the installed PUI composer survives editing, streaming and control actions unchanged until the owner sends it.",
      "bar": "An owner draft in the installed PUI composer survives editing, streaming and control actions unchanged until the owner sends it.",
      "barKey": "R-05",
      "barHash": "772433a68a7250ad22bb262639b7e23f79cd13d16249481c89446f2b16449a1a",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-07T05:45:21.152Z",
        "declaredBy": "su-84c127f1-787b-49ea-849d-47d1b6217757"
      },
      "method": "Run the editor, multiline/paste/undo/history/copy, streaming-draft, queue/stop/retry, approval, question, tool-result, and diff PTY cases against the exact candidate. NAMED CASES that fail for this criterion's drift (cite names, not lines): agent-chat-pty.integration.test.ts: 'PUI-EDITOR-UNDO: undo restores the exact pre-paste draft'; 'PUI-EDITOR-HISTORY: navigating history preserves and restores the in-progress draft'; 'PUI-EDITOR-COPY: copying a focused transcript result preserves its plain text'; 'AUTO-BAR-R-05-P-007: editing a draft during a streamed turn neither disturbs the stream nor sends the draft'; 'P-004: the default chat composer has slash commands, multi-line input, history, @file and Esc to stop'; 'delivery receipt and assistant segment keep input locked until interruption completes'; 'PUI-QUESTION: a $route question is answered in the PUI and reaches the asking turn'. GOAL CLAUSE: plan pui-first-party-public-release-2026-09-07 ## Requirements R-05 (Complete editor and controls). GOVERNING DECISIONS: D-007 (the owner operates session controls through PUI), D-015 (composer @ picker implemented; PUBLIC_RELEASE_UX affordances pinned against the code). RATING BASIS: the model is the pass floor and every numbered driftMarker is also rated; a degraded or failing rating names the marker number(s) that tripped.",
      "driftMarkers": "BROKEN if any ONE holds: (1) multiline editing, paste, undo, history or cursor movement corrupts a draft; (2) scrolling or copying corrupts a draft or copies the wrong text; (3) a streamed reply swallows or sends a new draft; (4) queue, stop, retry or resume has no explicit visible state or uses inconsistent keys; (5) an approval or tool result cannot be acted on inline.",
      "replication": "REPLICATION DRILL: Run bound PTY PUI-EDITOR-UNDO, PUI-EDITOR-HISTORY, PUI-EDITOR-COPY, AUTO-BAR-R-05-P-007, PUI-QUESTION and approval allow/deny tests; inspect draft equality and single-action assertions.\nREPLICATION SOURCES: packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-06",
      "title": "Recoverable lifecycle",
      "model": "Every failure or interruption of an installed-PUI session leaves one defined lifecycle state with a visible recovery action.",
      "bar": "Every failure or interruption of an installed-PUI session leaves one defined lifecycle state with a visible recovery action.",
      "barKey": "R-06",
      "barHash": "5e9f2758aaffa8b43c1b12fd6a01b7e7cb4d33ffddec0a9c37e75151978bbf62",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-07T05:45:21.152Z",
        "declaredBy": "su-84c127f1-787b-49ea-849d-47d1b6217757"
      },
      "method": "Run startup failure, reconnect, restart, interruption, uncertain delivery, compaction/resume, ended-session, and ownership-preservation PTY cases; verify every failure releases busy state and exposes recovery. NAMED CASES that fail for this criterion's drift (cite names, not lines): agent-chat-pty.integration.test.ts: 'AUTO-BAR-R-06-P-009: $mode after acceptance leaves a usable composer within 15s'; 'AUTO-BAR-R-06-P-009: startup failure leaves the exact draft retryable within 15s'; 'a refused reconnect stays visible without submitting a new owner turn'; 'interrupted startup retains the draft and retries without creating another chat'; 'host refusal retains an editable draft and a ready retry commits it once'; 'P-009 QUIT: /exit ends the engine, says so, and a relaunch resumes the conversation from its transcript'. GOAL CLAUSE: plan pui-first-party-public-release-2026-09-07 ## Requirements R-06 (Recoverable lifecycle). GOVERNING DECISIONS: D-004 (the journey must prove recovery), D-016 (one authoritative lifecycle lives in the pui binary; palette lifecycle actions). RATING BASIS: the model is the pass floor and every numbered driftMarker is also rated; a degraded or failing rating names the marker number(s) that tripped.",
      "driftMarkers": "BROKEN if any ONE holds: (1) more than one lifecycle authority disagrees about the session state; (2) a starting, ready, sending, streaming, waiting-for-approval, interrupted, reconnecting, failed, ended or delivery-uncertain state has no defined transition or recovery action; (3) a failure leaves PUI busy or the draft/recovery controls unusable; (4) quit, restart or connection loss loses history or ownership; (5) recovery duplicates an accepted turn.",
      "replication": "REPLICATION DRILL: Run bound PTY \"startup failure leaves the exact draft retryable\", \"interrupted startup retains the draft\", \"engine startup exit releases input\", and \"restores the same native conversation after the operator OS process exits\".\nREPLICATION SOURCES: packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-07",
      "title": "Relevant context and layout",
      "model": "At every supported terminal size the installed PUI keeps the current conversation visible as its primary surface.",
      "bar": "At every supported terminal size the installed PUI keeps the current conversation visible as its primary surface.",
      "barKey": "R-07",
      "barHash": "9ed0ebe1b88bf578de99466673eb2679e5c72ad1c159a5249e8268eef74033e2",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-07T05:45:21.152Z",
        "declaredBy": "su-84c127f1-787b-49ea-849d-47d1b6217757"
      },
      "method": "Run compact/wide layout, Surface B context, current task/plan/tool/diff/scope, below-minimum blocking, live resize, and narrow-terminal PTY cases on the candidate. NAMED CASES that fail for this criterion's drift (cite names, not lines): agent-chat-pty.integration.test.ts: 'AUTO-BAR-R-07-P-008: a default launch opens on the active conversation and its Context despite unrelated activity, normal and compact'; 'AUTO-BAR-R-03-P-008: Context follows the selected session in the wide rail and the compact Ctrl-T surface'; 'P-013: below 80x20 a blocking view holds the draft and a resize back resumes it'; 'P-013: 80x24, 120x40 and 200x60 keep a streamed reply whole across resizes'. context-pane-cockpit-pty.integration.test.ts: describe 'pui context-pane cockpit (installed binary, real PTY, fake canonical operator)', case 'HUD cockpit: semantic cards, actionable frontier, lifecycle oracle, launcher door, ended sessions, leader tape and critical path'. GOAL CLAUSE: plan pui-first-party-public-release-2026-09-07 ## Requirements R-07 (Relevant context and layout). GOVERNING DECISIONS: D-006 (user context drives the layout and defaults: the conversation plus its contextual work surface; global operational data behind explicit navigation). RATING BASIS: the model is the pass floor and every numbered driftMarker is also rated; a degraded or failing rating names the marker number(s) that tripped.",
      "driftMarkers": "BROKEN if any ONE holds: (1) the conversation disappears behind global presence, fleets or internal IDs; (2) the Surface B Context pane lacks the current task, plan, context, tool/diff or scope information; (3) the Context pane shows another session’s task, context, tool/diff or scope; (4) a narrow or below-minimum terminal clips controls or accepts hidden input instead of preserving the draft.",
      "replication": "REPLICATION DRILL: Run bound PTY Context-follows-selected-session, default-launch active-conversation, P-013 below-80x20 and live-resize cases, plus context-pane cockpit PTY; inspect the visible pane and preserved draft.\nREPLICATION SOURCES: packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts; packages/operator-core/lib/pui-e2e/context-pane-cockpit-pty.integration.test.ts.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts",
          "packages/operator-core/lib/pui-e2e/context-pane-cockpit-pty.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-08",
      "title": "Clean installation",
      "model": "The PUI release archive completes its install-to-first-reply journey on a clean HOME that has no checkout, Cargo, private dotfiles, developer database, injected operator URL or desktop window.",
      "bar": "The PUI release archive completes its install-to-first-reply journey on a clean HOME that has no checkout, Cargo, private dotfiles, developer database, injected operator URL or desktop window.",
      "barKey": "R-08",
      "barHash": "cbc0f95818cabf2d19a8baef09f600eef2971580afba6bfc5af6f5995a0cd2ad",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-07T05:45:21.152Z",
        "declaredBy": "su-84c127f1-787b-49ea-849d-47d1b6217757"
      },
      "method": "Build the committed-source public archive and install it into an isolated HOME with no Cargo, git, private dotfiles, developer database, injected endpoint, or desktop window; run doctor and the first-use path. NAMED CASES that fail for this criterion's drift (cite names, not lines): public-package.integration.test.ts: 'AUTO-BAR-R-08-P-011: a clean HOME installs and runs PUI with no checkout, cargo, python, git, dotfiles or operator'; 'AUTO-BAR-R-08-P-018: the archive ships psu on its own pinned Node — it runs in a HOME with no node, npm or checkout'; 'AUTO-BAR-R-08-P-019: install links psu beside pui, never over a psu it does not own, pui runs its own psu first, and uninstall leaves no psu residue'; 'AUTO-BAR-R-08-P-020: with no operator, installed PUI setup signs in to Papercusp cloud through its bundled psu and runs PUI on the cloud workspace'. GOAL CLAUSE: plan pui-first-party-public-release-2026-09-07 ## Requirements R-08 (Clean installation). GOVERNING DECISIONS: D-004 (grading distinguishes source, built, installed and public artifact), D-016 (one PUI release unit), D-025 (remote hosts: PUI runs on the remote host through the psu terminal bridge), D-031 (the archive ships psu on a private Node; first-run setup gains the cloud path), D-032 (pui-audio helper, so pui starts without ALSA). RATING BASIS: the model is the pass floor and every numbered driftMarker is also rated; a degraded or failing rating names the marker number(s) that tripped.",
      "driftMarkers": "BROKEN if any ONE holds: (1) the clean-HOME install needs this checkout, Cargo or git; (2) it needs private shell dotfiles, a pre-existing developer database or test pots; (3) it needs an injected operator URL or a running desktop window; (4) a required runtime or service prerequisite is neither installed nor explained and checked in-product (doctor omits it); (5) local versus remote endpoint identity is ambiguous or wrongly scoped.",
      "replication": "REPLICATION DRILL: Run public-package AUTO-BAR-R-08-P-011 in isolated HOME and agent-chat PTY clean-workbench setup cases; fail on an undeclared dependency, inaccessible first-use path, or wrong endpoint identity.\nREPLICATION SOURCES: packages/operator-core/lib/pui-e2e/public-package.integration.test.ts; packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/pui-e2e/public-package.integration.test.ts",
          "packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-09",
      "title": "Safe credentials and consent",
      "model": "A fresh public PUI install acts only with the permissions, paid account and autonomy the user explicitly consented to.",
      "bar": "A fresh public PUI install acts only with the permissions, paid account and autonomy the user explicitly consented to.",
      "barKey": "R-09",
      "barHash": "a79503e2d8803f8ad5fc1c3fb6ac9416a4b4eff98d0defc65932ecdc610a81b1",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-07T05:45:21.152Z",
        "declaredBy": "su-84c127f1-787b-49ea-849d-47d1b6217757"
      },
      "method": "Run the isolated-package secret-leak/diagnostics checks and installed real-engine approval/permission journeys; verify no development AUTO/bypass state or credential value crosses into the archive or support report. NAMED CASES that fail for this criterion's drift (cite names, not lines): public-package.integration.test.ts: 'AUTO-BAR-R-09-P-011: installing needs explicit consent, and neither the package nor the support export carries a seeded credential or private text'. agent-chat-pty.integration.test.ts: 'new-session setup refuses an operator without the safe native approval capability'; 'PUI-APPROVAL-ALLOW / AUTO-BAR-R-09-P-010: approving one request executes exactly it and leaves its peer pending'; 'PUI-APPROVAL-DENY / AUTO-BAR-R-09-P-010: declining one request executes nothing and leaves its peer pending'; 'PUI-ABOUT-SUPPORT: palette About shows identity and Diagnostics previews and saves a redacted report'. GOAL CLAUSE: plan pui-first-party-public-release-2026-09-07 ## Requirements R-09 (Safe credentials and consent). GOVERNING DECISIONS: D-021 (only read-only SU tools auto-allowed; writes keep asking), D-022 (the one sanctioned no-card write: owner directive bookkeeping), D-031 (first-run cloud path and account consent). RATING BASIS: the model is the pass floor and every numbered driftMarker is also rated; a degraded or failing rating names the marker number(s) that tripped.",
      "driftMarkers": "BROKEN if any ONE holds: (1) a fresh install inherits development AUTO or bypass state; (2) a permission escalates or a paid account is selected without explicit consent; (3) credentials bypass the existing secure configuration/authentication paths; (4) a seeded credential or private conversation text appears in the archive, a log, diagnostics or a support export by default; (5) telemetry is undocumented or cannot be controlled.",
      "replication": "REPLICATION DRILL: Run public-package AUTO-BAR-R-09-P-011 secret/consent assertions and agent-chat PTY approval allow/deny and redacted Diagnostics tests; verify seeded secrets never appear.\nREPLICATION SOURCES: packages/operator-core/lib/pui-e2e/public-package.integration.test.ts; packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/pui-e2e/public-package.integration.test.ts",
          "packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-10",
      "title": "Verified backend and platform support",
      "model": "Every advertised backend and operating-system cell has recorded installed-product acceptance for the exact candidate.",
      "bar": "Every advertised backend and operating-system cell has recorded installed-product acceptance for the exact candidate.",
      "barKey": "R-10",
      "barHash": "df4d1f36794581cd05f737bd2cffa68feb660d3dcfb1ccdad98abd68066ac7e8",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-07T05:45:21.152Z",
        "declaredBy": "su-84c127f1-787b-49ea-849d-47d1b6217757"
      },
      "method": "Derive the required platform/backend matrix from PUBLIC_RELEASE_UX, run every advertised candidate cell through release acceptance, and refuse advertising any cell without candidate-bound installed evidence. NAMED CASES that fail for this criterion's drift (cite names, not lines): release-acceptance.integration.test.ts: 'AUTO-BAR-R-10-P-012: an advertised combination missing any installed-product leg is refused' (fixture over the committed contract: it fails when a cell is advertised without an installed-product leg) and, for this candidate, 'AUTO-BAR-R-12-P-012: release acceptance drives user input through the installed PUI binary and the production operator' plus the candidate acceptance report's legs for every advertised OS x backend cell. agent-chat-pty.integration.test.ts: 'P-016: a ${backend} chat runs ${backend}'s own identity outside every checkout and the SU identity inside one'. GOVERNING DECISIONS: D-004 (installed-product journey is the release authority), D-007 (owner scope), D-017 (committed compatibility.json never marks a target verified), D-018 (derived required matrix, per-candidate advertising). GOAL CLAUSE: plan pui-first-party-public-release-2026-09-07 ## Requirements R-10 (Verified backend and platform support). RATING BASIS: the model is the pass floor and every numbered driftMarker is also rated; a degraded or failing rating names the marker number(s) that tripped.",
      "driftMarkers": "BROKEN if any ONE holds: (1) an advertised platform/backend cell lacks an installed-candidate journey; (2) an unsupported cell is marked verified in committed compatibility metadata; (3) Claude, Codex or OMP scope from the prior approved scope is silently omitted instead of tracked.",
      "replication": "REPLICATION DRILL: Run release-acceptance AUTO-BAR-R-10-P-012 missing-leg refusal and public-package AUTO-BAR-R-10-P-011 committed-verified-claim refusal, then installed real-engine cells; compare the advertised matrix with measured candidate evidence.\nREPLICATION SOURCES: packages/operator-core/lib/pui-e2e/release-acceptance.integration.test.ts; packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts; packages/operator-core/lib/pui-e2e/public-package.integration.test.ts.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/pui-e2e/release-acceptance.integration.test.ts",
          "packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts",
          "packages/operator-core/lib/pui-e2e/public-package.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-11",
      "title": "Reproducible release artifacts",
      "model": "Two builds of one committed source generation produce byte-identical public PUI artifacts.",
      "bar": "Two builds of one committed source generation produce byte-identical public PUI artifacts.",
      "barKey": "R-11",
      "barHash": "5626cd79c38ad43bdb90edd4425bb4e7c081d8ebc59e782df3f63d228169fd7e",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-07T05:45:21.152Z",
        "declaredBy": "su-84c127f1-787b-49ea-849d-47d1b6217757"
      },
      "method": "Build two committed generations, verify deterministic manifests/digests/provenance/license/compatibility/release notes, install/update/rollback/uninstall in an isolated HOME, and verify user data survives. NAMED CASES that fail for this criterion's drift (cite names, not lines): public-package.integration.test.ts: 'AUTO-BAR-R-11-P-011: archives are reproducible, name their committed generation, and refuse tampering'; 'AUTO-BAR-R-11-P-011: install, update, roll back and uninstall across two generations preserve user data'. GOAL CLAUSE: plan pui-first-party-public-release-2026-09-07 ## Requirements R-11 (Reproducible release artifacts). GOVERNING DECISIONS: D-004, D-016 (one PUI release unit reused from the sidecar recipe), D-017 (the committed compatibility.json never marks a target verified), D-026 (Apache-2.0 and the Papercusp copyright line on public artifacts). RATING BASIS: the model is the pass floor and every numbered driftMarker is also rated; a degraded or failing rating names the marker number(s) that tripped.",
      "driftMarkers": "BROKEN if any ONE holds: (1) two builds from one committed generation differ without an explained input; (2) an archive version, digest, provenance or license is wrong; (3) install, update or uninstall fails; (4) an update loses user data or rollback does not restore the previous version; (5) the compatibility table or release notes are untruthful.",
      "replication": "REPLICATION DRILL: Run public-package AUTO-BAR-R-11-P-011 reproducibility/tamper and two-generation install-update-rollback-uninstall tests; compare SHA256SUMS and preserved HOME data.\nREPLICATION SOURCES: packages/operator-core/lib/pui-e2e/public-package.integration.test.ts.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/pui-e2e/public-package.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-12",
      "title": "Executable release evidence",
      "model": "Public readiness of the exact final candidate rests on installed-PUI journeys, an independent grade and Avi’s recorded approval naming that candidate.",
      "bar": "Public readiness of the exact final candidate rests on installed-PUI journeys, an independent grade and Avi’s recorded approval naming that candidate.",
      "barKey": "R-12",
      "barHash": "42c5b3085335b6e8d67e62c54d8e3849e7ed03c43bfc22e4909d0249958dc649",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-07T05:45:21.152Z",
        "declaredBy": "su-84c127f1-787b-49ea-849d-47d1b6217757"
      },
      "method": "On the exact final candidate, rerun installed real-engine and PTY release journeys, bind ledger evidence, obtain a lineage-independent product grade, and inspect Avi's recorded release approval. Per D-041 (owner Avi, 2026-09-30, directive #1060: 'remove that requirement it just needs my approval only') no participant study is required, before or after release; WI-10003018 is dropped. NAMED CASES that fail for this criterion's drift (cite names, not lines): agent-chat-pty.integration.test.ts: 'greeting, real file tool, interrupt and continued reply stay in one first-party session'; 'restores the same native conversation after the operator OS process exits'; 'exact resume reaches readiness on every repetition without a startup timeout' (real-engine cases, run against the installed candidate). public-package.integration.test.ts: 'AUTO-BAR-R-08-P-011: a clean HOME installs and runs PUI with no checkout, cargo, python, git, dotfiles or operator' (the installed binary the journeys run). GOVERNING DECISIONS: D-004, D-038 (pass-equivalent independent ratings on all 15 BARs), D-041 (Avi removes the fresh-user study; R-12 needs only his approval). GOAL CLAUSE: plan pui-first-party-public-release-2026-09-07 ## Requirements R-12 (Executable release evidence). RATING BASIS: the model is the pass floor and every numbered driftMarker is also rated; a degraded or failing rating names the marker number(s) that tripped. RATING BASIS (M2): until Avi’s approval of the exact final candidate is recorded in a plan Decision, R-12 rates unknown, not fail; an unknown here is the expected owner-gated state, not a defect.",
      "driftMarkers": "BROKEN if any ONE holds: (1) readiness is inferred only from unit counts, adapter-only tests, screenshots of an empty composer or terminal work-item statuses; (2) installed-PUI real-engine journeys on the exact final candidate are missing; (3) no eligible lineage-independent grade exists; (4) the approval is inferred from an agent turn, a coord message, a prior candidate or a directive that does not name the candidate, instead of an owner-typed directive (turn-provenance OWNER) quoted in a plan Decision naming the candidate version or sha; (5) a participant study is claimed as observed, or treated as required despite D-041 removing it.",
      "replication": "REPLICATION DRILL: run release-acceptance AUTO-BAR-R-12-P-012 installed-binary journey and real-engine PTY; inspect the independent scorecard and the implementer acceptance; inspect Avi's recorded release approval of this exact candidate (D-041): the plan Decision that quotes his owner-typed directive naming the candidate version or sha. No participant-study evidence is required or accepted.\nREPLICATION SOURCES: packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts; packages/operator-core/lib/pui-e2e/public-package.integration.test.ts; packages/operator-core/lib/pui-e2e/release-acceptance.integration.test.ts.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts",
          "packages/operator-core/lib/pui-e2e/public-package.integration.test.ts",
          "packages/operator-core/lib/pui-e2e/release-acceptance.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-13",
      "title": "Our own durable task list",
      "model": "The installed PUI has one first-class task list that its owner and the attached agent share.",
      "bar": "The installed PUI has one first-class task list that its owner and the attached agent share.",
      "barKey": "R-13",
      "barHash": "49752323f6f3770fa55b7e28dced439e23eac8e21850aa9abddba95feb111cc1",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-07T05:45:21.152Z",
        "declaredBy": "su-84c127f1-787b-49ea-849d-47d1b6217757"
      },
      "method": "Run the context/task cockpit PTY suite and installed task journeys covering add/edit/reorder/start/block/unblock/complete/reopen/drop, agent updates, provenance, restart, session switch, and engine continuity. NAMED CASES that fail for this criterion's drift (cite names, not lines): context-pane-cockpit-pty.integration.test.ts: 'PUI-TASK owner journey: edit retry, agent update, add/status/block/reopen/reorder/drop persist across reload and session scope'; 'codex target is read-only: degraded footer, and task keys emit no wire ops'. agent-chat-pty.integration.test.ts: 'PUI-TASK: an SU-session task list is edited in Context by owner and agent and survives restart'. GOAL CLAUSE: plan pui-first-party-public-release-2026-09-07 ## Requirements R-13 (Our own durable task list). GOVERNING DECISIONS: D-007 (our own task list is core scope), D-019 (the editable task list is keyed on the PUI conversation and the attached agent writes the same list). RATING BASIS: the model is the pass floor and every numbered driftMarker is also rated; a degraded or failing rating names the marker number(s) that tripped.",
      "driftMarkers": "BROKEN if any ONE holds: (1) the owner cannot add, edit, reorder, start, block, unblock, complete, reopen or drop a task; (2) the attached agent cannot update that same list while it works; (3) the current task, next action, progress, blockers or links to conversation/tool evidence are not visible; (4) a task, its project/session provenance or its evidence link disappears after a restart, session switch or supported engine change.",
      "replication": "REPLICATION DRILL: Run context-pane-cockpit-pty \"PUI-TASK owner journey\" and agent-chat-pty \"PUI-TASK: an SU-session task list is edited in Context\"; verify task state after reload and session scope switch.\nREPLICATION SOURCES: packages/operator-core/lib/pui-e2e/context-pane-cockpit-pty.integration.test.ts; packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/pui-e2e/context-pane-cockpit-pty.integration.test.ts",
          "packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-14",
      "title": "Native-client feature replacement",
      "model": "Every native-client capability the release relies on has a first-party PUI home backed by an installed-product acceptance test.",
      "bar": "Every native-client capability the release relies on has a first-party PUI home backed by an installed-product acceptance test.",
      "barKey": "R-14",
      "barHash": "d67867036836ea2d859e35651efbba4f5a3cad19b1644e53f2dc5ce8d92872cb",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-07T05:45:21.152Z",
        "declaredBy": "su-84c127f1-787b-49ea-849d-47d1b6217757"
      },
      "method": "Compare every required native-client capability row with the committed acceptance matrix, then run its installed-product PTY acceptance case; any missing required row or unverified capability fails. NAMED CASES that fail for this criterion's drift (cite names, not lines): release-acceptance.integration.test.ts: 'AUTO-BAR-R-14-P-012: a required capability row without installed-product evidence blocks release unless the owner excluded it'. agent-chat-pty.integration.test.ts: 'PUI-COMMANDS: help and the command palette discover and execute a harmless extension'; 'PUI-TOOLS-DIFF: a file edit opens a reviewable in-PUI diff'; 'PUI-FILE-CONTEXT: selecting a project file attaches only its stable reference to the next accepted prompt'; 'PUI-USAGE: absent provider measurements render unknown instead of fabricated zero'; 'Network loads on navigation, manual refresh, and saved-view restoration'. GOVERNING DECISIONS: D-007 (native-client feature replacement is core scope), D-018 (derived required matrix; an exclusion needs the owner). GOAL CLAUSE: plan pui-first-party-public-release-2026-09-07 ## Requirements R-14 (Native-client feature replacement). RATING BASIS: the model is the pass floor and every numbered driftMarker is also rated; a degraded or failing rating names the marker number(s) that tripped.",
      "driftMarkers": "BROKEN if any ONE holds: (1) a relied-on native-client capability (task/plan progress, editor/history, tools/results/diffs, approvals and questions, session lifecycle, model/account/effort/mode settings, context/usage indicators, command/skill discovery, file/attachment selection, recovery) has no first-party PUI action or data source; (2) it has no implementation item or installed-product acceptance test; (3) a required missing capability does not block release; (4) an exclusion enters the release matrix without explicit owner approval.",
      "replication": "REPLICATION DRILL: Run release-acceptance AUTO-BAR-R-14-P-012 required-row refusal and installed-PUI PTY inventory journeys; compare each required row with its implementation item and acceptance evidence.\nREPLICATION SOURCES: packages/operator-core/lib/pui-e2e/release-acceptance.integration.test.ts; packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/pui-e2e/release-acceptance.integration.test.ts",
          "packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-15",
      "title": "Verified public distribution",
      "model": "After publication, a fresh download through the public distribution path passes first-message, tool, approval and resume acceptance in a clean environment.",
      "bar": "After publication, a fresh download through the public distribution path passes first-message, tool, approval and resume acceptance in a clean environment.",
      "barKey": "R-15",
      "barHash": "5ca378b8495d7533fefc6f7f984a3ad97a95d631ed63abbb73ab873ad34158dc",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "deployed"
      ],
      "evidencePlane": "deployed",
      "requiredTestLayers": [
        "manual-provenance"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-07T05:45:21.152Z",
        "declaredBy": "su-84c127f1-787b-49ea-849d-47d1b6217757"
      },
      "method": "After publication, download the exact public artifact into a clean environment, verify its digest/provenance/license, install it through the documented public path, and run first-message, tool, approval, and resume acceptance before marking the plan shipped. GOVERNING DECISIONS: D-034 (Avi approves an exact candidate for publication, gated on independent review), D-040 (further publication held on the chat-first UX plan). MANUAL CONTRACT: the check {instrument, none} is the platform's explicit manual contract, because publication is an owner-gated deployed event no committed test can reach. Its EVIDENCE ARTIFACTS are: (a) the release-ledger record of the published version: version, public download URL and SHA-256 digest; (b) the clean-environment install log from downloading that URL into a fresh HOME with no checkout, showing the digest, provenance and license verified; (c) the first-message, tool, approval and resume PTY journey output against the downloaded binary. Staging, current-build or pre-publication evidence does not count. GOAL CLAUSE: plan pui-first-party-public-release-2026-09-07 ## Requirements R-15 (Verified public distribution). RATING BASIS: the model is the pass floor and every numbered driftMarker is also rated; a degraded or failing rating names the marker number(s) that tripped. RATING BASIS (M2): before publication no public artifact exists, so R-15 rates unknown, not fail; after publication the grader rates it only from the three EVIDENCE ARTIFACTS above.",
      "driftMarkers": "BROKEN if any ONE holds: (1) the downloaded artifact has the wrong digest, provenance or license; (2) it cannot install in a clean environment; (3) it fails first-message, tool, approval or resume acceptance; (4) staging, current-build or pre-publication evidence is offered in place of the public-path download (this property is scoped only to P-015).",
      "replication": "REPLICATION DRILL: After P-015 publication, download the exact public artifact, verify digest/provenance/license, install in clean HOME, then run the documented first-message/tool/approval/resume PTY journey against the downloaded binary.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    }
  ],
  "decisions": [
    {
      "id": "D-001",
      "title": "Avi's correction defines the product outcome; this document is a proposal",
      "body": "The owner explicitly expects our own full TUI and rejected the native Claude pane plus unanswered hi. The initial request was for a plan; Avi subsequently approved that plan and explicitly selected AUTO/self implementation from start to finish. D-008 records that authorization. The final candidate publication gate remains explicit."
    },
    {
      "id": "D-002",
      "title": "Approved replacement of the launcher-UI rule for PUI",
      "body": "`pui-psu-exact-launch-and-task-latency-2026-09-01#D-001` currently delegates new-session UI to PSU. Avi's subsequent approval replaces that PUI-facing rule: PUI owns its session setup interface while reusing the shared launch/configuration logic. PSU remains an independent CLI and an explicitly requested advanced action. The approval is recorded in D-008 and cross-referenced to the prior launcher plan; native-client UI is no longer the ordinary PUI launch route."
    },
    {
      "id": "D-003",
      "title": "Preserve the full SU runtime contract and existing own-loop direction",
      "body": "Retain the capabilities and identity requirements from `pui-su-session-runtime-correction-2026-08-27#D-001/#D-003` and the first-party direction in `own-tui-full-divorce-2026-08-24#D-001`. Own the terminal experience and durable session orchestration. Reuse the maintained shared engine/adapters and tool plane; do not silently downgrade the product to a bare provider-chat loop or a UI around another client's terminal."
    },
    {
      "id": "D-004",
      "title": "The installed-product journey is the release authority",
      "body": "Existing adapter and backend-process tests remain useful but cannot satisfy the UI acceptance by themselves. A complete scripted installed-PUI journey must prove readiness, first message, correlated reply, tools/approvals, recovery, and absence of unwanted native UI. The grading package must distinguish source, built binary, installed binary and publicly distributed artifact."
    },
    {
      "id": "D-005",
      "title": "Prove the vertical path before adding polish or widening scope",
      "body": "P-005 is the first milestone and a hard dependency for the remaining feature waves. The three-engine/platform matrix remains an explicit commitment for whichever combinations are advertised; a first-engine success is never relabelled as completion of the public release."
    },
    {
      "id": "D-006",
      "title": "User context drives the layout and defaults",
      "body": "Preserve the earlier Surface B intent: conversation plus its contextual work surface. Use one clear project/session at the front door and keep advanced/global operational data behind explicit navigation. Existing saved state requires a reviewed migration; no destructive cleanup of history or silent permission changes."
    },
    {
      "id": "D-007",
      "title": "Owner clarification: our task list and native-client feature replacement are core scope",
      "body": "Avi clarified in this conversation: we are creating our own TUI with its own task list and the other things previously supplied by the Claude/Codex TUIs. This is a product-scope requirement, not merely a request for a new chat renderer. R-13/R-14, the native-capability matrix and P-016 make the task list and complete first-party working surfaces explicit. Backend engines may provide execution; the owner operates the task list, session controls, tools, approvals, settings and context through PUI. No required capability may remain dependent on opening the native interface."
    },
    {
      "id": "D-008",
      "title": "Owner approval: AUTO and self implementation through the complete release plan",
      "body": "Date: 2026-09-07\nOwner source: session_turn:codex:01a07a21-7a3d-7d40-bf0e-bfe5da27c603:21, read in full from the native transcript and resolved through sessions:search. Avi: \"okay write this all into the plan and then put yourself on auto mode and implement it yourself from start to finish\". This approves the complete PUI/task-list/native-client feature replacement plan and fixes the execution route to this same session. AUTO is registered owner-directed and the canonical loop owns WI-10000409. No implementation fleet/subagent fan-out. The earlier PSU-as-launcher-UI rule is replaced for ordinary PUI workflows; preserve shared launch/configuration logic and full SU runtime capabilities. Under the approved proposal, target Linux x86_64, macOS arm64/x86_64 and Windows via WSL2, with voice/fleet Advanced capabilities preserved. The final concrete public-publication gate in P-015 remains as approved."
    },
    {
      "id": "D-009",
      "title": "Owner-directed successor takeover preserves whole-plan AUTO/self execution",
      "body": "Date: 2026-09-07\nDate: 2026-09-07\nOwner source: session_turn:codex:01a07abd-234f-7453-93af-e3a2ace0e356:1. Avi directed this successor session to find Codex session 01a07a6b-de8d-7ae2-8662-773148a56abe, enter AUTO, continue where it stopped, and—because it was plan-bound—take over the whole plan rather than only its current work-item. The prior session's complete checkpoints, accepted specs, audit, regression evidence, and unresolved work remain authoritative. This current session now owns WI-10000409 plus the active plan lane and will execute all sixteen plan items under the existing self-implementation constraint. No scope or acceptance requirement changes; P-015 remains the explicit final public-publication authorization gate.\nRelated: P-001, P-002, P-003, P-004, P-005, P-006, P-007, P-008, P-009, P-010, P-011, P-012, P-013, P-014, P-015, P-016"
    },
    {
      "id": "D-010",
      "title": "Ship route: leader + headless fleet; P-014/P-015 stay sequenced last",
      "body": "Date: 2026-09-10\nOwner directive 2026-09-10 (AUTO, ownerDirected): resume the abandoned su-53f20916 Codex lane and carry this plan to shipped.\n\nROUTE (chosen under AUTO, disclosed not asked): su-f17bc46a leads; a HEADLESS fleet works the independent lanes in parallel. Eleven open items across engine parity, UI completion, session management, recovery, onboarding, packaging, release gating and terminal compatibility is fleet-scale work, not a single-session task.\n\nLANE ASSIGNMENT\n- Leader (su-f17bc46a) owns P-006 (WI-10000428, the in-flight critical path) and the ship gate P-014/P-015.\n- Fleet members take P-007 (WI-10000429), P-008 (WI-10000431), P-009 (WI-10000432), P-010 (WI-10000433), P-011+P-012 (WI-10000434/435), P-013 (WI-10000436), P-016 (WI-10000430).\n\nSEQUENCING\n- WI-10000430/432/434/435/436 were `blocked` only as a start-of-plan sequencing device with NO recorded blocker reason (verified: metadata carries no blocker object on any of the seven). P-001..P-005 are done, so that sequencing is discharged — they are moved to `open` and are genuinely parallel.\n- WI-10000437 (P-014 code-truth audit + acceptance rubric + independent grade) STAYS blocked: it is authored against as-built reality and cannot start before the implementation items are terminal.\n- WI-10000438 (P-015) STAYS blocked: it is an OWNER WALL. Public publication requires Avi's explicit approval; no agent crosses it.\n\nSHIP BAR: this plan reaches `shipped` only through the full gate — every item terminal, per-item code-truth audit with code/test citations, post-implementation acceptance rubric vetted via consult:get_feedback { policy: \"rubric-vetting\" }, an independent grade from a non-implementer outside the rubric author's lineage, and the implementer's recorded acceptance verdict. \"All items done\" is not a shipped plan."
    },
    {
      "id": "D-011",
      "title": "D: Execute this plan solo — no fleet fan-out while the system-wide agent pause stands",
      "body": "Date: 2026-09-11\nRULING: every remaining item on this plan is executed by the owner-directed session (su-f17bc46a) itself. Do NOT launch a fleet, place cups, or fan these items out to peers. This SUPERSEDES the prior recorded ship-route intent to launch a 3-member `pui-public-release` fleet on P-007/P-008/P-010.\n\nWHY: two owner-typed turns are in force and they must both be honoured.\n\nMeasured: `facts:list { scope:'workspace', key:'system-wide-agent-work-state', full:true }` returns a live, unretracted ⛔ SYSTEM-WIDE AGENT PAUSE whose origin is owner-typed turn session_turn:claude:2c5dcf1f-40d4-45e4-adad-9fae61946326:28 @2026-09-09T20:35:58Z — \"TELL ALL AGENT SSYSTEM WIDE TO PAUSE THEIR WORK IMMEDIATELY\". Its stated lift condition is a NEW owner-typed turn, and nothing else.\n\nMeasured: `sessions:search { session:'self', owner_candidates:true, since:'2026-09-09T20:35:58Z' }` returns exactly one hit, session_turn:claude:26fa96e4-ebd1-4cbf-b8e4-19ffc0c9677d:0 @2026-09-10T23:50:06Z, with turn_origin.verdict='owner-typed': \"find this session then put yourself on auto mdoe and continue where they left off nad carry the plan to shipped status 01a08db7-...\".\n\nThe second turn is a genuine lift — but it is addressed to ONE session (\"put YOURSELF on auto mode\"). It authorises this session's autonomous work on this plan; it does not re-authorise the fleet. Spawning agents is the precise activity the pause names, so a fleet launch would route around a standing owner directive on the strength of a turn that never mentioned other agents.\n\nCONSEQUENCE: P-007/P-008/P-010 are worked sequentially by this session rather than in parallel. This trades throughput for not overriding the owner. If the owner lifts the pause fleet-wide in a later turn, this decision may be revisited and the fan-out resumed.\n\nThe workspace fact was amended (not retracted) to carry this narrow carve-out verbatim, so a successor or peer reading it cannot mistake either half: the pause still binds everyone else, and this lane is authorised.\nRelated: P-006, P-007, P-008, P-010"
    },
    {
      "id": "D-012",
      "title": "Every real-engine evidence leg MUST pin its model explicitly; an inherited CLI default model is an invisible dependency on a quota balance",
      "body": "Date: 2026-09-11\nRULING (binds every lane producing real-engine evidence for this plan, not just P-006): any harness, script, or recorded reproduction command that runs a REAL engine leg must set the model EXPLICITLY (for the Claude leg, `PUI_REAL_MODEL`). Omitting it is not a neutral default — it binds the leg to the engine CLI's implicit default model, and therefore to that model's quota balance on whatever credential is in play. A recorded command that omits the model cannot reproduce its own recorded result once that balance moves.\n\nWHY THIS IS A RULING AND NOT A SCRIPT COMMENT: the failure mode is not \"the leg fails\". It is that the leg fails **in the direction that most resembles your own code breaking**, and it does so while three independent instruments corroborate the wrong conclusion:\n  1. The leg passes at an older source head and fails at current source — because the older run happened to pin a model — which reads as a source regression bisected to a commit range.\n  2. The engine logs contain no refusal text at all, so a grep for quota/auth evidence comes back empty, which reads as positive proof that quota is NOT the cause.\n  3. The refusal presents as a long silent hang rather than the ~5s explicit refusal it actually was.\nCost when this fired on 2026-09-11: hours, a work-item filed under a false \"MEASURED REGRESSION\" title (WI-10001027), and a retracted route-confound theory. Two of the three corroborating instruments were themselves engine defects, now fixed at bb945b55ab; the third is this configuration gap, which the fix does NOT close.\n\nMEASURED (2026-09-11):\n- `grep -c PUI_REAL_MODEL .papercusp/scratch/p006/r10-repeat.sh .papercusp/scratch/p006/r10-route-ab.sh` → `0` and `0` before this ruling; `3` and `2` after pinning (`export PUI_REAL_MODEL=\"${PUI_REAL_MODEL:-sonnet}\"`, overridable — verified default=sonnet, override=haiku).\n- R-10 at source head 0febf8f73a: 11:27:03Z with the model pinned to sonnet → `status=passed`, against 5 failures at the SAME head with no model pinned.\n- Route controlled and eliminated as the discriminator: route=default FAILED unpinned (11:19:41Z) and PASSED pinned (11:27:03Z).\n- Bare probes: `claude -p '...'` on the implicit default model → exit 1 with an explicit quota-limit refusal; `claude --model sonnet|haiku|opus -p '...'` → exit 0.\n\nCONSEQUENCES FOR THIS PLAN:\n- A P-006 (or any) evidence artifact whose recorded reproduction command omits the model is NOT reproducible and must not be bound as spec evidence. This is the same defect class as EI-22959184107034728 (a recorded `probe.guardCommand` that omits `PUI_REAL_ENGINE` and cannot reproduce its own recorded result) — treat an omitted model identically.\n- Durability: `.papercusp/scratch/**` is gitignored and session-local, so a pin that lives ONLY in a scratch runner is re-armed for the next agent the moment that scratch is gone (the `deliverable-durability` guard flagged exactly this on the WI-10001027 close, with `missing-from-commit` for both script paths). That is why this ruling is recorded HERE rather than as a comment in the runners: this plan Decision is the durable artifact, and any committed successor to those runners must carry the pin.\n- Do NOT re-derive the Claude leg as owner-gated or capacity-blocked. Claude is neither; the account is healthy. The CODEX leg remains genuinely owner-gated on exhausted credits to 2026-09-14T21:26Z — a separate and unrelated wall.\nRelated: P-006"
    },
    {
      "id": "D-013",
      "title": "D-012 is CLAUDE-scoped: pinning PUI_REAL_MODEL is REFUSED on the OMP backend under account=auto",
      "body": "Date: 2026-09-11\nQualifies, does not revoke, `pui-first-party-public-release-2026-09-07#D-012` (\"PIN PUI_REAL_MODEL on every real-engine leg\").\n\n#### The limit of D-012\n\nD-012 was derived entirely from the CLAUDE leg (WI-10001027): an unset `PUI_REAL_MODEL` there makes the child inherit the Claude CLI's implicit default model, whose quota is exhausted on the default credential, so a pure quota wall reads as a source regression. That reasoning is sound **for Claude** and stands.\n\nIt does NOT transfer to OMP. On `PUI_REAL_BACKEND=omp` with `PUI_REAL_ACCOUNT=auto`, pinning a model is actively REFUSED at engine start:\n\n```\n503 {\"code\":\"attached_engine_start_failed\",\n     \"error\":\"--account auto could not be honored: OMP model 'sonnet'\n              is not compatible with gateway account routing;\n              refusing model substitution.\"}\n```\n\nSo applying D-012 uniformly across engines converts a working OMP leg into a 503. This matters precisely because P-006 is the PARITY item: the engines are NOT symmetric in model/account handling, and a convention written from one engine's failure can break another's.\n\n#### Ruling\n\nRead D-012 as scoped to the CLAUDE backend. For a real-engine leg:\n\n- **Claude** — PIN `PUI_REAL_MODEL` (D-012 unchanged; default `sonnet`).\n- **OMP with `PUI_REAL_ACCOUNT=auto`** — do NOT pin `PUI_REAL_MODEL`; gateway account routing selects the model and refuses substitution. Pin the model only alongside a non-`auto` account route.\n- **Codex** — NOT ESTABLISHED. Credits are exhausted to 2026-09-14T21:26Z, so no codex leg has been exercised; do not assume either behaviour.\n\nAny lane recording a replay command for a real-engine journey must state which backend it targets, because the correct env differs by backend.\n\n#### Measured\n\n- `.papercusp/scratch/p006/ei22959-positive.log` (2026-09-11T12:23Z, HEAD ee41f91769): OMP + `PUI_REAL_ACCOUNT=auto` + `PUI_REAL_MODEL=sonnet` → `TEST_FILE_GROUP_RESULT cwd=packages/operator-core executed=1 status=failed`, with the 503 above. Note `executed=1` — the test RAN and the engine refused; this is not a selection/skip failure.\n- Refusal text quoted verbatim from that log.\n- Claude-side evidence for D-012 itself is unchanged (11:27:03Z `status=passed` with `model=sonnet` vs 5 unpinned failures at the same head).\n\n#### Not yet established\n\nWhether OMP + `auto` with NO model pin passes end-to-end is still being measured (re-run in flight, `task_id 0mtwxb17l1e81csiy97`). This decision rules only on the REFUSAL, which is directly measured; it does not assert that omitting the pin is sufficient for a green OMP leg.\nRelated: P-006"
    },
    {
      "id": "D-014",
      "title": "PUI spec-test-adequacy can only be satisfied by the TS pui-e2e suite; cargo tests cannot reach the evidence ledger",
      "body": "Date: 2026-09-11\nApplies to EVERY remaining code item on this plan (P-008..P-016), not just P-007 — each hits the identical gate, so do not re-derive it.\n\nWHAT work_items:complete ACTUALLY DEMANDS (read from the writers; grep the SYMBOLS, not line numbers, which rot in this repo):\nFor every enforced clause, specTestAdequacyCompletionGate (packages/operator-core/lib/agent-tools/work_items/spec-test-adequacy-gate.ts) requires BOTH (a) evaluator verdict === 'pass', AND (b) a current TERMINAL scorecard whose criterion set and verdicts match exactly and whose grading audit is settled (symbol: settledGradingAuditIsCurrent). Binding evidence is only step one and does NOT close the item.\nMeasured: grep -n 'settledGradingAuditIsCurrent\\|verdict !== .pass.' on that file returns both checks inside the per-clause loop; work_items:complete WI-10000429 was refused with all 9 clauses at verdict=fail and NO state transition written.\n\nTHE HARD CONSTRAINT — cargo tests cannot reach this gate:\nexecution-integrity requires hasExecutionLedgerReference() (packages/operator-core/lib/agent-tools/plans/spec-test-adequacy.ts), which accepts ONLY a positive safe-integer testRunId or coverageEvidenceRef. Self-attested details.adequacy booleans are explicitly rejected ('author-attested booleans cannot establish execution-integrity').\nMeasured 2026-09-11, dev:pg_query over harness_shared.test_runs, 7-day window: family rust/tui = 25 rows with workspace_id NULL and harness_slug NULL on ALL of them, newest 2026-09-08 — while a 2026-09-11 `cargo test --bin pui` run of 1014 passing tests produced ZERO new rows. Same window, pui-e2e(ts) = 87 local rows, 33 with workspace_id, 20 with harness_slug.\n\nRULING: a Rust-only proof can never satisfy execution-integrity for a first-class spec clause, however green the suite. P-007's 1014 passing cargo tests are genuine verification of behavior but are INVISIBLE to this gate. Ledger-backed proof must come from the TS side — packages/operator-core/lib/pui-e2e/*.integration.test.ts is the one suite here producing correctly attributed rows.\n\nPER-CLAUSE LAYERS: correct-layer is clause-scoped. The three authorization-class clauses (PUI-APPROVAL-ALLOW, PUI-APPROVAL-DENY, PUI-FILE-CONTEXT) are floor l4 and currently report 'e2e:missing', so they need e2e-layer proof plus targeted L4 coverage/mutation/counterexample carrying stable adequacy.causalPairIds. The six l3 clauses (AUTO-BAR-R-05-P-007, PUI-EDITOR-COPY, PUI-EDITOR-HISTORY, PUI-EDITOR-UNDO, PUI-QUESTION, PUI-TOOLS-DIFF) need l3 coverage rungs.\nMeasured: plans:evaluate-spec-test-adequacy { planItemIds:['P-007'], classRef:'plan-class-feature-ship' } → count 9, verdicts {pass:0, fail:9, unknown:0}.\n\nNOT A LICENCE TO WAIVE: the alternative the rubric names (an approvalRef-bearing waiver on the spec revision) is owner-gated. Do not self-issue one. Build the e2e proof.\n\nSEQUENCING: prove the full chain (bind → evaluate → verdict pass → scorecards:emit terminal → gate accepts) on ONE cheap l3 clause BEFORE mass-producing evidence for nine. The details contract is exacting — details.adequacy.{testLayer,pathReachable,oracleIndependent,fixtureCalibrated,falsifiable,collected,skipped,executed,outcome,targeted,coverageRungs,scenarioIds,causalPairIds} — and a wrong shape degrades silently to 'unknown' rather than erroring.\n\nTOOL GOTCHAS (each cost a round trip): `limit` on plans:evaluate-spec-test-adequacy caps the EVIDENCE SET not rows (limit:1 → {ok:false,error:'evidence_selection_hit_limit'}, no rows key); an unprojected call truncates rows and its marker misreported 'totalCount 5' when the true count was 9, so always pass a projection and read `count`/`verdicts`; clauses resolve through planItemIds:['P-007'] — workItemIds:['WI-10000429'] returns count 0; plans:get-spec-evidence returns rows under key `evidence`, not `rows`."
    },
    {
      "id": "D-015",
      "title": "PUI-FILE-CONTEXT: implement the composer @ picker rather than drop it; pin PUBLIC_RELEASE_UX affordances against the code",
      "body": "Date: 2026-09-11\n**Owner ruling [owner:Avi 2026-09-11] [turn:self], recorded because it governs P-007's scope and the shipped doc.**\n\n#### The finding that prompted it\n`apps/tui/PUBLIC_RELEASE_UX.md:315-319` (repeated in the acceptance table at `:384`) promises: \"When the composer is focused, @ opens a project-scoped file/attachment picker… Cross-project and unreadable paths are refused with the reason; PUI never falls back to a similarly named file.\"\n\nNone of it is implemented.\n\n**Measured: 2026-09-11, scope = the ENTIRE `apps/tui` tree (51 `.rs` files under `apps/tui/src`, plus `build.rs` and `apps/tui/tests/*.rs`), not one module:**\n- `grep -rn \"Char('@')\\|'@' =>\\|== '@'\" apps/tui/` -> 0 matches\n- `grep -rn \"'@'\\|\\\"@\\\"\\|b'@'\" apps/tui/src/` -> 0 matches (no `@` character in the TUI source at all)\n- `grep -rn \"attachments\\|Attachment\" apps/tui/src/*.rs` -> 0 matches (no composer attachment state)\n- `grep -rn \"Cross-project\\|cross-project\" apps/tui/` -> 0 matches outside PUBLIC_RELEASE_UX.md itself\n- The only 3 files matching `attachment` (`transcript.rs:17`, `brain_view.rs:154`, `client.rs:1036`) concern session RE-attachment — unrelated to files.\n- Modules that DO mention \"picker\" (`session_config.rs`, `models.rs`, `workbench.rs`, …) are the model/mode/account/session pickers documented elsewhere.\n\n⚠ The scope is stated deliberately. Earlier in the same session a `find -maxdepth 4` produced a convincing FALSE absence (the claude-agent-sdk, installed one level deeper), so this absence was established by searching the whole tree twice rather than by one bounded grep. A bounded search's empty result is not an absence.\n\nP-007's clause **PUI-FILE-CONTEXT@4** (falsifier: *\"picker attaches content from an unselected project or needs native UI\"*) therefore had nothing to exercise — unprovable because the behaviour does not exist, not because a test was missing.\n\n#### The ruling\nPresented three options (implement / drop the clause and retract the doc promise / defer to a later item). Avi chose **implement the picker**, as documented — including the cross-project + unreadable refusal WITH reason and no similar-name fallback, since that refusal IS the clause's falsifier rather than polish. Tracked as **WI-10001039**.\n\nAvi separately approved **pinning the acceptance table**: a doc-claims test (`packages/operator-core/lib/doc-claims/`) asserting every keyboard affordance PUBLIC_RELEASE_UX.md promises has a matching key handler in `apps/tui`, so a promise with no implementation fails the build.\n\n#### Why the pin, and why it is a plan-level decision\nThis is the SECOND documented-but-unimplemented affordance found in this plan (EI-22982452433293308 was the first). Two independent instances make PUBLIC_RELEASE_UX.md a prose surface asserting code truth with no divergence check — precisely what the derived-truth ladder says to DERIVE, PIN, or ATTEST rather than hand-maintain. Without the pin, later plan items keep discovering these one clause at a time during acceptance, which is the expensive moment to find them.\n\n**Consequence for other lanes:** do not treat PUBLIC_RELEASE_UX.md as evidence that a behaviour exists. Check the affordance against the Rust source before writing a clause test or reporting an item complete. Once the pin lands, the build enforces this.\n\n#### Status of P-007's other clauses at the time of this ruling\n8 of 9 have PASSING ledger-backed e2e tests in `packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts`: PUI-EDITOR-COPY, PUI-EDITOR-UNDO, PUI-EDITOR-HISTORY, PUI-QUESTION, PUI-TOOLS-DIFF, AUTO-BAR-R-05-P-007, PUI-APPROVAL-ALLOW, PUI-APPROVAL-DENY. **Measured: each run with `--require-ran=<clause>` so a zero-match run cannot read as green.** None are BOUND yet — the file-wide `testFingerprint` means all 9 must be bound in ONE batch (EI-22983173597670424)."
    },
    {
      "id": "D-016",
      "title": "P-011 shape: one PUI release unit reused from the sidecar recipe; lifecycle lives in the pui binary; palette lifecycle actions implemented; macOS built-but-not-advertised",
      "body": "Date: 2026-09-23\n[self-imposed under AUTO, su-091ad703, 2026-09-23 — disclosed, not asked; D-011 solo route]. Governs P-011 and what P-012/P-014 inherit.\n\nMEASURED BASIS (2026-09-23 ~04:35Z):\n- The existing pipeline already defines the PUI release unit: `bin/pui` + `pui-companion.wasm` + release-relative `pui-install.json` (papercusp-desktop/bin/build-desktop-sidecar.sh, the '# 2. pui (apps/tui)' block; WORKSPACE_HOST_PUI_* in libs/generic/deployment-driver/src/workspace-host-build-manifest.ts). `install::default_manifest_path` already resolves `<exe>/../../pui-install.json`, so that unit is relocatable as-is.\n- The only user-facing installer (apps/tui/scripts/install-update.sh) needs this checkout + Cargo + python3. R-08 forbids both.\n- PUBLIC_RELEASE_UX.md:338-343 (acceptance row :403) promises palette actions Check for updates / Update / Roll back / Diagnostics / Uninstall with preview + confirmation. None exist (grep of apps/tui/src: zero hits).\n- ~/.papercusp/zig + ~/.papercusp/macos-sdk exist, so darwin artifacts can be BUILT here (cargo zigbuild, same as the sidecar), but no macOS host is reachable to RUN them.\n\nRULING:\n1. ONE BUILD RECIPE. The public archive `pui-<version>-<target>.tar.gz` is produced from a committed source generation (git archive of apps/tui + apps/pui-zellij-plugin + apps/pui-companion-proto at one sha; SOURCE_DATE_EPOCH = commit time; the sidecar's remap flags) and carries the same unit plus zellij 0.44.3 for the target, a third-party license inventory, PROVENANCE.json, COMPATIBILITY.md, release notes, SHA256SUMS and an optional minisign signature. Reproducibility is asserted by building twice and comparing digests, not claimed.\n2. THE LIFECYCLE LIVES IN THE BINARY. `pui self install|update|rollback|uninstall|status` implements versioned releases under $PUI_HOME (default $XDG_DATA_HOME/pui): immutable `releases/<version>-<sha12>/`, `current` + `previous` links, `~/.local/bin/pui` -> current. Every release is hash-verified against its manifest before activation. User data (~/.papercusp/pui-state.json, operator.json, history) is NEVER written by install/update/rollback; it is snapshotted before an activation so rollback can restore it; uninstall keeps it unless --purge. The archive's install.sh only verifies SHA256SUMS (sha256sum or shasum) and execs `bin/pui self install`. No Cargo, python or checkout.\n3. PALETTE ACTIONS ARE IMPLEMENTED, not dropped (same class as D-015): the five actions call the same lifecycle with an exact version/path preview and confirmation. The update channel is a configured channel manifest; with none configured, Check for updates says so rather than inventing one (publication stays P-015's gate).\n4. BACKEND-SERVICE DEPENDENCY: packaged by the EXISTING sidecar/workspace-host bundle pipeline (operator + node + embedded PG + engines + its own papercusp-install/papercusp-rollback), NOT re-bundled into the client archive. The PUI archive declares the compatible backend in COMPATIBILITY.md, and the dependency is checked in-product (install finishes with `pui doctor`; P-010's setup form handles no-endpoint). R-08 permits 'installed or explained and checked in-product'.\n5. PLATFORM HONESTY (R-10): Linux x86_64 (also the WSL2 artifact) is built AND installed-verified here. macOS arm64/x86_64 are built by cross-compilation and listed in COMPATIBILITY.md as 'built, NOT verified — not advertised' with a tracked blocker (needs a macOS host for installed acceptance). They are not silently dropped and not advertised.\n\nEVIDENCE PATH (D-014): lifecycle unit tests in cargo; clause evidence from a TS pui-e2e integration test that packages, installs into an isolated HOME whose PATH has no cargo/python, updates, rolls back and uninstalls, asserting user data survives."
    },
    {
      "id": "D-017",
      "title": "R-10: the committed compatibility.json may never mark a target verified; per-candidate advertising belongs to the release stage (P-012)",
      "body": "Date: 2026-09-23\nDate: 2026-09-23. [self-imposed under AUTO, su-091ad703; D-011 solo route; disclosed, not asked]. Governs P-011 (AUTO-BAR-R-10-P-011) and what P-012 inherits.\n\nFINDING (measured 2026-09-23 ~07:45Z): apps/tui/release/compatibility.json is part of the commit it describes, so it can never hold installed-product evidence for the candidate that contains it; that evidence only exists after the archive is built and installed. Any 'verified' row in the committed file is therefore, by construction, evidence of another generation, which is exactly R-10's falsifier ('an advertised combination has ... differently versioned acceptance evidence'). The as-built packager rendered whatever status the file claimed and never checked it. The P-011 evidence test only proved that no target was currently verified, so R-10 passed vacuously.\n\nRULING: (1) apps/tui/scripts/package-release.sh refuses any committed compatibility.json that marks a target 'verified', before building anything. (2) Every archive's COMPATIBILITY.md therefore says 'Not advertised' for every target; the in-archive table carries only measured runtime requirements (glibc floor, shared libraries) and the curated platform list. (3) Advertising a platform as verified is P-012's job: the release stage attaches that candidate's installed-journey evidence (archive digest + journey record) to the published candidate, outside the archive. P-012 must compare every advertised row with the candidate digest and installed journey records; P-011 does not and cannot.\n\nEVIDENCE: packages/operator-core/lib/pui-e2e/public-package.integration.test.ts (R-10 case) commits a claim into a throwaway object store that borrows the repo's objects (so the shared checkout is never written) and asserts the packager exits non-zero naming the target, with no output directory. The unclaimed HEAD built in the same file (archive B) is the control. Manual probe 2026-09-23: claim commit 1148262d9d refused with 'compatibility.json in 1148262d9da4 marks linux-x86_64 verified, ...', no output dir.\n\nSAME PASS, R-09: redact_env (apps/tui/src/self_install.rs) moved from a name denylist to an allowlist. PUI_SETUP_DRAFT carries the unsent composer draft across a reconnect, matched no denied name, and would have been printed verbatim by `pui self diagnostics`. Only known configuration variables now show a value; any other PUI_/PAPERCUSP_/ZELLIJ variable reports '[set, value withheld]'."
    },
    {
      "id": "D-018",
      "title": "P-012 shape: a derived required matrix, reporter-harvested evidence bound to the installed binary sha, and a per-candidate verdict file the publish steps require",
      "body": "Date: 2026-09-23\nDate: 2026-09-23\n[self-imposed under AUTO, su-091ad703; D-011 solo route; disclosed, not asked]. Governs P-012 (AUTO-BAR-R-10/R-12/R-14-P-012) and what P-014/P-015 consume.\n\nMEASURED BASIS (2026-09-23 10:00-10:45Z):\n- No PUI stage exists in the release pipeline (apps/operator/lib/release, packages/operator-core/lib/release).\n- apps/tui/PUBLIC_RELEASE_UX.md holds the two required tables: '## Release platform and backend matrix' (4 targets x Claude/Codex/OMP, all Required) and '## Capability replacement interaction map' (19 required rows).\n- The PTY suites already accept PUI_BIN=<installed artifact> and emit `PUI_*_ACCEPTANCE <json>` lines carrying {binary, binarySha256}; several also carry `traffic` observed at the real operator's HTTP routes (launch-su attachedEngine/transport).\n- No test is tagged with a capability row. context-pane-cockpit-pty drives the installed binary against a FAKE node:http operator; agent-chat-pty drives it against the real operator process + PG.\n- vitest 4.1.8 reporters get onUserConsoleLog (with taskId) and onTestRunEnd (final per-test state).\n\nRULING:\n1. REQUIRED MATRIX IS DERIVED, the judgment is PINNED. packages/operator-core/lib/pui-e2e/release-acceptance.ts parses both tables out of PUBLIC_RELEASE_UX.md. The only curated data (which acceptance tags prove each capability row / each backend cell, and owner-approved exclusions) lives in apps/tui/release/acceptance-matrix.json, and the checker REFUSES when the two disagree in either direction (a doc row with no mapping, or a mapping naming no doc row), so neither can drift silently.\n2. EVIDENCE = rows harvested by a vitest reporter from `PUI_*_ACCEPTANCE <json>` lines, each paired with the emitting test's FINAL state. Only state=passed counts: a line printed by a test that later failed or was skipped is not evidence. The reporter stamps the run context (target, real-engine flag, backend, pinned model).\n3. A row QUALIFIES for candidate C only if (a) binarySha256 == the sha of bin/pui installed from C's archive, which the runner computes after install and cross-checks against the archive's own digest list, AND (b) its module stamped itself as driving the PRODUCTION operator (a `PUI_ACCEPTANCE_HARNESS {operator:'production'|'fake'}` line emitted by the code that started the operator). Fake-operator suites stay lower-level coverage per P-012's own text and satisfy no row. This is R-12: an adapter-attached or test-only-path pass has no qualifying row.\n4. CHECK SEMANTICS. The candidate declares the cells it will advertise. REJECT if any advertised cell lacks a qualifying passing row for each of its journey tags (R-10); REJECT if, for any advertised target, any required capability row lacks one for each of its tags without an owner-approved exclusion (R-14); REJECT if nothing is advertised. Every required cell NOT advertised is listed with its reason, never dropped. An exclusion needs approvedBy 'owner:<name>' and a decisionRef; an agent cannot author one on its own.\n5. RELEASE STAGE. A runner packages C (package-release.sh), installs it into a clean HOME, runs the production-operator PTY suites with PUI_BIN=<installed bin/pui> through the reporter (real-engine legs per advertised backend, model pinned per D-012/D-013), runs the checker and writes `<archive>.acceptance.json` (candidate digest, installed sha, verdict, per-cell/per-row status). It exits non-zero on REJECT. P-014/P-015 may publish only an archive whose acceptance file passes for the SAME archive digest. compatibility.json stays 'built-unverified' (D-017); advertising lives only in the per-candidate file.\n6. CLAUSE EVIDENCE (D-014): release-acceptance.integration.test.ts. R-10/R-14: a complete fixture (the positive control) passes; dropping one advertised cell's row, or one required capability row, is refused and names it; an unapproved exclusion does not unblock. R-12: package + install a real candidate, run one production journey through the reporter with PUI_BIN=<installed>, and assert that row qualifies for the installed sha while the same journey from a non-installed binary, or from a fake-operator module, does not.\n\nKNOWN CONSEQUENCE: capability rows with no production-operator installed test (task list, likely settings pickers and About/Support) will make the current candidate REJECT. That is the correct output: those gaps become P-012 work (or an owner exclusion), not something to paper over in the mapping."
    },
    {
      "id": "D-019",
      "title": "Editable task list is keyed on the PUI conversation: SU-session chats are task-writable and the attached SU agent's task tools resolve to the chat id",
      "body": "Date: 2026-09-23\nDate: 2026-09-23 [self-imposed under AUTO, su-091ad703; D-011 solo route; disclosed, not asked]. Governs P-012's 'Editable task list' capability row (R-14) and what P-014/P-015 inherit.\n\nMEASURED (2026-09-23 ~11:45Z, reading HEAD fb153a2683):\n- agent-chats-data.ts createChat: 'every newly created PUI conversation is homed on the canonical SU-session host' (su_runtime_class='su-session'); 'legacy-owned-loop' is a historical label no writer may create.\n- conversation-context-projection.ts projectConversationContext: capabilities.taskWrite = freshLoopLedger (an agent_loop_sessions row whose transcript_turns == transcript length). An SU-session chat has no such row, so its tier is 'transcript-only' and taskWrite=false; task-ops.ts mutateAgentChatTask refuses 409 task_write_unavailable. apps/tui app.rs context_task_write_available keys on capabilities.task_write, so every a/e/s/x/b/u/r/J/K/d/P key is inert on every session PUI can create today.\n- agent-tools/tasks/runtime.ts resolveSessionTaskRuntime: an MCP caller's task session is identity.ownerId. For an attached PUI SU session that is PAPERCUSP_SID (su-session-attached-launch.ts), while the Context projection reads session_tasks by chat.id. So the agent's own tasks:ops list never appears in the PUI Context of its conversation.\n- adv_sessions.su_agent_chat_id (migration 1017) is UNIQUE per (workspace_id, su_agent_chat_id): the chat <-> SU coord owner binding is durable and 1:1.\n\nRULING:\n1. The canonical task-session key of a PUI conversation is its chat id, for both halves. It exists before any SU launches and survives relaunch.\n2. The session-task tool runtime resolves an SU caller (identity.ownerId = adv_sessions.coord_owner_id) whose adv session carries su_agent_chat_id to that chat id. A caller with no binding keeps identity.ownerId (psu/fleet sessions unchanged). The owned-loop rule (runId + spawnId agent-loop-<runId>) is unchanged.\n3. The projection grants taskWrite to an agent_chat whose su_runtime_class is 'su-session', in addition to a fresh owned-loop ledger. liveFrames/approvalWrite stay owned-loop only; SU approvals ride the su-session card path.\n4. The P-012 release evidence for 'Editable task list' (PUI_TASK_ACCEPTANCE) must be produced on an SU-session conversation driven through the installed binary and the production operator. The agent half must come through the production MCP route with the SU's own client identity. An owned-loop chat does not satisfy the row, because PUI cannot create one.\n\nSEPARATE FINDING (not ruled here, filed as its own work item): the interactive engine=loop lane in endpoint-route/routes/agent-chats/index.ts dispatches with an identity-less ctx and empty deps (no principal, no bound workspace tx, runId != chatId). A probe showed tasks:ops throws 'resolveAgentIdentity: context carries no ... identity' there, so the owned loop's advertised task tools cannot execute."
    },
    {
      "id": "D-020",
      "title": "P-012 settings and support rows: a launch-time pick on a running conversation opens the New SU session form; About/Support is the palette's About PUI, not a Settings screen",
      "body": "Date: 2026-09-23\nDate: 2026-09-23 [self-imposed under AUTO, su-091ad703; D-011 solo route; disclosed, not asked]. Governs P-012 capability rows 'Model/account/effort/mode settings' (PUI_SETTINGS_PICKERS_ACCEPTANCE) and 'Installation, update and support' (PUI_ABOUT_SUPPORT_ACCEPTANCE).\n\nMEASURED (2026-09-23 ~13:05Z, reading apps/tui/src/app.rs commit_session_picker + su_session_launch_options): the Model/Effort/Account/Mode picks set chat_model/chat_effort/chat_account/chat_mode, which only su_session_launch_options (a FRESH SU session launch) and the New-session form seed consume. No turn carries them. On a conversation bound to a running SU session the notes still said 'next turn runs on X', which is false. PUBLIC_RELEASE_UX.md promises such a change 'says Applies to a new session and offers that in-PUI route'; that phrase had zero hits in apps/tui/src.\n\nRULING 1: a launch-time pick (backend/model/effort/account/mode) on a bound conversation opens the in-PUI New SU session form with the pick applied and the note 'Applies to a new session: <label>. Review launches it; Esc keeps the current one.' The running conversation's chat_* state is not changed; nothing launches until Review. A pick while a turn is in flight is refused by open_session_setup's existing guard. An unbound composer keeps the direct behaviour (its first turn launches the fresh session). Pinned by app.rs unit tests a_model_pick_on_a_bound_conversation_applies_to_a_new_session / a_bound_pick_during_a_turn_is_refused_without_opening_the_form / an_unbound_pick_still_seeds_the_next_fresh_session_directly, and the PUI-SETTINGS-PICKERS e2e.\n\nRULING 2: PUBLIC_RELEASE_UX.md named 'Settings > About and Support'. PUI has no Settings screen (P-014 retired the Settings tab; census.rs records it) and the same doc makes the colon palette the single command surface. P-011 already ships :about (self_install.rs about_lines: version, source, installed release, rollback target, update channel, operator endpoint) and :diagnostics (redacted preview, y saves). The doc now names the palette's About PUI. This is a wording fix to match shipped code, not a dropped affordance: every item the doc listed is rendered. Only the evidence column of the 'Installation, update and support' row changed; release-acceptance.ts parses cells[0] only, so the matrix match is unaffected.\n\nRULING 3 (test discipline, applies to every PUI PTY journey): PUI ignores Context task keys while a mutation is in flight. It now says so on screen ('saving… task keys resume…', plans_board.rs). A journey must wait for the canonical projection (DB settled, then 'saving…' gone) before the next key, as a person would; a DB-only wait races the UI."
    },
    {
      "id": "D-021",
      "title": "PUI Claude default-mode approvals: auto-allow only server-advertised read-only SU tools (host capability_* family excluded); writes keep asking with a session-scoped remembered choice; tools:invoke is a write",
      "body": "Date: 2026-09-23\nDate: 2026-09-23 [self-imposed under AUTO, su-091ad703; D-011 solo route; disclosed, not asked]. Governs WI-10002759 and P-012's native-question journey (PUI_INSTALLED_NATIVE_QUESTION_ACCEPTANCE, Linux x86_64 x Claude cell).\n\nMEASURED (2026-09-23 16:20-16:40Z, reading HEAD): su-session-claude-engine.ts launches PUI Claude runtimes with permissionMode 'default' + settingSources user/project/local; every one of those settings files is empty on this box, so EVERY papercusp-su MCP call reaches canUseTool -> su-session-native-cards.ts handleClaude -> an Approve/Decline owner card. In diag 4 the SU's own orders_disposition after an ordinary message became such a card and the turn waited on it. The papercusp-su server already publishes readOnlyHint = (registry effect === 'read') on tools/list (_mcp-host.ts), OMP's native extension already maps it to its read/write approval class, and the SDK exposes it as mcpServerStatus().tools[].annotations.readOnly. FOUND WHILE MEASURING: tools:invoke is registered under capability agent_tools:read with no explicit effect, so it is advertised readOnlyHint:true although it dispatches ANY tool (capability:bash included) - wrong for replay safety and for any annotation-keyed approval.\n\nDECISION:\n1. The PUI Claude engine auto-allows a papercusp-su tool ONLY when the connected server advertises it readOnly, it is not in the host capability_* family (host file/code reads keep native approval parity), and the SDK did not attach matchedAskRule (a user ask rule always wins). Everything else keeps the owner card. Unknown or newly listed tools ask (fail-closed).\n2. tools:invoke becomes effect 'write' with an argument-sensitive effectForCall that returns the target's own effect, matching code:run's contract, so its advertised annotation is truthful.\n3. The approval card gains the PUBLIC_RELEASE_UX 'broader remembered permission' secondary choice whenever the SDK supplies allow suggestions. It is applied with destination 'session' only (a PUI card never writes settings files) and its label names the exact rule and that lifetime.\n4. The directive-disposition loop is NOT changed: PUI turns are owner turns and the SU dispositioning them is correct psu semantics.\n\nCONSEQUENCE: SU bookkeeping WRITES (orders_disposition, declare-intent, checkpoints) still ask once in default mode; the owner can remember them for the session. That is native Claude Code default-mode parity. The acceptance journeys must therefore answer an approval card when one appears instead of assuming none will.\n\nOPEN (owner, non-blocking): whether coordination-state writes (coord:write, work_items:write, plans:write) should be auto-allowed in default mode is a security-posture broadening I did not take; it is recorded here for the owner, not decided."
    },
    {
      "id": "D-022",
      "title": "Allow the owner directive bookkeeping write without a native approval card",
      "body": "Date: 2026-09-23\n[self-imposed] [turn:self] WI-10002759 measured an installed PUI real-Claude turn reaching `mcp__papercusp-su__orders_disposition` after a normal owner message and parking on its native approval card, so the turn/composer never settles. Root cause: PUI's `canUseTool` auto-allows only advertised read-only SU tools; `orders_disposition` is advertised as a write, so it falls through to the card handler. Ruling: In PUI default prompt mode, auto-allow only the exact `orders_disposition` tool advertised by the `papercusp-su` server as writable, and only when no user ask rule matched. Preserve approval cards for every other write, all host capability tools, unknown servers/tools, and any call matched by a user ask rule. This narrows the D-021 open scope to the required SU-owned directive bookkeeping operation; it does not authorize a blanket MCP or write-tool bypass.\nRelated: P-012"
    },
    {
      "id": "D-023",
      "title": "The task-reaper's managed-residue class spares a no-row scope that a live out-of-scope parent still holds",
      "body": "Date: 2026-09-24\nDate: 2026-09-24 [self-imposed under AUTO, su-091ad703; D-011 solo route; disclosed, not asked]. Governs P-012's real-engine acceptance and the task-manager reaper (plan agent-session-scope-reaper-2026-08-25, reaper.ts decideReaps managed-residue class).\n\nMEASURED (2026-09-24 00:14-00:18Z, diag11): the live papercusp-bg-host task-reaper stopped the installed-PUI acceptance suite's Claude engine scope pc-0mues589exrgp1j5tcj mid-turn, ~3 min after it started: journalctl 'Stopping pc-0mues589exrgp1j5tcj.scope' 00:17:54Z, then '[task-reaper] pass: 1 candidate(s), 1 reaped' 00:18:02Z. The engine exited 143 with claude_stream_failed. The suite's operator enrols its engines in its own throwaway DB but confines them into the shared papercusp-agent-session.slice, so the live ledger has no row and the managed-residue class treats the scope as orphaned residue. The same applies to any isolated-store operator on this box (e.g. VERIFY_TAURI_ISOLATED_DB desktops).\n\nRULING: 'Managed residue' means a no-row scope that NOBODY holds. `systemd-run --scope` execs the payload in the process its spawner forked, so a scope's root stays the spawner's child while the spawner lives, and is reparented to the user manager (…/init.scope) or pid 1 once the spawner dies. decideReaps now spares a no-row candidate when readScopeHolder finds a live parent outside the scope that is not init.scope, and also when the holder is unmeasurable (unmeasurable never authorizes a kill). Genuine orphans are still reaped. The terminal-residue and quiet-zombie classes are unchanged.\n\nTRADE-OFF ACCEPTED: an UNLEDGERED scope from the live store (ledger register failed) is now spared while its spawner lives, and is reaped once that spawner restarts. Real-/proc control at 00:38Z: of 143 live agent-session scopes, 3 are held (bg-host consult forks), 140 are orphaned, 0 unreadable.\n\nFALSIFIER: an isolated-store engine scope is still reaped while its spawner is alive, or an orphaned no-row scope is spared."
    },
    {
      "id": "D-024",
      "title": "Installed real-engine acceptance records bounded-timeout fallbacks as evidence instead of failing on them",
      "body": "Date: 2026-09-24\nDate: 2026-09-24 [self-imposed under AUTO, su-091ad703; D-011 solo route; disclosed, not asked]. Governs P-012's real-engine journeys in packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts (the 'installed PUI with the real <engine>' block, and every journey sharing its console.warn spy).\n\nMEASURED: diag11 (00:06-00:18Z) and diag12 (00:43-00:51Z) on the same candidate (dist6 @ 8dc662ace4). In both, the native-question journey passed every assertion and was failed only by vitest-fail-on-console on '[bounded-timeout] <label> exceeded Nms — degrading to fallback' warnings from the in-test operator. The labels differed per run: diag11 had agent-obligations:owner-directives and agent-obligations:waiting-on; diag12 had the turn-start tool surface, agent-obligations:goal-subject, agent-obligations:plan-context and the turn-start executable frontier. Box memory pressure (full avg60) reached ~19-22 during these runs. An exact-string allowlist cannot converge on a set that changes with load.\n\nRULING: a single-argument warning matching ^\\[bounded-timeout\\] \\S.* exceeded \\d+ms — degrading to fallback$ is withBoundedTimeout's timeout path (bounded-timeout.ts). The read outran its budget and returned its declared fallback, which is the designed behaviour on a slow host. Such warnings are retained as timeoutDegradations in the journey's acceptance and failure evidence and in the timing trace. They no longer fail the test. The journey's own assertions still judge correctness. Still failing: the bounded-timeout ERROR form ('… failed: <error> — degrading to fallback'), every other warning (e.g. an adv-sessions CONNECT_TIMEOUT), and every console.error.\n\nFALSIFIER: a real journey passes while a user-visible defect is caused by one of the tolerated fallbacks (e.g. missing orientation making the agent act wrongly). The evidence field makes that auditable per run."
    },
    {
      "id": "D-025",
      "title": "P-017 remote hosts: PUI runs ON the remote host through psu's own terminal bridge (--connect-program=pui), not as a local client of a forwarded remote operator",
      "body": "Date: 2026-09-24\nDate: 2026-09-24 [self-imposed under AUTO, su-091ad703; D-011 solo route; disclosed, not asked]. Governs P-017 (owner #468, owner-verified relay by su-7273d7a5: 'make sure the pui works with our remote host too like our psu utility'). SUPERSEDES my own 05:13Z ask to su-7273d7a5 (coord-send-3183911009) for listProfiles()/resolveOperatorEndpoint(name)->{baseUrl,token,dispose}, and SUPERSEDES the P-017 item text's 'non-TTY resolver' design.\n\nMeasured: 2026-09-24 05:17-05:22Z reading HEAD.\n- apps/operator/scripts/psu-connection-front-controller.mjs (97c4ca28cb): psu reaches a remote host by running `psu` ON it. For gcp-iap-ssh: `tmux new-session -A -s <key> -- env PAPERCUSP_PSU_CONNECTION_FORWARDED=1 psu <argv>` over OpenSSH. For papercusp-hosted: the workspace connector PTY is sent `exec env PAPERCUSP_PSU_CONNECTION_FORWARDED=1 psu <argv>`. The remote program's exit status comes back as psu's own.\n- Workspace hosts ship PUI (workspace-host-bootstrap.ts attests runtime.pui:true).\n- A hosted workspace exposes NO operator HTTP API to a remote client (WI-10002873), and OS Login SSH is refused on these hosts (WI-10002874), while the connector PTY works.\n\nRuling (AS BUILT): any `--connect*` cell on a pui command line (outside a `--` passthrough) makes pui exec `psu --connect-program=pui <the whole command line, verbatim>` (apps/tui/src/remote_connect.rs). psu's parser alone interprets the connection namespace. The controller consumes `--connect-program` (allowlist psu|pui, default psu) and runs that program on the host through the SAME profiles, picker, transports and reattach logic. The program is part of the tmux session name (papercusp-<program>-<digest>). It is folded into the hosted session key only when it is not psu, so every existing psu key is unchanged.\nThe remote pui gets NO PUI_OPERATOR from the controller. Like remote psu, it uses the host's own default operator selection. Measured live on avi-test: 'op http://127.0.0.1:3070' with the host's store pg-eb6b47745e43, which is not this box's pg-30bc975dfc43.\n`pui --connect` ALWAYS means a remote host: the pui picker has no 'this computer' entry, and --connect=local or a cancelled pick is refused. There is no hand-back-to-local contract, because psu passes the remote exit status through, so no status value is unambiguous. A pui launched with PAPERCUSP_PSU_CONNECTION_FORWARDED=1 refuses --connect. PUI finds the controller as `psu` on PATH, so a missing psu is refused with a hint.\n\nWhy not a local PUI on a forwarded remote operator: it would need a remote-operator token and an HTTP/SSE path that hosted workspaces lack (WI-10002873), and it would fork transport logic that psu maintains. 'Like our psu utility' rules out that second copy.\n\nEvidence (P-017 done 06:10Z, adequacy 3/3 on work item WI-10002893):\n- P017-PUI-HANDOFF: cargo 1115/0/17; remote-connect-handoff.integration 4/4 (test_runs 19248742); counterexample on the pre-P-017 binary, 3 red.\n- P017-CONTROLLER-PROGRAM: 21/21 (test_runs 19245767); counterexample on blob 97c4ca28cb, 4 red.\n- P017-REMOTE-LIVE: hermetic relay e2e 2/2 (test_runs 19248752), which on the old controller runs psu on the workspace; plus the live avi-test journey (WI-10002893#1143048).\nThe gcp-iap-ssh kind was not exercised live.\nRelated: P-017"
    },
    {
      "id": "D-026",
      "title": "PUI public artifacts use Apache-2.0 and the existing Papercusp copyright line",
      "body": "Date: 2026-09-24\nDate: 2026-09-24\nRULING: PUI, pui-companion and pui-companion-proto are distributed under Apache-2.0. The public archive carries a top-level LICENSE with `Copyright 2026 Papercusp`; Cargo manifests declare `license = \"Apache-2.0\"`.\n\nMeasured: WI-5145 was closed after all 37 existing public Papercusp repositories reported Apache-2.0, and the canonical public-library license text at libs/agent-chat/LICENSE carries `Copyright 2026 Papercusp`. The three PUI Cargo manifests previously had no license field, and the package builder emitted only THIRD_PARTY_LICENSES.md.\n\nWHY: this extends the workspace's already-shipped public license convention instead of inventing a PUI-only regime. Apache-2.0 provides the explicit patent grant already chosen for Papercusp's public components. The release packager reuses the existing canonical license text, and the archive E2E asserts the first-party LICENSE is present separately from dependency notices.\nRelated: P-015"
    },
    {
      "id": "D-027",
      "title": "Initial shipment proceeds without fabricated study evidence; the fresh-user study moves to tracked post-release learning",
      "body": "Date: 2026-09-24\nDate: 2026-09-24\nOWNER AUTHORITY: session_turn:codex:01a0d43f-5f5c-70b3-a9df-6f8e215a9ceb:1 directs this session to enter AUTO, continue the named PUI/TUI session, and carry this plan to shipped status. AUTO is registered owner-directed.\n\nRULING: the first public PUI shipment does not wait for the agent-authored pre-release participant schedule. AUTO-BAR-R-12-P-013 is exempted rather than falsely marked as manually proven. The usability-learning work remains required after shipment on WI-10003018 using apps/tui/docs/fresh-user-study.md. No participant observation is claimed in this plan completion.\n\nMeasured: conversations:get for conv-muf05x9y-0000-8c191953c4584cac8ba5826c32649f00 at 2026-09-24T16:33Z returned state=open, posts=[] and accepted_answer=null. The automated release-build terminal matrix is green (P-013 checkpoint: 9/9 journeys; release build; responsiveness, size/resize, NO_COLOR, high-contrast and 40-turn stability). P-014 still must rerun real-engine acceptance on the final candidate, finish the code-truth audit, obtain an eligible independent grade through the governed route, and P-015 must prove the public download/install journey.\n\nWHY: shipping with an explicit, auditable risk acceptance is truthful; inventing people or binding automated evidence as manual proof is not. This changes only the pre-release timing of the study and preserves the stronger automated, real-engine, independent-grade and public-download gates.\nRelated: P-013, P-014, P-015"
    },
    {
      "id": "D-028",
      "title": "Acceptance BAR amendment",
      "body": "Date: 2026-09-24\nAmendment-Id: pui-acceptance-methods-r4-20260924-resigned\nRequest-Hash: 065966b8945df560477da99efd5b4e92cfcef049aeaea83936e74ea9a5b1a1b1\nActor: su-34c85363-a7b0-41b4-9c56-48c586dda418\nReason: Apply outside-lineage-approved acceptance BAR method/check batch; preserve all 15 outcome conditions and falsifiers, then rebind invalidated proof from the final candidate.\nApproved-By: su-4163e120-e963-4531-9768-2fc638cfe2ef\nApproval-Ref: thread-post:1143372\nApproved-At: 2026-09-24T17:41:57.714Z\nRubric revision: 4 → 5\nSubject plan revision: 71 → 72\nChanged BARs: R-01, R-02, R-03, R-04, R-05, R-06, R-07, R-08, R-09, R-10, R-11, R-12, R-13, R-14, R-15\nPrior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible."
    },
    {
      "id": "D-029",
      "title": "Acceptance BAR amendment",
      "body": "Date: 2026-09-24\nAmendment-Id: pui-acceptance-falsifiers-r5-20260924-approved\nRequest-Hash: c0385ee7e11a4de0d61b4aa267dbb3a0d4f11ab3c3e4ce8df96769a9f0618c3c\nActor: su-34c85363-a7b0-41b4-9c56-48c586dda418\nReason: Apply outside-lineage-approved concrete falsifiers and detector-specific replication for all 15 PUI BARs after meta-acceptance critique.\nApproved-By: su-4163e120-e963-4531-9768-2fc638cfe2ef\nApproval-Ref: thread-post:1143379\nApproved-At: 2026-09-24T18:02:15.186Z\nRubric revision: 5 → 6\nSubject plan revision: 72 → 73\nChanged BARs: R-01, R-02, R-03, R-04, R-05, R-06, R-07, R-08, R-09, R-10, R-11, R-12, R-13, R-14, R-15\nPrior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible."
    },
    {
      "id": "D-030",
      "title": "Acceptance BAR amendment",
      "body": "Date: 2026-09-24\nAmendment-Id: amend-bb27518d3f1118fa811ff50b\nRequest-Hash: 972d00cf3ea779160912377783328c7c3240f0f0f24a705135c4e8a028712d20\nActor: su-34c85363-a7b0-41b4-9c56-48c586dda418\nReason: R-03's attached-live file is opt-in and executes zero tests in the scorecard runner; keep it as separately cited live evidence while the mandatory machine check uses runnable parity and installed-PUI scripted suites.\nApproved-By: su-bce45d81-6ee6-47f8-bb83-fd8a803cd261\nApproval-Ref: thread-post:1143468\nApproved-At: 2026-09-24T22:48:27.837Z\nRubric revision: 6 → 7\nSubject plan revision: 75 → 76\nChanged BARs: R-03\nPrior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible."
    },
    {
      "id": "D-031",
      "title": "Owner scope 2026-09-26: the PUI archive ships psu on a private Node; first-run setup gains the cloud path; bounded usability pass; r8 candidate superseded",
      "body": "Date: 2026-09-26\nDate: 2026-09-26. Source: [owner:Avi 2026-09-26] directive #567 (\"make the pui include psu as well. anything else missing from the package for users to be able to ge the beahvior we want\") plus Avi's AskUserQuestion answers in session su-9f1ef314 the same turn: scope = \"psu + cloud setup + anything else to make our app more user friendly\"; Node = \"Bundle private Node\"; route = \"You, this session\" (su-9f1ef314 implements solo). Windows was offered and NOT chosen: it stays out of scope.\n\nRULING:\n1. The public PUI archive ships psu. psu runs on a pinned, checksum-verified Node runtime bundled privately in the archive (never put on PATH), built with the same recipe as the desktop sidecar (extends D-016). pui resolves psu from its own install first, then PATH. The installer links psu beside pui, never overwrites a psu it does not own, and update/rollback/uninstall cover it.\n2. PUI's first-run setup offers a cloud path: sign in to Papercusp cloud and connect to a remote host, handing off to psu (D-025 is unchanged: remote/cloud use runs PUI on the host through psu). Internal wording is removed from setup.\n3. A bounded user-friendliness pass over the fresh-install -> first-message journey is in scope. Each fix is a concrete, observed problem, not open-ended polish.\n4. Consequence: the prepared r8 candidate is superseded. P-011/P-012/P-014 evidence is redone on the new archive, and P-015 (publish, owner-gated) waits for it. Portal download URLs (WI-10003250) are fixed at publish.\nTracking: WI-10003251 (proposal and gap evidence G1-G6)."
    },
    {
      "id": "D-032",
      "title": "PUI audio moves into a sibling pui-audio helper binary so pui starts on machines without ALSA (WI-10003295)",
      "body": "Date: 2026-09-26\nDate: 2026-09-26. Source: WI-10003295 (filed by su-f4481f51, measured: r8 and r9 bin/pui exit 127 in stock ubuntu:24.04 because cpal/rodio put libasound.so.2 in DT_NEEDED). Authority: D-031 (3), the bounded usability pass, whose route [owner:Avi 2026-09-26] was 'You, this session'.\n\nRULING: the main `pui` binary no longer links cpal or rodio. All device I/O (PTT capture, stream capture, device listing, Player playback, and the operator-voice-bus mic and mix playback) moves into a sibling binary, `pui-audio`, built from the same crate and shipped in the archive's bin/. pui drives it over stdin/stdout with a length-prefixed frame protocol. pui keeps its existing public voice API (CaptureSession, StreamCapture, Player, start_mic, start_playback, list_devices) as thin proxies, so callers do not change, and pure DSP/WAV code stays in pui. If pui-audio cannot start (exit 127, missing libasound2), voice reports a named, remediable error ('voice needs ALSA: install libasound2') and nothing else in pui is affected.\n\nREJECTED: (a) bundling libasound.so.2 (adds LGPL-2.1 distribution obligations beyond D-026, and a bundled copy cannot find the host's PipeWire ALSA plugin on non-Debian layouts); (b) static alsa-lib (duplicates alsa state when the host plugin loads the shared lib; LGPL relinking); (c) removing DT_NEEDED and binding lazily (requires dropping full RELRO/BIND_NOW hardening; fragile); (d) building the public release without voice (a product-scope cut the owner did not choose).\n\nRECURRENCE GUARD: the release stage gains a stock-container smoke (ubuntu:24.04 and debian:stable-slim, no libasound2) that runs install.sh, `pui --version`, `pui doctor` and `psu`, and refuses the candidate on any failure. The P-012 clean-HOME acceptance isolated HOME only, so missing system libraries were invisible to it."
    },
    {
      "id": "D-033",
      "title": "Owner scope 2026-09-26 (#625): release gaps found in the bundle review become plan items so the release drive picks them up",
      "body": "Date: 2026-09-26\nSource: [owner:Avi 2026-09-26] directive #625, verbatim: \"add fixing these gaps to the plan(s) so that the other agents will pick them up through the natrual course of shipping them\". This follows the bundle gap review in session su-f4481f51 (directive #612).\n\nRULING:\n1. P-025, a clean-machine release smoke, blocks P-022. It was found because r8 and r9 bin/pui exit 127 on a stock ubuntu:24.04 container (libasound.so.2 missing; WI-10003295). The P-012 acceptance could not see it because it isolates HOME, not the machine.\n2. P-026, the local-server path without the desktop app, blocks P-022. PUI needs a Papercusp server, not the desktop GUI, and the docs and setup must say so and point to an obtainable server install.\n3. macOS signing and notarization of the PUI archives goes on mac-public-release-readiness-2026-06-25 as its P-008, behind that plan's owner-credential item P-006, NOT on this plan. macOS work therefore does not hold the Linux release, and macOS stays built-not-advertised (D-016).\n4. The public download 404 is already covered by P-015 + WI-10003250, so no new item.\n5. Windows stays out of scope (D-031).\nRelated: P-025, P-026, P-022"
    },
    {
      "id": "D-034",
      "title": "Avi approves exact r14 candidate for public publication (P-015), gated on independent review",
      "body": "Date: 2026-09-27\n[owner:Avi 2026-09-27, interactive dialog answer to su-f08bc8c5 under owner directive #724] Question put: 'Publishing is a public upload, so it needs your approval of a specific build. Candidate r14 is source 8e14b49f, archive SHA-256 5f720ea9…18f6. It bundles psu, the private Node and the bin/psu wrapper, and installed testing is green. Two known r14 bugs are still open: real-Claude session resume sometimes times out at startup, and one 40-turn test run saw 37 of 40 turns.' Avi selected: 'Approve r14 now — Publish this exact build once the independent review passes with no new blockers. The two bugs are fixed in a later update.'\n\nScope of the approval (binding): ONLY the exact r14 artifact, source commit 8e14b49f815f057f7f64b82999d1d24049553fb5, archive SHA-256 5f720ea9e54bd37efe2f02ba5d8c0e1db518e47b6efb7049a7e88436088f18f6. Condition: independent pre-publication review of exactly that artifact (WI-10003414 or its successor) passes with no NEW blocking defect. EI-24355092354007517 (real-Claude exact-resume startup timeout) and EI-24375699124551107 (40-turn run observed 37) are accepted as known issues for r14 and are fixed in a follow-up release; they do not block this publication. Any different candidate (r15+) needs a fresh candidate-specific approval. Publication path: apps/tui/scripts/publish-release.sh (R2 upload + byte-identical re-download + writes ~/.config/papercusp/portal-public-links.env, consumed by papercusp-cloud-portal-reconcile) — this is also the fix for the portal Download button 404 (WI-10003250).\n\nSame dialog: Avi routed execution to su-f08bc8c5 (route A, this session) and set AUTO mode."
    },
    {
      "id": "D-035",
      "title": "Acceptance BAR amendment",
      "body": "Date: 2026-09-27\nAmendment-Id: pui-rtl-amend-2026-09-27-su-f08bc8c5\nRequest-Hash: ade5d1f3001dd5c307ff960d832be1f54a022b27436cb5e1bcb2a36fe18f2334\nActor: su-f08bc8c5-d836-4e9c-bea6-f7ddaac4d186\nReason: Add requiredTestLayers to every BAR so the ship gate proof-depth leg (bar_snapshot_proof_depth_missing on 15/15 BARs) is satisfiable. Layers derived from each BAR check files: r-03 unit+integration (su-session-capability-parity.test.ts + integration suite), r-15 e2e (manual public-journey binding, P-015), all others integration (*.integration.test.ts). Additive per dryRun (approvalRequired:false). Owner directive #724 (WI-10003472).\nApproval: not required — every change is additive (R-01, R-02, R-03, R-04, R-05, R-06, R-07, R-08, R-09, R-10, R-11, R-12, R-13, R-14, R-15)\nRubric revision: 7 → 8\nSubject plan revision: 121 → 122\nChanged BARs: R-01, R-02, R-03, R-04, R-05, R-06, R-07, R-08, R-09, R-10, R-11, R-12, R-13, R-14, R-15\nPrior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible."
    },
    {
      "id": "D-036",
      "title": "Acceptance BAR amendment",
      "body": "Date: 2026-09-27\nAmendment-Id: amend-5ec178891da90919cf5cfe05\nRequest-Hash: 96821094766a6afe390d6033a55c4e70546913b4d3d79d9fa0f2cd8bae66f73b\nActor: su-f08bc8c5-d836-4e9c-bea6-f7ddaac4d186\nReason: Vetting (consult post 1149673, su-e9228c82, outside lineage) found R-15 requiredTestLayers ['e2e'] untruthful + unrepresentable: the test ledger records only unit|integration|browser and R-15's public-download journey is proven by a manual deployed-plane binding, not a ledger test. Repair to the deployed-plane pattern {kind:'instrument', instrumentKey:'none'} + requiredTestLayers ['manual-provenance'], as the vetter recommended.\nApproved-By: su-714945e7-127e-4d3f-8e49-e78688b634bd\nApproval-Ref: thread-post:1149682\nApproved-At: 2026-09-27T16:41:28.540Z\nRubric revision: 8 → 9\nSubject plan revision: 122 → 123\nChanged BARs: R-15\nPrior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible."
    },
    {
      "id": "D-037",
      "title": "Clause proof layers follow the rubric BAR layers; the hand-authored 'e2e' label is dropped",
      "body": "Date: 2026-09-27\nContext: on 2026-09-07 the plan author (su-84c127f1) stamped requiredTestLayers ['e2e'] onto every PUI acceptance clause, at a time when the BARs declared no test layers. Rubric rev8 then gave every BAR a recordable layer (R-03 unit+integration, R-15 manual-provenance at rev9, all others integration). acceptance-bar-amendment.ts keeps extra layers authored on an atomic clause, so the re-projection left 38 clauses at {e2e,integration}.\n\nProblem: 'e2e' cannot be satisfied. The test ledger's recordedTestLayer() (libs/test-config/src/execution-details.ts) records only unit|integration|browser. The binder refuses a declared e2e layer on a ledger run that recorded integration (run_contradicts_declared_adequacy, observed on run 19778933). The PUI suites that were meant as the e2e proof (packages/operator-core/lib/pui-e2e/*.integration.test.ts, which drive the real PUI in a PTY and the real published package) are recorded as integration.\n\nRuling (su-f08bc8c5, under owner directive #724): every clause's requiredTestLayers equals its BAR's layers. 'e2e' is removed from the 38 affected clauses via plans:set-specs. Behavior, falsifier, evidence, sourceBar pin and acceptance status are unchanged. The e2e intent is still met: the integration-layer proof must be the pui-e2e PTY/package suites, not a mock. A grader should reject a binding that proves a clause with a unit-level mock where the BAR's requiredEvidence names a real PUI/PTY drive.\n\nRejected alternatives: (a) keeping e2e and binding manual evidence, which would turn 38 automated clauses into manual attestations; (b) teaching the ledger an 'e2e' layer, which would take a product change to the test recorder for one label with no runtime difference from integration here."
    },
    {
      "id": "D-038",
      "title": "Ship gate requires pass-equivalent independent ratings on all 15 BARs — remediation lane to r15",
      "body": "Date: 2026-09-27\n2026-09-27 ~19:36Z su-f08bc8c5 [self-imposed under owner directive #724; AUTO]. plans:set-plan-status shipped refused acceptance_bar_contract_not_ready / bar_snapshot_grading_not_pass on R-02, R-04, R-06, R-08, R-10, R-12. The independent cards EI-24443667830922157 and EI-24444216284272308 (su-cdeba156, rev9, identical ratings: 9 healthy, 6 degraded, 0 failing) are the authority, and my implementer verdict EI-24444439575499268 (accept) is recorded. force cannot waive this floor (precedent WI-10000278). The owner's D-034 accepted the known issues for PUBLICATION of r14; it does not make these BARs pass, and amending them to pass would conceal defects. RULING: remediate honestly. (1) R-02: fix EI-24375699124551107, message loss (37 of 40 sends observed in the scripted run). (2) R-04 and R-06: fix EI-24355092354007517, the intermittent timeout before startup readiness on exact resume. (3) R-08: fix WI-10003535, release-origin pui doctor reports STALE because the skew check needs a git checkout. (4) R-10: record installed-product acceptance for Linux x86_64 with Codex and with OMP on the r15 candidate; advertise each cell that passes and record an explicit tracked exclusion for any that fails. macOS stays unadvertised. (5) R-12 is the only contract repair: its text requires fresh-user testing, which the owner deferred to post-release in D-027 (WI-10003018). Restate that family through rubrics:amend with the required outside-lineage approval and re-vetting. Keep the study tracked; do not delete the requirement. (6) Cut r15 from one committed generation carrying (1)-(3), run release acceptance, publish, re-prove, route an independent re-grade (the rubric revision makes the gate read acceptance_ungraded, which recruits), record a new implementer verdict, then ship. The public r14 stays live meanwhile."
    },
    {
      "id": "D-039",
      "title": "Correction: D-027 is an agent ruling under AUTO, not an owner deferral; D-038 misattributed it",
      "body": "Date: 2026-09-27\nDate: 2026-09-27 ~21:35Z. Author: su-f08bc8c5 [self-imposed correction; mandate owner #724].\n\nD-038 says R-12's fresh-user study was something \"the owner deferred in D-027\". That is wrong. D-027's only owner source is session_turn:codex:01a0d43f…:1 (\"enter AUTO … carry this plan to shipped\"). The ruling that exempts the fresh-user study from pre-release R-12 was made by an agent acting under AUTO. It was not an owner decision. D-034 (Avi approving publication of r14) accepted only EI-24355092354007517 and EI-24375699124551107 as known issues. It did not mention the study.\n\nThe outside-lineage reviewer of the P-031 R-12 amendment (system:judge, thread-post on WI-10003547, objecting to thread-post:1149925) found this. The reviewer was right on both counts: the amendment removed a pre-release requirement, and it rested on a misattributed authority.\n\nWHAT STANDS NOW: R-12 still requires fresh-user testing before release. No agent may cite D-027 or D-038 as an owner deferral. Avi was asked directly via coord:ask-owner conv-mukbxp6r-0000-9d8ce804e0ba402c9581119aa6a1d5f8 (options: defer to post-release / run the study before ship / other). P-031 resumes only on his interactive answer. That answer will be recorded as its own Decision and cited by any R-12 amendment. If he declines, WI-10003018 (the study) becomes a pre-ship dependency of P-032."
    },
    {
      "id": "D-040",
      "title": "Hold further PUI publication on the chat-first UX plan",
      "body": "Date: 2026-09-28\nDate: 2026-09-28. Author: su-f08bc8c5 [self-imposed under AUTO, in response to owner directive #783 (Avi, interactive): \"THE INTERFACE FOR THE PUI SUCKS YOU EXPCET PEOPLE TO US THIS INSTEAD OF CLAUDE/CODEX\"]. A fresh default `pui` launch (2026-09-28 ~06:59Z) fails the first message (\"Session did not become ready\") and buries the chat in operator dashboards and internal jargon. No new PUI candidate (r15/r16) is published and P-032 does not proceed until plan pui-chat-first-ux-2026-09-28 P-001 to P-005 are accepted and Avi signs off on the side-by-side review (its P-006). The already-published r14 download is left in place pending Avi's call; pulling it is an outward-facing action."
    },
    {
      "id": "D-041",
      "title": "Avi removes the pre-release fresh-user study (2026-09-30): R-12 needs only his approval",
      "body": "Date: 2026-09-30\nDate: 2026-09-30. Source: [owner:Avi 2026-09-30, directive #1060], answering conv-mukbxp6r (question 2): \"no its not good enoguh the interface for chatting still sukcs.  i just tried it by launching pui fromt the terminal 2.  remove that requirement it just needs my approval only\"\n\nEffect: the 2-3 unfamiliar-user study is removed as a release requirement. It is neither run before release nor tracked as a post-release obligation. R-12 is satisfied by Avi's own approval of the installed PUI. This supersedes D-027 (an agent's AUTO deferral) and the mis-attribution in D-038. WI-10003018 (the study) is dropped with this decision as its reason. The rubric R-12 criterion is amended to cite this decision."
    },
    {
      "id": "D-042",
      "title": "Acceptance BAR amendment",
      "body": "Date: 2026-09-30\nAmendment-Id: pui-release-r12-d041-model-drift-1\nRequest-Hash: 1ee51c300b46543ad794bc4713d1c69d09914cd59fc856e982d511d9753658c3\nActor: su-f08bc8c5-d836-4e9c-bea6-f7ddaac4d186\nReason: D-041 (owner Avi, directive #1060: 'remove that requirement it just needs my approval only'): r-12 model and drift markers still require a fresh-user study that D-041 removed. Method already replaced at rev 10 (method-only). One amendment for both bar fields.\nApproved-By: su-3c6e4981-5c5e-4336-a14a-c97a331bd0eb\nApproval-Ref: thread-post:1151463\nApproved-At: 2026-09-30T17:28:11.285Z\nRubric revision: 10 → 11\nSubject plan revision: 142 → 143\nChanged BARs: R-12\nPrior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible."
    },
    {
      "id": "D-043",
      "title": "Acceptance BAR amendment",
      "body": "Date: 2026-09-30\nAmendment-Id: pui-release-rubric-rev12-apply-1\nRequest-Hash: 194c078083dcda8a1b917590e17fe4e0d81b5b987fe0db0283862ca33a5b316e\nActor: su-f08bc8c5-d836-4e9c-bea6-f7ddaac4d186\nReason: Rev 12 from rubric-vetting consult conv-muofs836 (two reviewers, both: do not attest rev 11). Blocking: r-12 replication still cited the D-027 study exemption; r-12 named no approval artifact (D-041 is a rule change, not an approval), now an owner-typed directive quoted in a plan Decision naming the candidate, with a matching drift marker; r-15 placeholder check {instrument, none} removed and the method names the release-ledger record, clean-environment install log and journey output. Hygiene: every method names the test cases that fail for its drift, and r-10/r-12/r-14/r-15 name their governing Decisions.\nApproved-By: su-2b0ac834-e2bf-4e1e-8083-db7562606a99\nApproval-Ref: thread-post:1151527\nApproved-At: 2026-09-30T18:41:57.769Z\nRubric revision: 11 → 12\nSubject plan revision: 143 → 144\nChanged BARs: R-12\nPrior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible."
    },
    {
      "id": "D-044",
      "title": "Acceptance BAR amendment",
      "body": "Date: 2026-09-30\nAmendment-Id: pui-release-rubric-rev14-apply-1\nRequest-Hash: 35a3b4b3ba644abe5ea124d436acc15479ed46bc398e3caeeab74ba21aa10054\nActor: su-f08bc8c5-d836-4e9c-bea6-f7ddaac4d186\nReason: Rev 14 from the rev-12 vetting consult conv-muogib5v, reviewer 2/2 post 1151543 (su-8fa553e0), whose findings rev 13 skipped (grading audit EI-24714006628160486 failed the rev-13 attestation for it). B1: every model was a compound paragraph (spec atomic gate flagged 15/15); each is now one pass-floor sentence and every sub-outcome it bundled moved, unchanged in meaning, into numbered driftMarkers. B2: driftMarkers are numbered \"BROKEN if any ONE holds: (1)..(n)\" and every method carries a RATING BASIS line. M1: every method already names per-case it() titles; each title is verified to exist in its bound file. M2: r-12 and r-15 rate unknown, not fail, until their owner-gated approval/publication is recorded. Checks, test layers, planes and replication are unchanged.\nApproved-By: su-d517f75e-b6e4-4fc1-9de4-8f1dd08481c0\nApproval-Ref: thread-post:1151577\nApproved-At: 2026-09-30T19:28:29.523Z\nRubric revision: 13 → 14\nSubject plan revision: 144 → 145\nChanged BARs: R-01, R-02, R-03, R-04, R-05, R-06, R-07, R-08, R-09, R-10, R-11, R-12, R-13, R-14, R-15\nPrior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible."
    },
    {
      "id": "D-045",
      "title": "Acceptance BAR amendment",
      "body": "Date: 2026-10-09\nAmendment-Id: pui-public-r16-replication-binding-f2d9-20261009\nRequest-Hash: 6c47faf9c3b745524ced494abf83e0569dcc0dc55414e1801d5e40f78cdec757\nActor: su-d2ae94c8-6225-41a3-9e5d-f230f72064d3\nReason: EI-25544435459165934; independent vetting conv-mv1koypa post1169462 found normative replication suites omitted from structured files. Bind existing R03attached-live,R08agent-chat,R10public-package,R12release-acceptance drills and explicitly name every replication source. Preserve models/drift markers/planes/layers/approval gates; no new outcomes.\nApproval: not required — every change is additive (R-03, R-08, R-10, R-12)\nRubric revision: 15 → 16\nSubject plan revision: 146 → 147\nChanged BARs: R-03, R-08, R-10, R-12\nPrior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible."
    }
  ],
  "decisionExclusions": {
    "D-005": "Sequencing rule, no distinct product outcome",
    "D-008": "AUTO/self execution authority",
    "D-009": "Successor execution authority",
    "D-010": "Superseded fleet execution route",
    "D-011": "Solo execution route",
    "D-014": "Evidence plumbing: TS pui-e2e suites bind objective criteria",
    "D-023": "Platform task-reaper infrastructure",
    "D-027": "Superseded by D-041; study removed",
    "D-028": "BAR amendment record",
    "D-029": "BAR amendment record",
    "D-030": "BAR amendment record",
    "D-033": "Process: review gaps become items",
    "D-035": "BAR amendment record",
    "D-036": "BAR amendment record",
    "D-037": "Evidence plumbing: BAR proof layers",
    "D-039": "Owner attribution correction record",
    "D-042": "BAR amendment record",
    "D-043": "BAR amendment record",
    "D-044": "BAR amendment record",
    "D-045": "Additive replication/check binding amendment record; no new product outcome"
  },
  "supersedes": "docs/evidence/pui-public-rubric15-repro-f2d9.json",
  "nodeBootstrap": {
    "supportedNodeVersions": ["v22.21.1", "v25.9.0"],
    "strippedSourceSha256": {
      "packages/operator-core/lib/agent-tools/plans/spec-clause-compiler.ts": "ee409497af652cc61bafc2b5928459ccc14c0e1c71d8f395469b115f02c75c03",
      "packages/operator-core/lib/agent-tools/plans/val-assertions.ts": "5487700d7a0520f5a5c6a1fb3e30b168e19245ef45317663e0a678ae520e58bf"
    },
    "typescriptStripper": "node:module.stripTypeScriptTypes",
    "stripMode": "strip",
    "packageLoader": "none",
    "compilerRuntimeDependencies": [
      "node:crypto",
      "./val-assertions"
    ]
  }
}

