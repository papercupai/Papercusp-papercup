# SU execution backend acceptance and replication method
URL: /internal/docs/agent-insights/su-execution-backend-acceptance

Draft evidence procedure for interchangeable PTY/programmatic SU execution, creation policy, exclusive transfers and composed transition journeys.

This is the draft replication method for interchangeable-su-execution-backends-2026-10-23. It defines required evidence; it does not certify current parity. Source decisions D-001 through D-008, the owner-obligation continuity decision, and independent critiques thread-post:1202019 and thread-post:1202036 govern the contract.

## Population and scenario identity

Freeze the P-001 capability/request-family inventory by revision and content hash. Enumerate Claude/PTY, Claude/programmatic, Codex/PTY and Codex/programmatic for each qualified native version and host. Each mandatory row names a maintained test case, negative control, owning item and exact result receipt. Unknown, refused, unsupported and skipped remain explicit; mandatory programmatic rows cannot pass by hidden PTY fallback. Native-only terminal presentation and private provider state are classified separately. Prompt fixtures retain digests rather than machine-specific rendered system prompts.

## Creation and transition policy

Default execution kind once at creation using the recorded launch classification and selection source. Explicit supported PTY/programmatic selection wins. Omission is the only default trigger: any present unknown, unsupported, empty or mutually conflicting explicit selection receives a typed refusal before defaulting or native launch. A valid explicit choice wins over a merely inferred headless default. New unattended/headless Claude/Codex sessions with no selection default programmatic; native interactive-terminal defaults remain PTY, and existing structured-client defaults remain supported. Reconnect, resume and attachment preserve the saved decision. Recover a legacy missing selection from durable transport evidence or refuse as unknown instead of applying the new-session default.

Same-provider handoff and cross-provider transfer both preserve one logical-session driver. Inventory queued/steered commands, requests and answer receipts, wake receipts, asset/attachment leases, background tasks, active awaits/subscriptions, armed loops/timers, fleet membership/leadership registrations and uncertain tool outcomes. Each active owner-required scheduler/control-plane obligation must survive transfer/rebinding through existing shared stores under one authoritative owner/generation. If its capability policy makes the registration non-transferable, preserve the duty through a supported replacement or visibly refuse the handoff before fencing; rollback must restore the duty after failure. Cancellation/non-transfer receipts alone never discharge owner scope: cancel only completed, superseded or explicitly owner-cancelled obligations. Never clone claims, locks, membership or leadership, and never leave source registrations able to consume or produce a second wake after fencing. Settle, transfer with stable identities, cancel with explicit receipts, or refuse before commit. Quiesce and checkpoint the source, fence its generation, verify the target, then commit delivery routing. Rollback first proves or fences target non-execution and establishes a fresh authoritative generation; never revive an unfenced old generation.

Cross-provider transfer uses a new valid target-native identity. The portable envelope names owner-visible messages, checkpoint/work references, authorized asset references, source provider/model/execution/version, portable instructions/modes, pending-state dispositions, lineage and machine-readable omissions. Re-evaluate target authority. Exclude source-native IDs/grants, unresolved permission answers, process handles and copied claim/lock records. Logical work/claim references remain governed by the shared authoritative stores. A copy/fork is separately named and gets a distinct logical identity.

## REPLICATION DRILL

1. Select the exact current-build route for each operator-api, background-federation and desktop-native scenario with dev:pipeline\_position. Prepare any missing isolated runtime. Record source/build/native-version/fixture fingerprints and the actual loaded runtime. Reserve final-release evidence for the shipped artifact.

2. Prepare an isolated workspace, deterministic image/file marker, permission boundary, two native conversation identities and a controllable peer/event/timer source. A representative prompt is: 'Report the marker in the attached image. Ask me to select a route before making the requested edit. Wait for a peer follow-up.' Scenario-specific prompts and image bytes are pinned by the inventory.

3. Run the maintained selectors from criterion.check.cases verbatim in each criterion.check.files entry; never derive a case title from an R-N number. Missing cases or an empty selection remain UNKNOWN. R-18 inventory preflight, final qualification and structural accounting have distinct selectors and proof boundaries listed below. Set PAPERCUSP\_TEST\_RUN\_HARNESS=papercusp. Capture original-source evidence with the maintained runner's PC\_EXECUTED\_SOURCE\_MAP\_WORKSPACE and PC\_EXECUTED\_SOURCE\_MAP\_OUT options. Do not stamp a later HEAD onto a moving-source result.

4. For each provider execute the composed journey: programmatic launch, image/file input, live question and permission request, reconnect, native fork, wake consumption, warm/cold carry, and programmatic-to-PTY-to-programmatic round trip. Place a pending question and permission request at both handoff directions and each wake receipt stage. Inject target-readiness failure and lost acknowledgements. Verify stable request scope/provenance, one answer, one command consumer, lineage and explicit terminal receipts. A declared covering array may replace the full cross-product only when every required interaction is mapped.

5. Exercise revoked/moved/expired/foreign-workspace file references, fork with pending inputs/requests/wakes, repeated re-arming, mode/authority drift, disconnected readiness, unsupported versions and deliberately broken controls. Unknown tool outcomes are never automatically replayed.

