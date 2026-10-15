/**
 * tool-data-shape-ratchet.test.ts — the {data}-shape growth ratchet
 * (definetool-token-optimization-adoption-2026-06-22 P-003).
 *
 * The framework's CANONICAL ToolResponse shape is `{ data: <payload> }`: a tool
 * returns its payload and the single serializeToolResponse path owns wire
 * encoding — auto-TOON on the agent-facing MCP transport (P-001/P-002), lossless
 * JSON elsewhere — plus the door to declared result schemas. The legacy shape is
 * hand-rolled inline JSON: `{ content: [{ type:'text', text: JSON.stringify(x) }] }`.
 *
 * Both reach the agent identically — P-002's reencodableJsonPayload RE-ENCODES an
 * inline-JSON array/object-with-array to TOON too — so preferring {data} is a
 * CLEANLINESS / consistency / schema-ability nudge, NOT a token-win gate. That is
 * why this is a SOFT growth ratchet, not a hard per-tool failure: a hard gate on a
 * cosmetic preference would red the shared gate on every new tool for no functional
 * gain. bulkContent returns {data} since P-006, so bulk tools are already canonical
 * and are not counted here ("the lint covers bulkContent instead of exempting it").
 *
 * ~393 of 501 tools still hand-roll inline JSON (the 2026-06-22 baseline). This test
 * grandfathers them under a ceiling with churn headroom and asserts the count does
 * not GROW: a NEW tool should return `{ data }` (or bulkContent). Migrating tools to
 * {data} lowers the real count — LOWER `BASELINE` when you do (shrink-only hygiene).
 *
 * NOT a codemod: auto-migrating all ~393 files to {data} is a large, purely-cosmetic
 * blast-radius change (the token win is already delivered by P-002), so it is left as
 * an owner-scoped follow-up rather than done here. Pure-static — mirrors the discovery
 * walk in bulk-contract-sync.test.ts / tools-md-sync.test.ts (no operator process).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../../../../');

// ─── discover defineTool files (mirrors bulk-contract-sync.test.ts) ─────────
const TOOL_FILES: string[] = [];
function findToolFiles(dir: string) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      findToolFiles(full);
    } else if (
      entry.endsWith('.ts') &&
      !entry.includes('.test.') &&
      !entry.startsWith('index.') &&
      entry !== '_bulk.ts'
    ) {
      TOOL_FILES.push(full);
    }
  }
}
findToolFiles(join(REPO, 'packages/agent-mcp/src/tools'));
findToolFiles(join(REPO, 'packages/operator-core/lib/agent-tools'));

// A tool "hand-rolls inline JSON" when its source serializes a payload itself via
// `text: JSON.stringify(...)` (the legacy { content:[{ text }] } shape) instead of
// returning { data } / bulkContent. Coarse-but-stable (a tool may also stringify in
// a non-return spot — fine for a growth ratchet; it stays an over-count, never under).
const INLINE_JSON_RE = /text:\s*JSON\.stringify\s*\(/;

const inlineJsonTools: string[] = [];
for (const file of TOOL_FILES) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes('defineTool(')) continue;
  if (INLINE_JSON_RE.test(src)) inlineJsonTools.push(file.replace(REPO + '/', ''));
}

// Grandfathered ceiling. Real count ≈ 393 of 501 defineTool files on 2026-06-22;
// the ceiling carries headroom so normal fleet churn never reds the gate on this
// cosmetic nudge, while a large regression (a bad refactor adding many) trips it.
// LOWER this as tools migrate to { data } (shrink-only).
//
// 2026-07-03 (WI-1860): 410 → 411. The 2026-06-22 headroom was consumed by normal
// fleet churn; the count reached 411 when the new tool loop/checkpoint.ts
// (su-cold-auto-mode-2026-07-03 P-002) shipped the legacy inline-JSON shape,
// redding the shared release gate. Author-sanctioned bump ("if inline JSON is
// genuinely needed, bump BASELINE with a note") — inline JSON is acceptable here
// (both shapes reach the agent identically via P-002 re-encoding, and fully
// migrating loop:checkpoint would force a throw-based error path onto a peer's
// in-flight tool, out of scope). NOTE: headroom is now exhausted, so this gate will
// re-red on the NEXT legacy-shape tool. The durable fix is the deferred owner-scoped
// { data }-migration sweep (migrate a few mature tools, then LOWER this back down),
// not repeated +1 bumps.
//
// 2026-07-04 (clear-papercusp-backlog-2026-07-02, EI-3226 fix): 411 → 430. Reds
// again — count reached 416 purely from normal concurrent churn (a 10-agent
// backlog-clearance fleet landing many new tools/tool-edits in parallel this
// session; no single feature to attribute). The prior note's "not repeated +1
// bumps" concern is well-taken, so this bump adds real headroom (14, not 1) to
// absorb the rest of this fleet's run instead of re-redding on the next tool.
// The durable fix is still the deferred owner-scoped { data }-migration sweep —
// unchanged advice, just restated so the next bumper doesn't have to re-derive it.
//
// 2026-07-06 (green-checkpoint red, candidate ea86202f): 430 → 432. Reds again —
// count reached 432 from normal concurrent fleet churn (no single feature to
// attribute; the release-fixer classified this as expected growth per this
// ratchet's own "bump BASELINE with a note" convention, not a regression). Same
// durable-fix note stands: migrate a few mature tools to { data } and lower this.
//
// 2026-07-06 (bug-drain-sonnet-0706, su-5071d): 432 → 440. Reds again at 433 —
// traced to operator:notes.ts, a peer's in-flight in-progress tool (untracked,
// mid-build) using the legacy shape; not a regression to fix on someone else's
// active WIP. Multiple large fleets are running concurrently today (bug-drain,
// owner-ask-batch, others), so this bump adds real headroom (8, not 1) per the
// prior note's "not repeated +1 bumps" guidance, instead of re-redding on the
// very next tool. Durable-fix note unchanged: migrate a few mature tools to
// { data } and lower this.
//
// 2026-07-10 (bug-drain-luna gate-green push, su-b72ed): 440 → 445. Count hit
// 441 from diffuse fleet churn — ~18 new defineTool files landed in ~20h across
// several concurrent fleets (fleet/bench, gates/canary-check, probe/*, deploys/
// vintage, coordination/*, etc.); no single attributable regression, and the
// recently-added fleet:kill uses bulkContent (not inline JSON), so it is NOT the
// culprit. Per the "add real headroom, not repeated +1" guidance this bumps by 5
// so the next few churned tools don't immediately re-red the release gate.
// Durable-fix note unchanged: migrate a few mature tools to { data } and lower this.
//
// 2026-07-12 (EI-9970 verification, su-81cec7/fleet p2p-ship): 445 → 452. Reds
// at 446 from general concurrent fleet churn (multiple fleets landing tools in
// parallel this session, per the "main is 21 commits behind staging" promotion
// backlog observed same session) — NOT from EI-9970's own diff (that PR only
// edits sessions:list.ts / sessions:read.ts, both already inline-JSON before
// and after; `git status` on the tool dirs showed no outstanding diff, i.e. the
// count is baked into the already-committed tree). Bumps by 7 (real headroom,
// not +1) per this file's own established convention. Durable-fix note
// unchanged: migrate a few mature tools to { data } and lower this.
//
// 2026-07-13 (WI-4550, su-eb9b7): 452 → 445 — the FIRST time this ceiling has gone
// DOWN. It reds at 453, and every prior entry above answered that by bumping the
// ceiling while promising the same durable fix ("migrate a few mature tools to
// { data } and lower this") — five bumps, 430 → 452, and the promise never came
// due. Bumping is a mitigation, not a fix: it re-arms the trap for the next agent,
// who then has to pay the same interruption. So this time the red was paid off in
// the intended currency instead. 15 tools sharing ONE identical legacy helper
//   const json = (o: unknown) => ({ content: [{ type:'text', text: JSON.stringify(o) }] });
// were migrated to the canonical `({ data: o })` (accounts/{link,session-override},
// pot/{ask,asks,beacon_consent,cross_grant,get_steering,request_work,set_steering},
// work_items/{claim_replica,co_locate,judge_redundancy,record_replica_result,
// set_live_verified,set_redundancy}) — call sites unchanged, agent-facing output
// identical (P-002 re-encodes both shapes to TOON), 9 test helpers repointed from
// content[0].text to .data. Real count 453 → 439, so this LOWERS the ceiling to 445
// and still leaves 6 slots of churn headroom.
//
// The remaining ~439 are the same mechanical shape. If you are here because the gate
// is red again: migrate a batch and lower this further — do NOT bump it a sixth time.
//
// 2026-07-14 (green-checkpoint red, candidate b7d8f5e2, release-fixer): reds again
// at 447 (451 by the time this landed) from ordinary fleet churn — no single
// attributable regression. Per this file's own "do NOT bump it a sixth time"
// instruction, this was paid off in the intended currency again instead of bumped:
// 19 more tools migrated to the canonical `{ data: obj }` shape — agents/list,
// auth/set-full-access-roles, backup/{promote,rollback,snapshot_create,
// snapshot_list}, capability/{envelope-set-role,set-tier}, clamp/set-safe-tools,
// conversation/recent, coordination/tools/{thread,watermark,watermark-set},
// hooks/known, mode/{get,list}, datatypes/{catalog,list,summary}. Each was checked
// for a test calling its `.handler(...)` directly against the legacy
// `content[0].text` shape (none found — all read via the wire-encoding path, so no
// test needed repointing) and for an `isError` branch (none — `coord:rebind-identity`
// was the one candidate with a conditional `isError` and was deliberately LEFT
// inline-JSON, since `{ data }` has no `isError` slot and that would silently drop
// its error signaling). Real count 451 → 432, so this LOWERS the ceiling to 440,
// leaving 8 slots of churn headroom.
//
// If you are here because the gate is red again: migrate a batch and lower this
// further — do NOT just bump it.
//
// 2026-07-17 (WI-5170, su-d838f): reds at 441 from ordinary fleet churn (9 tools of
// growth since the 07-14 batch consumed the headroom). Paid off in the intended
// currency again — 9 more mechanical single-return, no-isError tools migrated to
// `{ data: obj }`: activity/recent, autoloop/status, capability/{grant-role,
// revoke-role}, conversation/append, cross_harness/{inbox,outbox,recent_activity,
// supervisor_notes}. Each checked for a direct-handler test reading the legacy
// content[0].text shape (none — candidates with such tests were deliberately left
// for a batch that repoints them too) and for an isError branch (none — filtered
// out up front). Real count 441 → 432; ceiling STAYS 440, restoring 8 slots of
// churn headroom without a bump. ~97 same-shape mechanical candidates remain
// (single return, no isError, no content[0] test) — the next red should take ten
// of those and LOWER this.
//
// 2026-07-26 (EI-18689563276355853, red-test watchdog, su-a8557b): reds at 442 from
// ordinary fleet churn (10 tools of growth since the 07-17 batch consumed the
// headroom). Paid off in the intended currency again — 12 more mechanical
// single-return, no-isError tools migrated to `{ data: obj }`: facts/{list,retract},
// hooks/known, roles/{get,known,list,firing_on}, scorecards/{list,freshness},
// testing/flakiness, plan-items/{my-items,status}. Each checked for a direct-handler
// test reading the legacy content[0].text shape: roles/__tests__/roles.test.ts covers
// roles:{get,known,list,firing_on}+hooks:known via a shared `parseTextPayload` helper,
// repointed to accept EITHER shape (`'data' in result ? result.data : JSON.parse(...)`)
// instead of one-off repointing each call site; plan-items-tools.integration.test.ts's
// `call()` helper already did `res.data ?? JSON.parse(res.content[0].text)`, so
// plan-items/{my-items,status} needed no test change at all. No isError branch on any
// of the 12. Real count 442 → 430; this LOWERS the ceiling to 438, leaving 8 slots of
// churn headroom (matching this file's established convention).
//
// 2026-08-02 (WI-7123 + WI-7125, su-5ca1d): reds at 439 — the green-checkpoint gate's
// 19:41Z isolation set. Unlike the last three this one WAS attributable: the newly
// added `plans/backfill-dependency-edges.ts` hand-rolled inline JSON (the other two
// tool files added that day already returned `{ data }`). Fixed the offender, then
// paid the headroom back in the intended currency — 8 more mechanical single-return,
// no-isError tools migrated to `{ data }`: backup/{settings_get,snapshot_list},
// voice/{status,leave}, setup/set_update_channel, dev/pg_health,
// operator/{trigger_state,paused}. Four of them DID have direct-handler tests
// asserting the legacy `content[0].text` shape (backup/settings_get.test.ts,
// operator/paused.test.ts, setup/setup-tools.test.ts, operator/__tests__/config.test.ts);
// each has a single shared helper, so all four were repointed to accept EITHER shape
// — the 07-26 `parseTextPayload` pattern — rather than edited call-site by call-site.
// Real count 439 → 430; ceiling STAYS 438, restoring the 8 slots. 241 mechanical
// candidates remain (single inline-JSON return, no isError).
//
// ⚠ Two traps when picking candidates, both hit on 2026-08-02: (1) the INLINE_JSON_RE
// below is deliberately coarse, so a file whose `JSON.stringify` is NOT its return
// still matches — migrating one of those does not lower the count at all
// (coordination/tools/handoffs, dev/{pg_table_sizes,harnesses,pg_active_queries} are
// exactly this). Confirm the stringify is inside the `return { content: [...] }`.
// (2) Do NOT clear a candidate by grepping test dirs for its basename — common tool
// names (`status`, `paused`, `activity`) match unrelated tests and read as a
// legacy-shape test that is not there. Check the tool's own __tests__ dir, or just
// migrate and run the affected suites.
//
// If you are here because the gate is red again: migrate a batch and lower this
// further — do NOT just bump it.
// 2026-08-23 affected-gate repair: migrated five real inline-JSON handlers
// (plans:{publish-outputs,set-output-schema,set-title,audit-unshipped} and
// work_items:withdraw_release_request). Real count 440 → 435; ceiling 438 → 437,
// leaving two slots without rewarding the preceding net growth with a bump.
//
// 2026-08-24 (EI-21298204083822674, su-278b876c): found RED at 444 vs 437 — seven
// over, un-attributable (net growth by several hands since 08-23). Migrated twelve
// mechanical single-return, no-isError handlers to `{ data }`:
// dev/{pg_table_sizes,harnesses,pg_active_queries,activity,audit},
// plugins/runtime_status, setup/set_telemetry,
// operator/{multi_workspace,standing_approval_mark_shown,preview_prompt},
// harness/{pending_reviews,markdown_index}. Real count 444 → 432, verified by
// re-running the discovery walk after each batch (the count dropped by exactly the
// number migrated, which is the only proof a candidate was not a trap-(1) file).
// Ceiling 437 → 434, keeping the established two slots of churn headroom.
//
// ⚠ CORRECTION to trap (1) below: its named list is STALE. It says
// dev/{pg_table_sizes,harnesses,pg_active_queries} stringify outside their return
// so migrating them would not lower the count. Read pg_table_sizes.ts on 08-24:
// it was a textbook single mechanical return, and migrating all three DID lower the
// count by three. They were evidently refactored since 08-02. Verify per file —
// the walk-recount above is the check that settles it either way.
//
// 2026-08-25 (WI-41709, su-8c79a): reds at 435 vs 434 — one over, un-attributable
// net growth by several hands since the 08-24 batch consumed the headroom. Paid off
// in the intended currency rather than bumped, per this file's own thrice-stated
// instruction. Migrated eight mechanical single-return, no-isError handlers to
// `{ data }`: coordination/tools/handoffs, backup/rollback, operator/{stats,nudge,
// dedup_check}, voice/join, plan-items/leave-group, storage/usage. Real count
// 435 → 427, verified by re-running the discovery walk after the batch (dropped by
// exactly eight, the trap-(1) proof). Ceiling 434 → 429, keeping the established
// two slots of churn headroom.
//
// ⚠ TRAP (1)'s NAMED LIST IS STALE AGAIN, third confirmation: it names
// coordination/tools/handoffs as stringifying outside its return. Read at HEAD on
// 08-25 it was a textbook single mechanical return, and migrating it lowered the
// count. Treat that list as a historical note with NO current authority — only the
// per-file read plus the walk-recount settles a candidate. Candidate-picking that
// worked here: exactly ONE `text: JSON.stringify(` in the file, no `isError`
// anywhere (there is no isError slot in `{ data }`, so migrating such a tool would
// silently drop its error signaling), and the stringify confirmed to sit inside the
// `return { content: [...] }`.
//
// 2026-09-02 (WI-212675 gate-red streak, su-97f1e): reds at 431 vs 429 — this one WAS
// attributable: two tools added 09-01 hand-rolled inline JSON (inbox/automation-policy,
// operator/resource-governor-cutover). Fixed both offenders, then paid the headroom back
// in the intended currency — two more mechanical single-return, no-isError helpers
// migrated to `{ data }`: learning/set-scout-budget, db/txn-timeouts. inbox/
// automation-policy.test.ts had a direct-handler `body()` reader on the legacy
// content[0].text shape → repointed to accept EITHER shape (the 07-26 pattern); the
// other three had no shape-reading test. Real count 431 → 427, verified by re-running
// the discovery walk; ceiling STAYS 429, restoring the established two slots.
//
// 2026-09-05 (WI-212675 gate-red streak, su-d424f): red at 436 vs 429. Attributable
// to NINE tool files added since 2026-09-02 that hand-roll inline JSON (measured by
// intersecting the discovery walk with `git diff --name-status 32bd5aa761..staging`):
// capability/list, cupboard/{checkout,commerce-dashboards,refund-request,
// support-request}, improvements/filing-classes, pot/{work-scope-status,work-scope},
// work_items/rehome. Eight are the mechanical single-`text: JSON.stringify`, no-isError
// shape the 07-26 recipe migrates; capability/list carries isError and is not. The
// ceiling is lifted to the measured count so the frozen gate candidate can converge —
// this is the "bump BASELINE with a note" path the assertion names, taken under a
// 124-red gate streak, NOT a new grandfathering: the migration of the eight is filed
// as a work-item, and the next migrator LOWERS this back toward 429.
// 2026-09-18 (frozen-candidate 0ba8f863 repair, release-fixer s-1789727000450): red at 438 vs
// 436. ATTRIBUTABLE: six tool files added since the 09-05 bump (645eb5ef) hand-roll inline JSON
// — capability/{notebook,patch}, learning/dream-control, release/checkpoint-cancel, routines/fire,
// sessions/digest — against four migrated away in the same window, net +2. Three of the six carry
// `isError` (capability/{notebook,patch}, routines/fire) and are NOT the mechanical shape; the
// other three are. Migrated those three plus one more mechanical single-return handler, per this
// file's thrice-stated "migrate a batch and lower this further — do NOT just bump it":
// learning/dream-control, sessions/digest (its ERROR path only — the main return was already
// { data }), release/checkpoint-cancel and coordination/handoff-config (each a single shared
// `json()` helper, so one line apiece covers every call site). Real count 438 → 434, verified by
// re-running the discovery walk after the batch (dropped by exactly four — the trap-(1) proof
// that none of them was a stringify-outside-the-return file). checkpoint-cancel.test.ts and
// handoff-config.test.ts each had ONE shared `body()` reader on the legacy content[0].text shape
// → repointed to accept EITHER shape (the 07-26 parseTextPayload pattern) rather than edited
// assertion-by-assertion. Ceiling STAYS 436, restoring the established two slots of churn
// headroom. The three isError offenders remain for the next migrator: `{ data }` has no isError
// slot, so migrating them would silently drop their error signaling and needs its own design.
// 2026-09-22 (WI-10002321, su-c0385): red at 438 vs 436 — the two slots of churn headroom the
// 09-18 entry restored had been eaten. MIGRATED TWO to `{ data }`: agent-tools/backup/promote.ts
// and agent-tools/activity/bash_substitution_report.ts (both the mechanical single-occurrence,
// no-isError shape, and both with no test asserting the legacy payload). Real count 438 → 436,
// verified by re-running the discovery walk after the batch (dropped by exactly two — the
// trap-(1) proof that neither had its stringify outside the return). Ceiling STAYS 436.
//
// ⚠ HEADROOM IS ZERO, deliberately and only because this landed under a red gate: 436 == BASELINE,
// so the NEXT tool file added with the legacy shape reds this gate for the whole fleet. Restoring
// the customary two slots is filed as its own work-item rather than rushed here — every remaining
// small candidate I checked (flags/list.ts, trust/list.ts) HAS a consumer test, so migrating one
// also means repointing that test to the `{ data }` shape, which is real work and not a drive-by.
// NOTE for the next migrator: "no `.test.ts` sibling" is NOT a safe proxy for "no consumer" —
// both of those are covered from a `__tests__/` subdir or a differently-named sibling. Grep the
// TOOL NAME across *.test.ts instead of looking for a sibling path.
//
// ⚠ AND DO NOT SPELL THE DETECTED TOKEN IN A SCANNED FILE. Migrating a tool and then explaining
// the migration in a comment that quotes the legacy `text: JSON.stringify(` literal reintroduces
// the match in the very file you just fixed: the walk counts SOURCE, so the count does not move
// and the migration reads as a no-op. Hit on the first attempt here — 438 stayed 438 across two
// correct migrations until the comments were reworded. This file is safe to quote it in only
// because the walk excludes `.test.` paths.
//
// 2026-09-26 (WI-10003256, su-6abe2c81): red at 437 vs 436 on frozen candidate cc83bd6e —
// the zero headroom above was eaten by tool files added since 09-22 with the legacy shape
// (orders/{capture,clear,reopen,summarize}.ts, consult/routing-health.ts,
// rubrics/amend-status.ts). MIGRATED TWO to `{ data }`: system-health/unack.ts and
// saved_prompts/list.ts (single occurrence, no isError, tool name absent from every
// *.test.ts). Real count 437 → 435; ceiling STAYS 436, leaving one slot.
// 2026-10-05 (EI-24964470578970826, su-74b1b): current canonical suite reproduced
// 437 > 436. Migrated flags:list and trust:list to the existing `{ data }` seam,
// preserving full payload and workspace-resolution tests. Real count 437 → 435;
// lower the ceiling to 435 rather than grandfathering new inline serializers.
// 2026-10-14 (EI-25860806033862441): red at 442 vs 435. Since the 10-05 baseline,
// ten tool files began matching and three stopped; migrated seven mechanical,
// single-return handlers without error branches to `{ data }`: cupboard/publish-app,
// pot/{membership_pending,moderation_queue}, quota/set-tool, setup/set_git_identity,
// git_sync/send_green, and locks/cancel_wait. Real count 442 →435; keep the ceiling
// at 435 so the new inline serializers are not grandfathered.
const BASELINE = 435;

describe('tool {data}-shape ratchet (token-opt P-003)', () => {
  it('inline-JSON tool count does not grow past the baseline (prefer { data } / bulkContent)', () => {
    expect(
      inlineJsonTools.length,
      `${inlineJsonTools.length} defineTool files hand-roll inline JSON ` +
        `(content:[{ text: JSON.stringify(...) }]) — over the ${BASELINE} ceiling. A NEW tool should return ` +
        `{ data: payload } (the framework owns wire encoding, incl. auto-TOON on the MCP transport) or bulkContent. ` +
        `If inline JSON is genuinely needed, bump BASELINE with a note; better, migrate a tool to { data } and LOWER it.`,
    ).toBeLessThanOrEqual(BASELINE);
  });

  it('discovered the tool corpus (guards a broken discovery walk)', () => {
    expect(
      TOOL_FILES.length,
      `tool discovery found only ${TOOL_FILES.length} files — did a tool path change?`,
    ).toBeGreaterThan(100);
  });
});
