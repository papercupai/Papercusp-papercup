/**
 * production-defaults.test.ts — the "flags default ON" acceptance guard.
 *
 * Repo rule (CLAUDE.md "Feature flags + PostHog"): **new flags DEFAULT TO
 * ENABLED — finished work never ships dark.** Default-OFF is reserved for
 * genuinely incomplete/unsafe work or an explicit owner ask.
 *
 * FLAG-DEFAULT INVERSION (enforce-system-on-generic-work-2026-06-29 P-011):
 * the dark set is no longer held here. It lives in the RUNTIME registry
 * `DARK_FLAGS` (libs/flags/src/types.ts), and `FLAG_DEFAULTS` is DERIVED from
 * it (`!DARK_FLAGS.has(key)`). A newly-registered flag that is NOT in DARK_FLAGS
 * now defaults ON (previously a missing FLAG_DEFAULTS entry was a compile error).
 * This test SOURCES its allowlist from DARK_FLAGS rather than re-declaring it, so
 * "every default-OFF flag has a vetted reason" is true BY CONSTRUCTION; the guards
 * below assert the registry stays a small, reasoned, non-stale, in-bounds set.
 *
 * Pure unit, no env/network (same as types.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  ALL_FLAG_KEYS,
  DARK_FLAGS,
  DARK_FLAGS_PARKING_CASES,
  DARK_FLAGS_PARKING_COUNT,
  DARK_FLAGS_OWNER_CASES,
  DARK_FLAGS_HIGH_WATERMARK,
  DARK_FLAGS_PARKING_REVIEW_BY,
  DARK_FLAGS_OWNER_REVIEW_BY,
  darkFlagReviewLane,
  FLAGS,
  FLAG_DEFAULTS,
  type DarkCase,
} from "./types";

const VALID_DARK_CASES: ReadonlySet<DarkCase> = new Set<DarkCase>([
  "incomplete",
  "owner-authority",
  "cutover",
  "parked",
]);

/**
 * VALUE-PRESERVATION SNAPSHOT — the safety net for the P-011 inversion.
 *
 * Captured from the PRE-INVERSION hand-written FLAG_DEFAULTS literal on
 * 2026-06-29 (the exact set of keys that resolved to `false` then). The change
 * MUST be strictly value-preserving: the set of flags that resolve default-OFF
 * after the inversion has to be IDENTICAL to this snapshot. These are raw string
 * literals on purpose — an independent pin that does NOT read DARK_FLAGS, so it
 * fails loudly if the derivation ever silently flips a flag.
 */