6. Bind exact scenario receipts and mutation/counterexample evidence to current spec revisions. Required evidence planes use the existing current-cohort binding gate: live/deployed rows carry details.evidencePlane and an environment fingerprint or validated ledger-only measurement. Exact operational receipt and scenario identities belong in clause.requiredEvidence and falsifier.requiredScenarios; retain recorded unit/integration/e2e/llm/browser test layers, and never invent a manual-provenance test layer. Tree selectors alone cannot satisfy a live/deployed binding. Re-evaluate spec-test adequacy and freshness, complete the canonical independent grading-integrity and acceptance workflows, then record the author verdict. Prior green files without these new selectors cannot certify parity.

7. After green promotion, verify the exact deployed artifact's omitted-kind default, explicit PTY override, interactive/live-session preservation and bounded rollback/handoff smoke. Close isolated tasks and release fixture assets; preserve complete result references and accountable optional limits.

## Sensitive input handling

Never persist plaintext secrets in owner-visible messages, event payloads, logs, checkpoints, portable context or test receipts. Preserve native secret-question metadata and use a private input route with scoped delivery and redacted receipts. Authentication URL flows stay in the provider flow; token refresh uses only the selected account credential route. If secure entry or a native request family is unavailable, return an explicit refusal rather than downgrade it to an ordinary text card. Cancellation, disconnect and handoff invalidate pending secret answers; fixtures use synthetic markers and prove absence from public sinks.

## P-001 inventory and evidence plan

The versioned fixture is packages/operator-core/lib/**fixtures**/su-execution-parity.ts. Its fixture revision is part of every qualification fingerprint. It records installed Claude CLI/SDK and Codex versions and schema digests; upgrade or host changes invalidate the corresponding rows. Official Codex protocol guidance: [App Server](https://learn.chatgpt.com/docs/app-server). Installed declarations define the measured census; documentation and declarations alone never establish runtime support.

Every provider/execution combination has the nineteen requirement scenarios plus a separate row for each applicable native request family. Permission, question, form/URL elicitation, dynamic-tool, credential refresh and attestation duties have distinct actions and falsifiers. Claude SDK controls have a separate census. Fixture revision 4 adds a distinct PTY-control scenario for each of the twelve decoder modes in each of the four provider/execution combinations, including the scoped identity-assume control and its source-fencing and exclusive-owner proof obligations. Each control row records classification, disposition, boundary, owner, implementation paths, maintained drill targets, action and falsifier. These targets are qualification duties, not passing support claims. Programmatic raw/colour controls require explicit refusal while semantic interruption and structured state retain their own mandatory scenarios; retired compact is refused on every route. Native-only raw keys/colour and retired compact controls retain explicit boundaries; they cannot exempt semantic owner control or required headless duties. All initial qualification rows remain unknown.

Run SU-EXEC R-1 acceptance contract and SU-EXEC R-18 inventory preflight in both files listed in the selector contract below through npm run test:file. These P-001 cases establish inventory inputs and exercise the isolated PTY transport with a controlled child; they may pass while native-provider qualification remains unknown. They do not discharge final R-18 qualification. The separate SU-EXEC R-18 final qualification selectors belong to P-018/P-020 and must ingest measured population/receipts, validate current inventory/native/source/document fingerprints, reject missing or failed mandatory proof and require accountable optional-gap dispositions. The selected structural accounting control is accounting-only and cannot substitute for either final detector. The live engine smoke remains separately opt-in and does not certify this matrix. P-005/P-007 implement individual request families, P-017/P-018 attach the exact runtime scenario receipts, P-019 finalizes procedures, and P-020/P-021 own independent acceptance and exact-artifact shipment. Synthetic positive/negative receipts test only the accounting guard. Missing rows, missing positive/negative evidence, duplicate rows, changed CLI/SDK version and hidden PTY fallback each fail the guard.

Use the existing private Postgres route (PAPERCUSP\_TEST\_PG\_ADMIN\_URL, or scripts/with-test-pg.mjs with an explicit reporter-only PAPERCUSP\_TEST\_RUNS\_DB\_URL for durable receipts) when shared test storage admission refuses writes. Preserve storage admission and private-process teardown; never stop the shared database or delete peers' fixtures. Missing or skipped live proof remains unknown.

{/* su-exec-selectors:begin */}

```json
{
  "selectionSource": "criterion.check.cases",
  "preflight": {
    "files": [
      "packages/operator-core/lib/su-session-capability-parity.test.ts",
      "packages/operator-core/lib/su-session-attached-live.integration.test.ts"
    ],
    "cases": [
      "SU-EXEC R-1 acceptance contract",
      "SU-EXEC R-18 inventory preflight"
    ]
  },
  "final": {
    "files": [
      "packages/operator-core/lib/su-session-capability-parity.test.ts",
      "packages/operator-core/lib/su-session-attached-live.integration.test.ts"
    ],
    "cases": [
      "SU-EXEC R-18 final qualification"
    ],
    "requires": "measured-population-and-receipt-validation"
  },
  "accounting": {
    "file": "packages/operator-core/lib/su-session-capability-parity.test.ts",
    "cases": [
      "rejects missing rows, false passes, changed scope and hidden PTY fallback"
    ],
    "scope": "accounting-only"
  }
}
```

{/* su-exec-selectors:end */}