const PRE_INVERSION_DEFAULT_OFF: ReadonlySet<string> = new Set<string>([
  // papercusp-capability-exec-sandbox: EI-16635 BUG-FIX correction (EI-7230-class —
  // own comment always said "OFF by default until validated end-to-end on a
  // bwrap-capable host", never actually added to DARK_FLAGS, so P-011 derived it
  // live default-ON — live-evidenced harm: a backgrounded capability:bash job died
  // ~3-6s after the launching call returned via the bwrap `--die-with-parent` path).
  // Count 27 → 28.
  "papercusp-capability-exec-sandbox",
  "papercusp-cloudflare-publish",
  "papercusp-harness-phases",
  "papercusp-design",
  "papercusp-testing",
  "papercusp-open-signup",
  // papercusp-per-hive-release-gate GRADUATED to default-ON 2026-07-03 (D-008 canary
  // met: oddsmith checkpoint green + main FF'd) — removed from this snapshot; the
  // count assertion below dropped from 10 to 9 to match.
  "papercusp-auth-config-overrides",
  "papercusp-external-bench",
  // papercusp-test-completion-gate GRADUATED to default-ON 2026-07-04 (dark-flag-age
  // review, EI-7280 — see libs/flags/src/types.ts DARK_FLAGS): enforce-system-on-
  // generic-work-2026-06-29 P-014 verified it LIVE + enabled with zero blast radius
  // (done-without-test watchdog signalCount:0 since activation) — removed from this
  // snapshot; the count assertion below dropped to match.
  // Added AFTER the snapshot (deliberate new dark flags, not inversion drift):
  // (papercusp-presence-gossip graduated 2026-07-16 — LIVE-1 P-059 tower↔VM
  // 2-machine verify met the dark-entry gate; see types.ts DARK_FLAGS note.)
  // 2026-07-03 — per-host "accept delegated seats" trust gate (agent-allocation-
  // framework P-008 / D-006, owner-authority): letting a REMOTE fleet owner spawn on
  // this host is opt-in, so it ships fail-closed (default-OFF) permanently — each
  // contributing host flips it ON per-host. Not a pending-flip; OFF is the correct default.
  "papercusp-accept-delegated-seats",
  // 2026-07-14 (WI-2479) — persistent fleet headcount auto-top-up is a
  // dangerous fleet-autonomy surface. The governor is complete but remains
  // explicitly default-OFF until its bounded no-storm behavior is ratified.
  "papercusp-fleet-headcount-governor",
  // papercusp-queen-warm-session GRADUATED to default-ON 2026-07-02 (owner flip
  // directive — see libs/flags/src/types.ts DARK_FLAGS) — removed from this
  // snapshot; the count assertion below dropped from 11 to 10 to match.
  // papercusp-codex-gateway-oauth-proxy GRADUATED to default-ON 2026-08-27
  // (WI-272118): the owner-directed production canary completed a native Luna tool
  // turn through oauth-http and delivered LUNA_AUTO_FLEET_OK. Removed from this
  // snapshot; the runtime key remains an emergency kill-switch.
  // papercusp-gateway-maintenance-carry GRADUATED to default-ON 2026-07-15 by
  // explicit owner release direction: behavioral cutover now ships live, with one
  // clean post-deploy smoke per class instead of ten pre-cutover drills.
  // 2026-07-04 — onboarding preview features (deterministic-onboarding-tutorial P-001,
  // owner-directed): gates tutorial items whose backing feature isn't ready (telemetry
  // consent, mobile pairing, auto-update channel) so a fresh install never sees them.
  // case: incomplete; default-OFF is the intended production state (ON = testers only).
  // Count 11 → 12; well under DARK_FLAGS_HIGH_WATERMARK (22), so no watermark bump.
  "papercusp-onboarding-preview-features",
  // 2026-07-04 — the-hive/Swarm lexicon skin (restore-pot-lexicon-public-release,
  // owner-directed): public release ships the Pot (Papercup) lexicon by DEFAULT, so
  // the-hive flips to default-OFF. case: parked (BUILT + kept, but cut from public V1 —
  // reachable only via the TESTING-gated BrandSwitcher, P-004). Count 12 → 13.
  "papercusp-the-hive",
  // 2026-07-04 (EI-7230) — NOT a new post-inversion darkening: a BUG-FIX correction.
  // watchdog-auto-close's own code comment (watchdog-and-exposed-systems-improvement-
  // 2026-06-18 P-009) has ALWAYS said "DEFAULT OFF — auto-closing real improvement items
  // autonomously is unsafe until the owner reviews," predating even this snapshot's
  // 2026-06-29 capture date — but it was never actually added to the old hand-written
  // FLAG_DEFAULTS literal, so it silently resolved true both before AND after the
  // inversion (hence its ABSENCE from this snapshot up to now, which only pins what was
  // ACTUALLY false pre-inversion). Adding it here + to DARK_FLAGS restores its always-
  // intended default-OFF, so the watchdog goes back to escalate-only until the owner
  // reviews the auto-close criteria. Count 13 → 14.
  "papercusp-watchdog-auto-close",
  // 2026-09-04 (EI-19360358881224651) — BUG-FIX correction in the same class:
  // GRADUATION_TRACKER's own comment has always said it ships dark until its
  // arming gate closes, but it was absent from DARK_FLAGS and therefore derived
  // default-ON. It files owner-facing reports proposing autoKinds expansion and
  // has no graduation-specific arming decision, so owner-authority is the correct
  // default-OFF posture. Safety cases do not consume a parking-watermark slot.
  "papercusp-graduation-tracker",
  // 2026-07-05 (WI-1994) — NOT a new post-inversion darkening: the same bug-fix class as
  // papercusp-watchdog-auto-close above. papercusp-substrate-sidecar's OWN code comment
  // (libs/flags/src/types.ts) has ALWAYS said "DEFAULT OFF ... Listed in KNOWN_DARK_FLAGS"
  // but it was never actually added to DARK_FLAGS, so it silently derived default-ON both
  // before and after the P-011 inversion — evidenced live harm: a fresh containerized-rig
  // frame boots the dark path and the sidecar process crash-loops (exit 1 right after
  // joining its topic), the mechanism behind WI-1910's 0 peer_connected. Adding it here +
  // to DARK_FLAGS restores its always-intended default-OFF. Count 13 → 14.
  "papercusp-substrate-sidecar",
  // 2026-07-05 (EI-7685) — NOT a new post-inversion darkening: the same bug-fix class as
  // papercusp-watchdog-auto-close / papercusp-substrate-sidecar above (THIRD instance).
  // papercusp-reclaim-stalled's OWN code comments (work-items-stale-claims.ts,
  // dbos/in-process-periodic.ts, plan-items/stale-claims.ts, fleet/spawn-reclaim.ts) have
  // ALWAYS said "default OFF" / "DARK because freeing a LIVE agent's claim changes live
  // placement on a fleet-critical hot path (D-003: land it attended)" (agent-activity-
  // liveness-truth-2026-06-21 P-003) but it was never actually added to DARK_FLAGS, so it
  // silently derived default-ON both before and after the P-011 inversion. Confirmed LIVE
  // via flags:get = true. Live-evidenced harm (EI-7685): an alive agent mid an uninterrupted
  // ~20min build had its work-item claim reclaimed by the "stalled" leg for merely not
  // calling work_items:checkpoint in the window, wiping its checkpoint and reassigning to an
  // idle peer. Adding it here + to DARK_FLAGS restores its always-intended default-OFF.
  // Count 14 → 15.
  "papercusp-reclaim-stalled",
  // 2026-07-05 (WI-3093) — NOT a new post-inversion darkening: the FOURTH instance of the
  // same bug-fix class as papercusp-watchdog-auto-close / papercusp-substrate-sidecar /
  // papercusp-reclaim-stalled above. papercusp-psu-end-user's OWN code comment
  // (libs/flags/src/types.ts, psu-in-desktop-builds-2026-06-23 C1) has ALWAYS said "DEFAULT
  // OFF — this is the legitimate owner-authority/SECURITY dark case... the owner must
  // personally ratify the end-user exposure before it defaults on... KNOWN_DARK_FLAGS" but it
  // was never actually added to DARK_FLAGS, so it silently derived default-ON both before AND
  // after the P-011 inversion. Confirmed LIVE via flags:get(papercusp-psu-end-user) = true —
  // and made ACTIVELY EXPLOITABLE (not just theoretically live) the moment WI-3093's own fix
  // rendered ConsoleLauncherButton in ChromeShell: an end user of the shipped desktop app
  // could see + click a button opening a full unauthenticated superuser agent shell, with
  // zero owner ratification. Adding it here + to DARK_FLAGS restores its always-intended
  // default-OFF. Count 15 → 16.
  "papercusp-psu-end-user",
  // 2026-07-07 — papercusp-templates-marketplace (local-first-party-template-bundling,
  // owner-directed): a DELIBERATE new dark flag (case: parked), not inversion drift.
  // V1 ships the first-party templates bundled + resolved from the local store; the
  // Cupboard MARKETPLACE merge (user-published, runtime-fetched templates) is deferred
  // to v2. The remote-fetch code is wired but dormant. OFF is the intended v1 production
  // state (ON = v2). Count 16 → 17; well under DARK_FLAGS_HIGH_WATERMARK (22).
  "papercusp-templates-marketplace",
  // 2026-07-07 — papercusp-rubrics-marketplace (local-first-party-rubric-bundling,
  // owner-directed): the rubrics sibling of papercusp-templates-marketplace — the same
  // DELIBERATE v1/v2 split (case: parked), not inversion drift. V1 bundles the
  // first-party rubrics in-app and seeds them into the workspace rubric store; the
  // Cupboard kind='rubric' marketplace merge is deferred to v2 (no remote-fetch code
  // yet — the flag reserves the seam). OFF is the intended v1 production state
  // (ON = v2). Count 17 → 18; well under DARK_FLAGS_HIGH_WATERMARK (22).
  "papercusp-rubrics-marketplace",
  // 2026-07-09 — papercusp-own-log-fork-auto-recovery (p2p-parity-parallel-lanes-
  // 2026-07-09 P-003 / WI-3535, owner-authority): the own-log-fork-guard's
  // sketched auto-recovery is a DESTRUCTIVE per-harness Corestore store reset
  // (discards unmerged local hypercore-only history) that the plan explicitly
  // requires flag-gated default-OFF until the owner personally ratifies it.
  // Deliberate new dark flag, not inversion drift. Count 18 → 19; well under
  // DARK_FLAGS_HIGH_WATERMARK (22).
  "papercusp-own-log-fork-auto-recovery",
  // 2026-07-17 — papercusp-hrw-rendezvous-authority GRADUATED default-ON (LIVE-1
  // P-059 drill, coordination lane): the attended multi-peer verify its dark entry
  // required ran on the tower↔VM rig (identical fresh candidate sets + the same
  // tower-built code on both machines) and the flag flipped ON in both stores.
  // Entry removed (the set shrinks). Count 20 → 19 relative to this list's history.
  // 2026-07-18 — papercusp-plan-part-federation GRADUATED default-ON (WI-5331 Leg B):
  // the real two-machine merge proof its dark entry demanded (P-008) ran on the live
  // tower↔Avis-iMac rig — concurrent different-part edits under flag-ON on BOTH
  // machines converged byte-identically (md5 b2f6826d…) with both edits surviving on
  // both sides (tower item:P-003 origin=remote recomposed; mac section:now
  // origin=remote recomposed; no whole-blob clobber either direction). Verdict:
  // docs/plans/p2p-part-merge-proof-2026-07-18.md D-001. Entry removed (the set
  // shrinks). Count 21 → 20 relative to this list's history.
  // 2026-07-10 (WI-3370) — NOT a new post-inversion darkening: the SIXTH instance of
  // the same bug-fix class as papercusp-watchdog-auto-close / papercusp-substrate-
  // sidecar / papercusp-reclaim-stalled / papercusp-psu-end-user / papercusp-plan-
  // part-federation above. papercusp-substrate-log-snapshot's OWN code comment
  // (libs/flags/src/types.ts, substrate-peer-log-compaction-2026-06-13 design A,
  // D-005) has ALWAYS said "DEFAULT OFF (dark) ... Listed in KNOWN_DARK_FLAGS" but
  // was never actually added to DARK_FLAGS, so it silently derived default-ON both
  // before AND after the P-011 inversion — and because ONE boolean gated both the
  // reader (seedCursorFromSnapshots) and the producer (produceLogSnapshot), the
  // unverified real-wire/cross-machine producer path (P-008, same D-003 gate as
  // AUTHORITY_RPC_PROTOMUX) was silently live too. Split as part of this fix: the
  // reader leg (unambiguously safe for the local-seed case; REQUIRED for
  // seed-history-trim-public-builds-2026-07-07's sparse public-build seed to
  // restore) is now its own default-ON papercusp-substrate-log-snapshot-reader flag
  // (NOT in this snapshot); this flag now gates only the P-008-unverified producer
  // and is restored to its always-intended default-OFF. Count 21 → 22 — AT
  // DARK_FLAGS_HIGH_WATERMARK (22); the watermark ceiling is `<=`, so this does not
  // breach it, but leaves ZERO headroom — see EI-9140's 2026-07-10 review (types.ts)
  // for the standing capacity note to the owner.
  // 2026-09-24 (p2p-join-catchup-speed-2026-09-23 P-005) — GRADUATED to default-ON and
  // removed here: the cross-machine catch-up proof it was held dark for landed
  // (P-003 cadence off the merge gate, P-004 any-distance reader, P-008 redundant-set
  // skip). Entry removed (the set shrinks).
  // 2026-07-10 (WI-3796) — NOT a new post-inversion darkening: the SEVENTH instance of
  // the same bug-fix class as papercusp-watchdog-auto-close / papercusp-substrate-sidecar /
  // papercusp-reclaim-stalled / papercusp-psu-end-user / papercusp-plan-part-federation /
  // papercusp-substrate-log-snapshot above. papercusp-git-sync-derived-attribution's OWN
  // code comment (libs/flags/src/types.ts, git-sync-dx-hardening-2026-06-17 P-004) has
  // ALWAYS said "DEFAULT OFF: it rewrites the commit hot path... Owner flips post-review"
  // but was never actually added to DARK_FLAGS, so it silently derived default-ON both
  // before AND after the P-011 inversion. Confirmed via direct PG check: no override row
  // for it in workspace papercusp-workspace (harness_shared.operator_flag_overrides). HIGH
  // blast radius: gates DERIVED per-agent commit attribution in git-sync-action.ts /
  // run-git-sync.ts — the mechanism every fleet agent depends on to land work. Adding it
  // here restores its always-intended default-OFF. This SEVENTH instance, together with
  // papercusp-doc-steward below, breaches the prior DARK_FLAGS_HIGH_WATERMARK of 22 with
  // zero graduation candidates ready — raised to 24 (see types.ts's 2026-07-10 watermark-
  // raise note) under this session's standing AUTO-mode grant rather than left live
  // pending a synchronous sign-off. Count 22 → 23.
  // GRADUATED to default-ON 2026-08-10 (WI-37718) — literal removed, so the derivation and
  // this pin fall together and offCount stays equal to this set's size. The owner flipped it
  // after the end-to-end review the dark entry demanded: the writer-side defect that made
  // derived attribution resolve a placeholder holder (EI-20055604348536487, fixed in
  // b2af0024a8) is live on every writer path, and once the last pre-fix process cycled,
  // 39/39 consecutive lock rows carried a real declared intent with zero sentinels while the
  // last 60 commits carried real per-agent subjects with zero sentinel subjects. Count
  // 33 → 32. papercusp-doc-steward (the other half of the WI-3796 pair) is unaffected.
  // 2026-07-10 (WI-3796) — the EIGHTH instance of the same bug-fix class, filed alongside
  // papercusp-git-sync-derived-attribution (which has since graduated out — see the note
  // immediately above; it is deliberately no longer in this set). papercusp-doc-steward's OWN
  // code comment (libs/flags/src/types.ts, docs-corpus-audit WS2 P-008) has ALWAYS said
  // "DEFAULT OFF: it auto-edits the doc corpus (owner-authority surface) + spawns an agent
  // per drift — flip ON after the owner-verified end-to-end check" but was never actually
  // added to DARK_FLAGS, so it silently derived default-ON both before AND after the P-011
  // inversion. Confirmed via direct PG check: no override row for it in workspace
  // papercusp-workspace. Adding it here restores its always-intended default-OFF. Count
  // 23 → 24 — AT the raised DARK_FLAGS_HIGH_WATERMARK (24); see types.ts for the raise note.
  "papercusp-doc-steward",
  // 2026-07-10 — papercusp-mem0-federation-egress (mem0-cross-machine-federation-2026-07-10
  // F1-1 mirror, D-006 privacy, case: owner-authority): DELIBERATE new dark flag, not a
  // bug-fix correction. Gates cross-machine federation of SHAREABLE memories
  // (memory:remember with shareable=true) — when ON, capture triggers enqueue shareable
  // memories to the peer-log outbox and receive-side projections apply remote memories
  // locally. Memory federation affects what personal memory data leaves the machine, so
  // only the owner ratifies when/how/which memories federate; OFF is byte-identical to
  // today's personal-only behavior. Breaches the prior watermark of 24 with zero
  // graduation candidates ready (see EI-9140/2026-07-10 review), so
  // DARK_FLAGS_HIGH_WATERMARK was raised 24→25 (see types.ts's watermark constant
  // comment). Count 24 → 25.
  "papercusp-mem0-federation-egress",
  // 2026-07-12 (WI-4238) — papercusp-queen-full-autonomy: BUG-FIX correction, NINTH
  // instance of the EI-7230 class (own comment always said "OFF by default — DELIBERATE",
  // never actually added to DARK_FLAGS, so the P-011 inversion silently derived it ON).
  // Confirmed live-ON via PG (no override row in workspace papercusp-workspace).
  //
  // This is the ONLY genuine safety mis-default of the ten outstanding comment/DARK_FLAGS
  // mismatches. A per-flag re-derivation (su-00a91, 2026-07-12) found the other nine all
  // default-ON to a SAFER/NARROWER behavior — completed partition cutovers and workspace/
  // auth guard rails — so for those, "restoring the documented dark baseline" is a
  // REGRESSION, not a fix: COORD_PER_WORKSPACE and ISSUES_PER_WORKSPACE would have stranded
  // ~79k live rows (67,468 coord events + 11,730 issues, measured), and SCOPED_SUPERUSER_
  // CLAMP / UI_WORKSPACE_GUARD would have RELAXED auth enforcement. Their comments were the
  // stale side and are now corrected in types.ts. Only this one inverts the safety
  // direction (ON removes the last human check on the system widening its own ceilings),
  // so only this one is darkened. Watermark raised 25→26. Count 25 → 26.
  "papercusp-queen-full-autonomy",
  // 2026-07-12 (WI-4240) — papercusp-workspace-coordination was added here as the TENTH
  // EI-7230 instance (an UNVERIFIED workspace-brain re-key cutover held OFF by a hand-placed
  // operator_flag_overrides row); GRADUATED OUT 2026-08-02 (WI-605, workspace-scoped-
  // coordination-2026-06-20 D-019): owner-attended cutover — flipped ON live via the pg
  // override, brains verified re-keyed, default graduated. Count 27 → 26 relative to that
  // era's chain; the per-hive OFF path remains the kill-switch until post-graduation cleanup.
  // 2026-07-12 (WI-4240) — papercusp-authority-rpc-protomux + papercusp-authority-eviction-
  // probe: BUG-FIX correction, 11th + 12th instances of the EI-7230 class. Both comments
  // always said DEFAULT OFF / dark (real-hardware-UNVERIFIED cross-machine cutovers gated on
  // a two-machine proof), never actually added, so P-011 derived both live-ON. Byte-identical
  // on a single box (both no-op without a multi-machine transport) and consistent with the
  // sibling cross-machine flags already dark. Watermark raised 27→29. Count 27 → 29.
  "papercusp-authority-rpc-protomux",
  "papercusp-authority-eviction-probe",
  // 2026-07-20 (WI-5563, bug-drain-200k structural-starvation diagnosis) —
  // papercusp-replication-liveness-staleness-auto-close: DELIBERATE new dark flag, not
  // a bug-fix correction (case: owner-authority, same class as WATCHDOG_AUTO_CLOSE).
  // Gates a NEW sweep (replication-liveness-staleness-sweep.ts) that auto-resolves an
  // open replication-liveness EI whose target harness still EXISTS (unlike the
  // always-on replication-stall-orphan-sweep.ts, which only handles a renamed/deleted
  // target) but has recorded no activity for a long inactivity window — the "abandoned
  // demo/test harness" class. Autonomously resolving a durable escalation without a
  // human/agent verifying the specific item is unsafe by default; OFF is byte-identical
  // to today (escalate-only). Well under DARK_FLAGS_HIGH_WATERMARK (29) as an
  // owner-authority case (does not count toward the parking watermark). Count 28 → 29.
  "papercusp-replication-liveness-staleness-auto-close",
  // 2026-07-26 (shared-hive-cross-machine-scale-10k-2026-06-29 P-010, su-709bb) — THREE
  // BUG-FIX corrections of the identical never-added-to-DARK_FLAGS class as
  // WATCHDOG_AUTO_CLOSE / SUBSTRATE_SIDECAR / RECLAIM_STALLED / PSU_END_USER above, NOT new
  // darkenings. What is new is WHY they went undetected for so long: flag-comment-lint —
  // the guard built to catch exactly this class — only recognised the declaration written
  // as "DEFAULT OFF". All three of these declare themselves in the REVERSED, natural-English
  // form ("OFF (default)" / "When OFF (default)"), which matched no pattern, so each
  // classified as null and was SILENTLY SKIPPED rather than checked. Fixed at the source
  // (flag-comment-lint normalization step 5, which also folds in "defaults to OFF" and
  // "DEFAULT: OFF"); these three are what that recovered recall immediately surfaced.
  // Each is OFF ⇒ byte-identical-or-safer, and each had its live-ON state by ACCIDENT
  // (a missing entry), never by decision. All three are owner-authority/cutover cases, so
  // none counts toward the parking watermark. Count 29 → 32.
  //  · papercusp-improvement-auto-implement — autonomy escalation (auto-implements captured
  //    improvements via a spawned implementer agent + the release gate); its own comment sets
  //    an explicit unmet precondition ("flip ON only once the work_items surface + the
  //    release-gate cutover have landed"). OFF ⇒ the routine is a no-op; capture + triage
  //    are unaffected.
  //  · papercusp-lazy-substrate-boot — its own comment records an owner-ratified D-005/D-006
  //    BINDING constraint to stage on :3170 first, because a wrong eviction silently stops a
  //    harness syncing → fleet data divergence (the EI-126 102 GB class). OFF ⇒ eager
  //    all-harness boot + no reaper (the long-standing, definitively-safe behavior).
  //  · papercusp-capability-envelope-overrides — SECURITY surface; runtime per-role
  //    deny/allow overrides merged OVER the baked ROLE_ENVELOPES at dispatch. OFF ⇒ the
  //    sync-cache stays empty ⇒ byte-identical to the baked envelopes.
  "papercusp-improvement-auto-implement",
  "papercusp-lazy-substrate-boot",
  "papercusp-capability-envelope-overrides",
  // (papercusp-design-evidence-gate-enforcing was added here 2026-08-25 by P-007 and
  // REMOVED the same day by P-011, which is the graduation its own entry predicted.
  // Its stated precondition was D-006: calibrate before refusing. P-011 met it, and
  // then found the precondition was incomplete — D-021's same-host caveat was prose the
  // gate could not act on, and probing showed CaptureEnvironment cannot even EXPRESS
  // which machine a capture ran on, so a cross-host comparison was indistinguishable
  // from a same-host one at every precondition checked. D-023 closes that: enforcement
  // is scoped, in code, to references ratified on the machine the threshold was measured
  // on. The flag is now default-ON and the SCOPE — not the flag — is what withholds the
  // refusal everywhere the measurement does not reach. Count 36 → 35.)
  // (papercusp-task-manager was added here 2026-07-27 by WI-6499 and REMOVED 2026-08-02
  // by WI-6844 — it graduated to default-ON on an explicit owner directive: "we put it
  // behind a testing flag. Remove that flag, we'll make it part of our standard
  // release." Its dark entry predicted this ("expected to graduate quickly"), which is
  // the value of writing the graduation condition down at the time the entry is added.
  //
  // Removing it from THIS set is the correct action, not a weakening of the guard: the
  // snapshot exists to catch a SILENT flip, and a documented graduation is the one thing
  // it is not. The flag KEY still exists as a runtime kill-switch — a default-ON flag is
  // not a dark flag — so nothing here should reference it any more. Count 32 → 31,
  // parking subset + DARK_FLAGS_HIGH_WATERMARK both 14 → 13.)
  //
  // 2026-08-09 (WI-37561) — papercusp-conversations-rail-tab, on an EXPLICIT owner
  // directive: "Put the 'convos' tab in the middle pane behind a testing flag", with
  // hidden-until-flipped chosen over a visible kill-switch when the two were put to them
  // directly. This is the same sign-off path — and, word for word, nearly the same
  // sentence — that put papercusp-task-manager in this set two entries above; it is a
  // DECLARED darkening, which is precisely what this snapshot exists to distinguish from
  // a silent one. Count 31 → 32, parking subset + DARK_FLAGS_HIGH_WATERMARK both 13 → 14.
  //
  // It gates the 💬 Convos tab in the middle rail ONLY. /adv keeps its own Conversations
  // tab on the same four SSE-cached queries, so OFF hides a duplicate rather than
  // withdrawing a capability — the cheapest kind of park, and the reason no graduation
  // trade was sought for the watermark slot. Graduates on the owner's word that the tab
  // is part of the standard release; when it does, DELETE this entry (do not comment it
  // out as still-dark) and ratchet the watermark 14 → 13 in the same change.
  "papercusp-conversations-rail-tab",
  //
  // 2026-08-12 (retire-mug-kettle-su-only-2026-08-09 P-068 / D-098): the entry for
  // `papercusp-mug-kettle-system` was REMOVED from this snapshot, because the flag
  // itself was deleted from the registry. Count 33 → 32 → 31 as a REGISTRY DELETION,
  // not a graduation: nothing was flipped ON.
  //
  // Read that carefully, because it is the one case this snapshot's usual reasoning
  // gets backwards. Every other entry here is OFF meaning "not on yet", so removing
  // one means it shipped ON. This flag's polarity was INVERTED — OFF *was* the
  // delivered state (the Mug/Kettle/Cup tier retired) and ON was a reversible testing
  // escape hatch — so removing it means the opposite: the escape hatch is gone and the
  // retirement is permanent. The gates it fed did NOT go with it; `pot/started.ts`'s
  // `mugKettleSystemEnabled()` is now a hard `false` feeding the same ~20 call sites.
  //
  // Parking subset + DARK_FLAGS_HIGH_WATERMARK UNCHANGED at 14: it was `case: 'cutover'`
  // (a kill switch), and cutover/owner-authority entries were never rationed by the
  // parking budget — so removing it frees no slot and owes no trade.
  // The deletion is pinned by libs/flags/src/mug-kettle-cutover-flag.test.ts.
  //
  // 2026-08-20 (goal-live-holder-guarantee-2026-08-18 P-009 / D-002) —
  // papercusp-goal-holder-respawn: DELIBERATE new owner-authority dark flag.
  // The actor launches unattended GOAL-mode sessions and spends money, so it
  // stays independent of the report-only liveness watchdog and defaults OFF.
  // owner-authority does not consume a parking-watermark slot. Count 31 → 32.
  "papercusp-goal-holder-respawn",
  // 2026-08-22 (external-triggers-gmail-slack-2026-08-22 P-011) — deliberate
  // owner-authority dark flag for future automatic Gmail sending. Draft creation
  // ships independently and has no send branch. Owner-authority does not consume
  // a parking-watermark slot. Count 32 → 33.
  "papercusp-gmail-auto-send",
  // 2026-08-23 (social-platform-integrations-2026-08-23 P-006 / D-004(b)) —
  // deliberate owner-authority dark flag for create-shaped PUBLISHING to the
  // owner's real public social identity. It is a publish kill-switch, not a
  // hidden feature: social:post ships live and fully tested, runs both D-020
  // rails and returns the resolved account + audience echo with this OFF, and
  // social:reply (rail 1) is unaffected. Owner-authority does not consume a
  // parking-watermark slot. Count 33 → 34.
  "papercusp-social-auto-publish",
  // 2026-08-23 (work-on-everything-goal-2026-08-23 P-011) — the operator-boot
  // arm for STANDING goals (retirement doc open loss #3: cold-start autonomy
  // "should be a choice rather than a discovery" — this flag is that choice).
  // It spawns unattended GOAL-mode sessions at operator start, so the owner
  // personally arms it. Owner-authority does not consume a parking-watermark
  // slot. Count 34 → 35.
  "papercusp-standing-goal-boot-arm",
  // P-011 / directive #1489: shared tutorial credential issuance stays held.
  // Owner-authority security/spend flag; parking watermark is unchanged.
  "papercusp-tutorial-voice-issuance",
  // 2026-10-01 (stripe-subscription-signup-2026-10-01 P-005, WI-10004478) —
  // deliberate owner-authority dark flag: with it OFF the hosted billing runtime
  // refuses an sk_live_/rk_live_ key (`live_mode_not_allowed`), so no composition
  // can charge real cards until the owner arms it. Test-mode signup ships live
  // and fully tested with this OFF. Owner-authority does not consume a
  // parking-watermark slot. Count 35 → 36.
  "papercusp-hosted-billing-live-mode",
  // 2026-10-06 (slack-messages-to-bug-reports-2026-10-05 P-001) — papercusp-slack-org-connector
  // LEFT this set: its legal-read gate is on record (enterprise-data-sources-2026-10-01
  // D-029) and the owner approved switching it on (directive #1417).
]);

// DARK_FLAGS_REVIEW_BY (the re-review deadline) and DARK_FLAGS_HIGH_WATERMARK (the
// size ceiling) are now PROMOTED into shippable code (libs/flags/src/types.ts) so the
// operator dark-flag-age watchdog (P-013) reasons over the same numbers this guard
// asserts against. Imported above; the assertions below are unchanged. The review-by is
// still the "expiry" that stops a dark flag lingering silently — past it the test below
// goes red; treat that as "do the review," not "bump the date" (the bump is the LAST step).

describe("production flag defaults (CLAUDE.md: new flags DEFAULT TO ENABLED)", () => {
  it("every flag defaults ON unless consciously registered in DARK_FLAGS", () => {
    // With the P-011 inversion FLAG_DEFAULTS is DERIVED (`!DARK_FLAGS.has(key)`),
    // so this holds by construction — but the assert documents the contract and
    // catches any future hand-edit that re-introduces a default-OFF literal.
    const offenders = ALL_FLAG_KEYS.filter(
      (key) => FLAG_DEFAULTS[key] === false && !DARK_FLAGS.has(key),
    );
    expect(
      offenders,
      `New flags DEFAULT TO ENABLED — finished work never ships dark (CLAUDE.md "Feature flags + PostHog"). ` +
        `These flags resolve to false without being in DARK_FLAGS: [${offenders.join(", ")}]. ` +
        `Either ship the flag enabled (the default — add nothing) or — only for genuinely ` +
        `incomplete/unsafe work — consciously add it to DARK_FLAGS in libs/flags/src/types.ts ` +
        `with a case + reason, and surface the pending flip in the plan's "## Now" + your report.`,
    ).toEqual([]);
  });

  it("DARK_FLAGS covers EXACTLY the default-OFF set (reason guaranteed by construction)", () => {
    // Both directions: every default-OFF flag is registered (has a reason), and
    // every registered dark flag actually defaults false (no stale entry that has
    // since flipped ON). Replaces the old separate "allowlist not stale" guard.
    const defaultOff = ALL_FLAG_KEYS.filter(
      (key) => FLAG_DEFAULTS[key] === false,
    ).sort();
    const registered = [...DARK_FLAGS.keys()].sort();
    expect(
      defaultOff,
      "the derived default-OFF set must equal DARK_FLAGS exactly",
    ).toEqual(registered);
  });

  it("every DARK_FLAGS entry is a real registered flag key with a valid case + reason", () => {
    const known = new Set<string>(ALL_FLAG_KEYS);
    for (const [key, info] of DARK_FLAGS) {
      expect(
        known.has(key),
        `DARK_FLAGS contains unregistered key "${key}"`,
      ).toBe(true);
      // The DarkCase TYPE already rejects an invalid reason at compile time; this is
      // belt-and-suspenders for the runtime shape. There is deliberately NO "finished,
      // owner flips after verifying" case — finished + tested ⇒ ship ON (flip in-task).
      expect(
        VALID_DARK_CASES.has(info.case),
        `DARK_FLAGS["${key}"] has invalid case "${info.case}"`,
      ).toBe(true);
      expect(
        info.reason.trim().length,
        `DARK_FLAGS["${key}"] needs a non-empty reason`,
      ).toBeGreaterThan(0);
    }
  });

  it("the PARKING (parked+incomplete) dark subset is not past its review-by date (no silent lingering) — HARD GATE", () => {
    // EI-19941703547241191: this used to be ONE date gating ALL 4 DarkCase populations,
    // so a red here could be caused entirely by owner-authority/cutover entries an agent
    // is not permitted to graduate — training "just bump the date" for a backlog no
    // agent could ever clear. Scoped to the agent-actionable parked/incomplete subset
    // only; DARK_FLAGS_OWNER_REVIEW_BY (below) governs the rest, advisory-only.
    const reviewBy = Date.parse(DARK_FLAGS_PARKING_REVIEW_BY);
    expect(
      Number.isNaN(reviewBy),
      "DARK_FLAGS_PARKING_REVIEW_BY must be a valid ISO date",
    ).toBe(false);
    expect(
      Date.now() <= reviewBy,
      `The DARK_FLAGS parked/incomplete subset is past its review-by (${DARK_FLAGS_PARKING_REVIEW_BY}). ` +
        `Walk every parked/incomplete dark flag in libs/flags/src/types.ts: flip the ones now ready to ` +
        `default-ON (remove them from DARK_FLAGS), then push DARK_FLAGS_PARKING_REVIEW_BY out with a fresh ` +
        `look. Don't just bump the date — the review is the point.`,
    ).toBe(true);
  });

  it("the OWNER (owner-authority+cutover) dark subset has a valid review-by date, but its expiry is ADVISORY ONLY — never gates this suite", () => {
    // The mirror image of the hard gate above: owner-authority/cutover entries are not
    // agent-graduatable BY DEFINITION, so their staleness must fail LOUD if the date
    // itself is malformed (a broken constant is always a bug), but must NEVER fail this
    // suite merely for being past due — that population surfaces via the existing
    // owner-attention path instead (darkFlagRatificationToAttention, wired with
    // reviewBy in agent-tools/plans/attention.ts). Deliberately no `Date.now()`
    // comparison against this suite's pass/fail below — that absence IS the guarantee
    // "owner expiry does not red" describes; if a future edit adds one, it reintroduces
    // exactly the bug this split fixed.
    const reviewBy = Date.parse(DARK_FLAGS_OWNER_REVIEW_BY);
    expect(
      Number.isNaN(reviewBy),
      "DARK_FLAGS_OWNER_REVIEW_BY must be a valid ISO date (malformed evidence must fail loud even though it is advisory)",
    ).toBe(false);
  });

  it("every DARK_FLAGS entry belongs to EXACTLY ONE review lane (parking XOR owner, no gaps)", () => {
    // Belt-and-suspenders over the 4-value DarkCase union the type system already
    // exhausts (darkFlagReviewLane throws on anything outside the two known sets) —
    // pins that the runtime partition used by the two review-by clocks above never
    // silently drifts from DARK_FLAGS_PARKING_CASES / DARK_FLAGS_OWNER_CASES.
    let parkingLaneCount = 0;
    let ownerLaneCount = 0;
    for (const [key, entry] of DARK_FLAGS) {
      const lane = darkFlagReviewLane(entry.case);
      expect(["parking", "owner"]).toContain(lane);
      if (lane === "parking") {
        expect(DARK_FLAGS_PARKING_CASES.has(entry.case), `${key}: parking lane must match DARK_FLAGS_PARKING_CASES`).toBe(true);
        parkingLaneCount++;
      } else {
        expect(DARK_FLAGS_OWNER_CASES.has(entry.case), `${key}: owner lane must match DARK_FLAGS_OWNER_CASES`).toBe(true);
        ownerLaneCount++;
      }
    }
    expect(parkingLaneCount).toBe(DARK_FLAGS_PARKING_COUNT);
    expect(ownerLaneCount).toBe(DARK_FLAGS.size - DARK_FLAGS_PARKING_COUNT);
    // Malformed case fails loud rather than silently picking a lane.
    expect(() => darkFlagReviewLane("not-a-real-case" as DarkCase)).toThrow();
  });

  it("the dark allowlist only ever SHRINKS — agents may not reconstruct it (owner mandate 2026-06-23)", () => {
    // ANTI-RECONSTRUCTION GUARD (owner-directed, plan flip-dark-flags-default-on-2026-06-23): the
    // allowlist was being abused as a PARKING LOT — finished work left default-OFF "to be safe"
    // because flipping it on made agents uncomfortable. After the owner's flags-default-ON sweep the
    // dark set stands at the high-watermark below and may ONLY SHRINK. Adding a new dark flag FAILS
    // here: ship finished work default-ON, or — for genuinely incomplete/unsafe NEW work — graduate
    // an existing dark flag first (net-zero), or get EXPLICIT owner sign-off to raise the watermark.
    // Growth must be a deliberate, owner-visible act, never a quiet append.
    // (DARK_FLAGS_HIGH_WATERMARK now lives in libs/flags/src/types.ts — imported above.)
    const parkingCount = [...DARK_FLAGS.values()].filter((entry) =>
      DARK_FLAGS_PARKING_CASES.has(entry.case),
    ).length;
    expect(
      parkingCount,
      "the runtime parking count must match its exported source-of-truth count",
    ).toBe(DARK_FLAGS_PARKING_COUNT);
    expect(
      parkingCount <= DARK_FLAGS_HIGH_WATERMARK,
      `The parked/incomplete dark subset GREW to ${parkingCount} (parking watermark ${DARK_FLAGS_HIGH_WATERMARK}); ` +
        `Do NOT reconstruct the parking lot: ship finished work default-ON, or graduate an existing ` +
        `parked/incomplete dark flag to make room. Raising DARK_FLAGS_HIGH_WATERMARK needs explicit owner sign-off.`,
    ).toBe(true);
  });

  it("does not ration owner-authority/cutover safety flags with the parking watermark", () => {
    const parkingCount = [...DARK_FLAGS.values()].filter((entry) =>
      DARK_FLAGS_PARKING_CASES.has(entry.case),
    ).length;
    const governedCount = DARK_FLAGS.size - parkingCount;
    expect(governedCount).toBeGreaterThan(0);
    expect(DARK_FLAGS.size).toBeGreaterThan(DARK_FLAGS_HIGH_WATERMARK);
    expect(parkingCount).toBeLessThanOrEqual(DARK_FLAGS_HIGH_WATERMARK);
  });

  it("VALUE-PRESERVING: the derived FLAG_DEFAULTS matches the pre-inversion snapshot for EVERY flag", () => {
    // The P-011 inversion MUST NOT silently flip any flag. For every registered FlagKey, the
    // derived default must equal the pre-inversion value (false iff in the captured snapshot).
    const mismatches: string[] = [];
    for (const key of ALL_FLAG_KEYS) {
      const expected = !PRE_INVERSION_DEFAULT_OFF.has(key);
      if (FLAG_DEFAULTS[key] !== expected) {
        mismatches.push(`${key}: was ${expected} now ${FLAG_DEFAULTS[key]}`);
      }
    }
    expect(
      mismatches,
      `FLAG-DEFAULT INVERSION changed an effective default — it must be strictly value-preserving: ` +
        `[${mismatches.join("; ")}]`,
    ).toEqual([]);

    // And the snapshot itself must reference only real flags (no stale literal that drifted out of FLAGS).
    const known = new Set<string>(ALL_FLAG_KEYS);
    const orphanSnapshot = [...PRE_INVERSION_DEFAULT_OFF].filter(
      (k) => !known.has(k),
    );
    expect(
      orphanSnapshot,
      `PRE_INVERSION_DEFAULT_OFF references unregistered flag(s)`,
    ).toEqual([]);
  });

  // 2026-07-26 (P-010, su-709bb) — improvement-auto-implement + lazy-substrate-boot +
  // capability-envelope-overrides: three BUG-FIX corrections surfaced by the
  // flag-comment-lint recall fix (the guard could not see the reversed "OFF (default)"
  // declaration form), not new darkenings. All owner-authority/cutover ⇒ no parking-watermark
  // impact. See the block at the end of PRE_INVERSION_DEFAULT_OFF above. Count 29 → 32.
  it("the default-OFF COUNT matches the snapshot (9 pre-inversion + deliberate additions)", () => {
    const offCount = ALL_FLAG_KEYS.filter(
      (k) => FLAG_DEFAULTS[k] === false,
    ).length;
    expect(offCount).toBe(PRE_INVERSION_DEFAULT_OFF.size);
    // 9 pre-inversion + papercusp-accept-delegated-seats (2026-07-03,
    // agent-allocation-framework P-008 owner-authority trust gate).
    // Graduated to default-ON and removed from the snapshot: papercusp-queen-warm-session
    // (2026-07-02, owner flip directive), papercusp-per-hive-release-gate (2026-07-03, D-008 met),
    // papercusp-presence-gossip (2026-07-16, LIVE-1 P-059 2-machine verify met the cutover gate),
    // and papercusp-codex-gateway-oauth-proxy (2026-08-27, WI-272118 owner-directed
    // production Luna tool-turn canary).
    // 2026-07-04 — papercusp-onboarding-preview-features (deterministic-onboarding-tutorial
    // P-001, owner-directed): gates not-ready tutorial items. Count 11 → 12.
    // 2026-07-04 — papercusp-the-hive flips default-OFF (restore-pot-lexicon-public-release,
    // owner-directed): public ships the Pot lexicon; Swarm skin is TESTING-gated. Count 12 → 13.
    // 2026-07-04 (EI-7230) — papercusp-watchdog-auto-close: BUG-FIX correction, not a new
    // darkening (see the PRE_INVERSION_DEFAULT_OFF comment above). Count 13 → 14.
    // 2026-07-04 (EI-7280) — papercusp-test-completion-gate GRADUATED to default-ON
    // (dark-flag-age review): verified live+enabled, zero blast radius. Count 14 → 13.
    // 2026-07-05 (WI-1994) — papercusp-substrate-sidecar: BUG-FIX correction (own comment
    // always said dark, never actually added — see PRE_INVERSION_DEFAULT_OFF above), not a
    // new darkening. Count 13 → 14.
    // 2026-07-05 (EI-7685) — papercusp-reclaim-stalled: same BUG-FIX correction class (own
    // comment always said dark, never actually added — see PRE_INVERSION_DEFAULT_OFF above),
    // not a new darkening. Count 14 → 15.
    // 2026-07-05 (WI-3093) — papercusp-psu-end-user: same BUG-FIX correction class, FOURTH
    // instance (own comment always said dark — legitimate owner-authority/SECURITY case, the
    // owner must ratify end-user psu shell exposure — never actually added — see
    // PRE_INVERSION_DEFAULT_OFF above), not a new darkening. Count 15 → 16.
    // 2026-07-07 — papercusp-templates-marketplace: DELIBERATE new dark flag (case:
    // parked, owner-directed v1/v2 split — local-first-party-template-bundling). The
    // v2 Cupboard marketplace merge is wired but dormant in v1. Count 16 → 17.
    // 2026-07-07 — papercusp-rubrics-marketplace: the rubrics sibling of the same
    // owner-directed v1/v2 split (local-first-party-rubric-bundling): v1 bundles +
    // seeds first-party rubrics locally; the kind='rubric' Cupboard marketplace is a
    // reserved v2 seam (no remote-fetch code yet). Count 17 → 18.
    // 2026-07-09 — papercusp-own-log-fork-auto-recovery (p2p-parity-parallel-lanes-2026-07-09
    // P-003 / WI-3535, owner-authority): DELIBERATE new dark flag — the own-log-fork-guard's
    // sketched auto-recovery is destructive (per-harness Corestore store reset, discards
    // unmerged local history), so it ships default-OFF until the owner ratifies it. Count 18 → 19.
    // 2026-07-10 (WI-1491) — papercusp-hrw-rendezvous-authority (cross-machine-coord-parity-
    // and-trust-2026-07-01 P-021 live cutover): DELIBERATE new dark flag (case: cutover) —
    // flips lockAuthorityFor/lockAuthorityForHive's winner rule from global argmin to per-
    // scope HRW rendezvous hashing; every peer must agree on the flag value or they compute
    // different authorities for the same scope, so it ships dark until an attended multi-peer
    // verify. Count 19 → 20.
    // 2026-07-10 (EI-9064 dark-flag-age sweep) — papercusp-plan-part-federation: BUG-FIX
    // correction, not a new darkening (own comment always said dark, never actually added —
    // see PRE_INVERSION_DEFAULT_OFF above). FIFTH instance of the EI-7230-class bug. Count 20 → 21.
    // 2026-07-10 (WI-3370) — papercusp-substrate-log-snapshot: BUG-FIX correction (own
    // comment always said dark, never actually added — see PRE_INVERSION_DEFAULT_OFF
    // above), SIXTH instance of the EI-7230-class bug; split off a new default-ON reader
    // sibling flag (papercusp-substrate-log-snapshot-reader, not in this count) so the
    // producer alone goes dark. Count 21 → 22 — AT DARK_FLAGS_HIGH_WATERMARK (22).
    // 2026-07-10 (WI-3796) — papercusp-git-sync-derived-attribution +
    // papercusp-doc-steward: BUG-FIX correction, SEVENTH + EIGHTH instances of the
    // EI-7230-class bug (own comments always said dark, never actually added — see
    // PRE_INVERSION_DEFAULT_OFF above). Breached the prior watermark of 22 with zero
    // graduation candidates ready, so DARK_FLAGS_HIGH_WATERMARK was raised 22→24 (see
    // types.ts's 2026-07-10 watermark-raise note). Count 22 → 24.
    // 2026-07-10 — papercusp-mem0-federation-egress (mem0-cross-machine-federation-2026-07-10,
    // owner-authority): DELIBERATE new dark flag, not a bug-fix correction — memory
    // federation is an owner-ratified privacy surface. Breached the watermark of 24 with
    // zero graduation candidates ready, so DARK_FLAGS_HIGH_WATERMARK was raised 24→25 (see
    // types.ts's watermark constant comment). Count 24 → 25.
    // 2026-07-12 (WI-4238) — papercusp-queen-full-autonomy: BUG-FIX correction, NINTH
    // instance of the EI-7230-class bug (own comment always said dark, never actually added
    // — see PRE_INVERSION_DEFAULT_OFF above). The ONE genuine safety mis-default among the
    // ten outstanding mismatches; the other nine default-ON to the SAFER direction and had
    // their stale comments corrected instead (see types.ts). Breached the watermark of 25,
    // so DARK_FLAGS_HIGH_WATERMARK was raised 25→26. Count 25 → 26.
    // 2026-07-12 (WI-4240) — papercusp-workspace-coordination: BUG-FIX correction, TENTH
    // instance of the EI-7230 class (own comment always said dark, never actually added). The
    // genuine dark case among the WI-4240 residue (an unverified cutover held OFF in prod only
    // by a hand-placed override row); its sibling INBOX_DURABLE_ESCALATIONS was ratified ON
    // instead (finished additive work). Watermark raised 26→27. Count 26 → 27.
    // 2026-07-12 (WI-4240) — papercusp-authority-rpc-protomux + papercusp-authority-eviction-
    // probe: BUG-FIX correction, 11th + 12th instances of the EI-7230 class (both comments said
    // dark, never added; real-hardware-unverified cross-machine cutovers, no-op on a single
    // box). Watermark raised 27→29. Count 27 → 29.
    // 2026-07-15 — papercusp-gateway-maintenance-carry graduated default-ON by
    // explicit owner direction. Count 31 → 30.
    // 2026-07-16 — papercusp-presence-gossip graduated default-ON: LIVE-1 P-059
    // tower↔VM 2-machine verify met the cutover dark-entry gate. Count 30 → 29.
    // 2026-07-17 — papercusp-hrw-rendezvous-authority graduated default-ON: the
    // same LIVE-1 P-059 drill's multi-peer same-inputs verify met its cutover
    // dark-entry gate; flag flipped ON in both machines' stores. Count 29 → 28.
    // 2026-07-18 — papercusp-plan-part-federation graduated default-ON: WI-5331
    // Leg B two-machine merge proof (tower↔Avis-iMac concurrent different-part
    // edits, flag ON both stores, byte-identical convergence, no clobber) met its
    // cutover dark-entry gate (p2p-part-merge-proof-2026-07-18 D-001). Count 28 → 27.
    // 2026-07-19 (EI-16635) — papercusp-capability-exec-sandbox: BUG-FIX correction,
    // EI-7230-class (see PRE_INVERSION_DEFAULT_OFF above). Count 27 → 28.
    // 2026-07-20 (WI-5563) — papercusp-replication-liveness-staleness-auto-close:
    // DELIBERATE new owner-authority dark flag (see PRE_INVERSION_DEFAULT_OFF above).
    // Count 28 → 29.
    // 2026-07-26 (shared-hive-cross-machine-scale-10k-2026-06-29 P-010) — THREE BUG-FIX
    // corrections, EI-7230-class, surfaced by the flag-comment-lint recall fix: the guard
    // only recognised "DEFAULT OFF", so every flag declaring itself in the reversed
    // "OFF (default)" form was silently skipped instead of checked. All three are
    // owner-authority/cutover (no parking-watermark impact) and OFF is
    // byte-identical-or-safer for each: papercusp-improvement-auto-implement,
    // papercusp-lazy-substrate-boot, papercusp-capability-envelope-overrides.
    // See PRE_INVERSION_DEFAULT_OFF above for the per-flag reasoning. Count 29 → 32.
    // 2026-07-27 (WI-6499) — papercusp-task-manager: DELIBERATE reversal on an explicit
    // owner directive the same day it shipped default-ON ("put the task manager behind a
    // testing flag it isn't ready yet"). case: incomplete, so the parking subset and the
    // watermark both move 13 → 14. Count 32 → 33.
    // 2026-08-02 (WI-605) — papercusp-workspace-coordination GRADUATED to default-ON at the
    // owner-attended cutover (workspace-scoped-coordination-2026-06-20 D-019): build verified
    // complete (D-010), flipped live via the pg override, brains re-key verified. case was
    // 'cutover' — no watermark impact. Count 33 → 32.
    // 2026-08-02 (WI-6844) — papercusp-task-manager GRADUATED to default-ON on an explicit
    // owner directive ("we put it behind a testing flag. Remove that flag, we'll make it
    // part of our standard release"), six days after WI-6499 darkened it. case was
    // 'incomplete', so this one DOES move the parking subset: 14 → 13, and
    // DARK_FLAGS_HIGH_WATERMARK was lowered 14 → 13 with it rather than left as headroom
    // (a ceiling only ratchets if a graduation spends the slot it frees). Count 32 → 31.
    // 2026-08-09 (WI-37561) — papercusp-conversations-rail-tab: DELIBERATE darkening on an
    // explicit owner directive ("put the 'convos' tab in the middle pane behind a testing
    // flag"), the owner choosing hidden-until-flipped over a visible kill-switch. case:
    // parked, so the parking subset and DARK_FLAGS_HIGH_WATERMARK both move 13 → 14.
    // Count 31 → 32. It parks the rail TAB only — /adv keeps the same conversations on the
    // same queries — which is why the slot was bought with a raise rather than a trade.
    // 2026-08-09 (retire-mug-kettle-su-only-2026-08-09 P-006) — papercusp-mug-kettle-system:
    // DELIBERATE darkening on an explicit owner directive ("the rest of the cup/mug/kettle
    // system should be retired"). case: 'cutover', so NO parking-subset or watermark impact
    // (both stay 14) and no graduation trade was owed. Count 32 → 33.
    // ⚠ INVERTED POLARITY — unlike every other entry in this ledger, OFF is the DELIVERED
    // state (the tier retired; su + GOAL mode the only way to drive the app) and ON is the
    // testing escape hatch. It graduates by being DELETED once D-004's Stage 2/3 land, never
    // by being flipped on; treating it as ordinary parked work and "graduating" it would
    // silently un-retire the tier. Pinned by libs/flags/src/mug-kettle-cutover-flag.test.ts.
    // 2026-08-10 (WI-37718) — papercusp-git-sync-derived-attribution GRADUATED to default-ON
    // on an explicit owner directive, after the end-to-end review its owner-authority entry
    // demanded: the writer-side defect that made derived attribution resolve a placeholder
    // holder (EI-20055604348536487, fixed in b2af0024a8) is live on every writer path, and
    // once the last pre-fix process cycled, 39/39 consecutive lock rows carried a real
    // declared intent with zero sentinels while the last 60 commits carried real per-agent
    // subjects with zero sentinel subjects. case was 'owner-authority', so NO parking-subset
    // or watermark impact (both stay 14) and no graduation trade was owed. Count 33 → 32.
    // 2026-08-12 (retire-mug-kettle-su-only-2026-08-09 P-068 / D-098) —
    // papercusp-mug-kettle-system left this ledger by DELETION, not graduation: the flag
    // was removed from the registry entirely. Do not read the decrement the usual way. For
    // every other entry, leaving the dark set means the feature shipped ON; this one had
    // INVERTED polarity, so its removal means the retirement it delivered is now PERMANENT
    // and the testing escape hatch is gone. The gates did not go with it —
    // pot/started.ts's mugKettleSystemEnabled() is a hard `false` feeding the same ~20 call
    // sites. case was 'cutover', so NO parking-subset or watermark impact (both stay 14)
    // and no graduation trade was owed. Count 32 → 31.
    // Pinned by libs/flags/src/mug-kettle-cutover-flag.test.ts, which now guards the
    // DELETION (the flag must not come back) rather than the polarity.
    // 2026-08-20 — P-009's independently gated unattended holder recovery.
    // case: owner-authority, so the parking subset/watermark remain 14.
    // Count 31 → 32.
    // 2026-08-23 (social-platform-integrations-2026-08-23 P-006 / D-004(b)) —
    // papercusp-social-auto-publish, the publish kill-switch for create-shaped
    // posting to the owner's real public social identity. case:
    // 'owner-authority', so the parking subset and DARK_FLAGS_HIGH_WATERMARK
    // both stay 14 and no graduation trade is owed. Count 33 → 34.
    // 2026-08-23 (work-on-everything-goal-2026-08-23 P-011) —
    // papercusp-standing-goal-boot-arm, the owner-armed operator-boot holder
    // respawn for standing goals. case: 'owner-authority', so the parking
    // subset and DARK_FLAGS_HIGH_WATERMARK both stay 14. Count 34 → 35.
    // 2026-08-25 (ratified-mockup-implementation-validation-2026-08-24 P-011) —
    // papercusp-design-evidence-gate-enforcing GRADUATED on the day it was added, which
    // is what its `cutover` entry existed to schedule. It is default-ON; what withholds
    // the refusal now is D-023's measured scope (enforce only where the threshold was
    // measured), which is a property of the evidence rather than a flag anyone can
    // forget to flip. The parking subset and DARK_FLAGS_HIGH_WATERMARK both stay 14.
    // Count 36 → 35.
    // 2026-08-27 (WI-272118) — papercusp-codex-gateway-oauth-proxy GRADUATED
    // after the owner-directed production Luna tool-turn canary satisfied the
    // entry's exact live gate. Count 35 → 34; incomplete parking subset and its
    // watermark both ratchet 14 → 13.
    // 2026-09-04 (EI-19360358881224651) — GRADUATION_TRACKER restored to its
    // documented owner-authority dark default. Count 34 → 35; parking subset and
    // DARK_FLAGS_HIGH_WATERMARK remain unchanged.
    // 2026-09-24 (p2p-join-catchup-speed-2026-09-23 P-005) — papercusp-substrate-log-snapshot
    // GRADUATED to default-ON (the snapshot producer; cross-machine catch-up proof met by
    // P-003/P-004/P-008). case was 'incomplete', so the parking subset and
    // DARK_FLAGS_HIGH_WATERMARK both ratchet 13 → 12. Count 35 → 34.
    // 2026-10-01 (stripe-subscription-signup-2026-10-01 P-005, WI-10004478) —
    // papercusp-hosted-billing-live-mode, the live-key refusal for hosted
    // subscription billing (test mode ships live with it OFF). case:
    // 'owner-authority', so the parking subset and DARK_FLAGS_HIGH_WATERMARK both
    // stay 12. Count 34 → 35.
    // 2026-10-02 (enterprise-data-sources-2026-10-01 P-016, WI-10005052) —
    // papercusp-slack-org-connector, the gate on the customer-owned Slack
    // organization connector, held dark until a legal read of Slack's 2025 API
    // terms is on record. case: 'owner-authority', so the parking subset and
    // DARK_FLAGS_HIGH_WATERMARK both stay 12. Count 35 → 36.
    // 2026-10-06 (slack-messages-to-bug-reports-2026-10-05 P-001) —
    // papercusp-slack-org-connector GRADUATED to default-ON: the legal read is on record
    // (enterprise-data-sources-2026-10-01 D-029) and the owner approved it (#1417).
    // case was 'owner-authority', so the parking subset and DARK_FLAGS_HIGH_WATERMARK
    // both stay 12. Count 36 → 35.
    expect(offCount).toBe(36);
  });

  it("sanity: the four cut-for-V1 flags + key owner-authority security flags are still dark", () => {
    // A coarse human-readable cross-check on top of the snapshot equality above.
    for (const key of [
      FLAGS.CLOUDFLARE_PUBLISH,
      FLAGS.HARNESS_PHASES,
      FLAGS.DESIGN,
      FLAGS.TESTING,
    ]) {
      expect(DARK_FLAGS.get(key)?.case).toBe("parked");
      expect(FLAG_DEFAULTS[key]).toBe(false);
    }
    expect(DARK_FLAGS.get(FLAGS.OPEN_SIGNUP)?.case).toBe("owner-authority");
    expect(DARK_FLAGS.get(FLAGS.AUTH_CONFIG_OVERRIDES)?.case).toBe(
      "owner-authority",
    );
    expect(DARK_FLAGS.get(FLAGS.GMAIL_AUTO_SEND)?.case).toBe("owner-authority");
    expect(FLAG_DEFAULTS[FLAGS.GMAIL_AUTO_SEND]).toBe(false);
    // WI-3093: psu end-user exposure (a full superuser agent shell) is the highest-stakes
    // owner-authority entry in the set — pin it explicitly so a future edit can't silently
    // re-flip it to default-ON the way the P-011 inversion originally did.
    expect(DARK_FLAGS.get(FLAGS.PSU_END_USER)?.case).toBe("owner-authority");
    expect(FLAG_DEFAULTS[FLAGS.PSU_END_USER]).toBe(false);
    // EI-19360358881224651: a loop that files owner-facing graduation reports must
    // not silently derive default-ON before its lane-specific arming decision.
    expect(DARK_FLAGS.get(FLAGS.GRADUATION_TRACKER)?.case).toBe("owner-authority");
    expect(FLAG_DEFAULTS[FLAGS.GRADUATION_TRACKER]).toBe(false);
  });

  it("plan completion audit guards ship default-ON and are never dark", () => {
    for (const key of [
      FLAGS.PLAN_CODE_AUDIT_GATE,
      FLAGS.PLAN_ITEM_COMPLETION_GATE,
    ]) {
      expect(
        FLAG_DEFAULTS[key],
        `${key} must enforce plan completion by default`,
      ).toBe(true);
      expect(
        DARK_FLAGS.has(key),
        `${key} must not be registered as a dark flag`,
      ).toBe(false);
    }
  });

  // git-sync-turn-scoped-commit-hold-2026-10-11 (acceptance bar R-5): the turn hold
  // ships ON and its flag is the kill-switch. The git-sync action test mocks getFlag,
  // so it cannot see the real default; this pins it at the source.
  it("GIT_SYNC_TURN_HOLD ships default-ON and is never dark (git-sync turn hold R-5)", () => {
    const key = FLAGS.GIT_SYNC_TURN_HOLD;
    expect(
      FLAG_DEFAULTS[key],
      `${key} must default ON: git-sync holds a live session's mid-turn edits by default`,
    ).toBe(true);
    expect(
      DARK_FLAGS.has(key),
      `${key} must not be registered as a dark flag — it is a kill-switch, not a parked feature`,
    ).toBe(false);
  });

  it("P2P + GITHUB_BRIDGE ship default-ON with STRUCTURAL inertness (FS-D5) — never dark", () => {
    // p2p-work-distribution-2026-07-02 P-005 / FS-D5 (plan decision D-019): the P2P
    // work-sharing surface follows the landed GITHUB_BRIDGE pattern — the flag is the
    // FLEET-WIDE kill-switch (default-ON), and activation is the REAL surface (explicit
    // P-001 grants + host opt-in, zero/empty by default per M11). Inertness is STRUCTURAL,
    // so NEITHER flag may carry a DARK_FLAGS entry. This pins the rollout decision against
    // a future "let me dark-ship P2P to be safe" edit — which FS-D5 explicitly forbids
    // (a dark entry would also trip the shrink-only high-watermark guard above).
    for (const key of [FLAGS.P2P, FLAGS.GITHUB_BRIDGE]) {
      expect(
        FLAG_DEFAULTS[key],
        `${key} must default ON (fleet kill-switch, not dark)`,
      ).toBe(true);
      expect(
        DARK_FLAGS.has(key),
        `${key} must NOT be in DARK_FLAGS — inertness is structural (FS-D5)`,
      ).toBe(false);
    }
  });

  // ── WI-1105109 — freeze-and-converge is the STANDARD main-greening procedure ──
  //
  // [owner 2026-08-30T07:22Z, OWNER-interactive] "How can we make sure another
  // agent uses the frozen candidate system next and doesn't retire it like you did.
  // This should be our standard main greening procedure."
  //
  // The mechanism (P-013 / D-007, converge-frozen-candidate-by-fix-only-admission-
  // 2026-08-27) is already correct and already default-ON. What was missing is
  // anything that stops it being quietly turned OFF — and this flag's own comment in
  // types.ts states the consequence precisely: turning it off "restores the pre-D-001
  // re-cut-at-tip stream — the treadmill D-007 diagnosed, where each new cut re-admits
  // the whole sweep and imports breakage faster than fixes land." On a tree where ~100
  // agents commit continuously that is not a degraded mode, it is a gate that stops
  // converging at all. So the default is load-bearing and gets a guard.
  //
  // Verified 2026-09-01: BEFORE this test, `grep -rl RELEASE_FREEZE_AND_CONVERGE_DEFAULT
  // --include=*.test.ts` matched 0 files, while the same grep for DARK_FLAGS matched 48
  // — i.e. the absence was real, not a broken search.
  it("RELEASE_FREEZE_AND_CONVERGE_DEFAULT stays default-ON and never goes dark (WI-1105109)", () => {
    const key = FLAGS.RELEASE_FREEZE_AND_CONVERGE_DEFAULT;

    expect(
      FLAG_DEFAULTS[key],
      "freeze-and-converge is the standard main-greening procedure — default-OFF " +
        "restores the re-cut-at-tip treadmill (D-007)",
    ).toBe(true);
    expect(
      DARK_FLAGS.has(key),
      `${key} must NOT be in DARK_FLAGS — it is the already-deployed behaviour`,
    ).toBe(false);

    // INDEPENDENT PIN, deliberately a raw string literal — the same device as
    // PRE_INVERSION_DEFAULT_OFF above. Reading the default only through the FLAGS
    // constant would keep passing if the flag were RENAMED, because the guard would
    // silently follow the rename and re-assert the property about a different key.
    // Pinning the wire value makes a rename fail HERE, where the reason is written
    // down, instead of somewhere downstream at gate time.
    const WIRE_KEY = "papercusp-release-freeze-and-converge-default";
    expect(
      (ALL_FLAG_KEYS as readonly string[]).includes(WIRE_KEY),
      `the freeze-and-converge flag must keep the wire key '${WIRE_KEY}' — a rename ` +
        "silently detaches every override and re-cut guard that names it",
    ).toBe(true);
    expect(key as string).toBe(WIRE_KEY);
    expect(
      FLAG_DEFAULTS[WIRE_KEY as keyof typeof FLAG_DEFAULTS],
      "resolved through the wire literal, independently of the FLAGS constant",
    ).toBe(true);

    // FALSIFIABILITY CONTROL. Every assertion above is `toBe(true)`, so if the
    // derivation were broken in the direction that matters — FLAG_DEFAULTS resolving
    // truthy for everything — they would ALL still pass and this guard would be
    // decorative. A known default-OFF flag proves the same lookup can still return
    // false, so a green here means the mechanism discriminated rather than agreed.
    expect(
      FLAG_DEFAULTS[FLAGS.GMAIL_AUTO_SEND],
      "control: a known owner-authority dark flag must still resolve default-OFF — " +
        "if this flips true, FLAG_DEFAULTS is broken and the assertions above are vacuous",
    ).toBe(false);
  });

  // progress-certified-release-trace-2026-09-05 P-005 / D-015. Same device as the guard
  // above, for the same reason and against the opposite failure: this flag is a REVERT
  // switch for a carried threshold judgement, so the danger is not that someone turns it
  // off — that is what it is for — but that it ships or drifts default-OFF and the
  // certificate never steers anything, leaving the whole plan's work inert while every
  // test still passes. Default-ON is the property the plan actually delivered.
  it("RELEASE_TRACE_PROGRESS_CERTIFICATE stays default-ON and never goes dark (P-005)", () => {
    const key = FLAGS.RELEASE_TRACE_PROGRESS_CERTIFICATE;

    expect(
      FLAG_DEFAULTS[key],
      "the progress certificate is the shipped release:trace steering — default-OFF " +
        "would make P-002..P-005 dead code that no caller ever reaches",
    ).toBe(true);
    expect(
      DARK_FLAGS.has(key),
      `${key} must NOT be in DARK_FLAGS — it is a revert switch for a shipped behaviour, ` +
        "not incomplete work parked dark",
    ).toBe(false);

    // INDEPENDENT PIN — a raw wire literal, so a RENAME fails here (where the reason is
    // written down) instead of silently detaching the io seam in trace.ts that names it.
    const WIRE_KEY = "papercusp-release-trace-progress-certificate";
    expect(
      (ALL_FLAG_KEYS as readonly string[]).includes(WIRE_KEY),
      `the progress-certificate flag must keep the wire key '${WIRE_KEY}'`,
    ).toBe(true);
    expect(key as string).toBe(WIRE_KEY);
    expect(
      FLAG_DEFAULTS[WIRE_KEY as keyof typeof FLAG_DEFAULTS],
      "resolved through the wire literal, independently of the FLAGS constant",
    ).toBe(true);

    // FALSIFIABILITY CONTROL, for the same reason as the guard above: every assertion
    // here is toBe(true), so a FLAG_DEFAULTS that resolved truthy for everything would
    // satisfy all of them.
    expect(
      FLAG_DEFAULTS[FLAGS.GMAIL_AUTO_SEND],
      "control: a known owner-authority dark flag must still resolve default-OFF",
    ).toBe(false);
  });
});
