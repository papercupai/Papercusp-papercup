<!-- GENERATED FILE — DO NOT EDIT BY HAND. -->
<!-- Projected from Postgres: harness_shared.harness_doc_parts (doc_id=claude-md, client=claude). -->

> ⚠ **CLAUDE.md is GENERATED — editing it here does nothing durable.** Claude Code reads this file
> off disk, which is the only reason it exists (the canonical content is in Postgres:
> `harness_shared.harness_doc_parts`, with `harness_docs.content_mode='composed'`). A hand-edit
> is overwritten by the next projection and is invisible to every other client.
>
> **To change a rule:** edit its PART, then re-project — both halves are commands:
> `npm run set-doc-part -- --part-key <key> --body-file <path> --write`
> (`--list <prefix>` to find the key; dry-run without `--write`), then
> `node scripts/project-doc-parts.mjs --write`.
>
> Supporting evidence for these rules is deliberately NOT here — it lives in the corpus
> (`kind='prose'` rows, searchable) so a rule reaches the agent without its case history.

# Papercup — agent guide

> Invariants + pointers only. The long-form detail behind every pointer lives in
> `/internal/docs` — start at
> [system/repo-conventions](/internal/docs/system/repo-conventions) (deployment
> model, retired surfaces, borrowable libs, branch/commit discipline long form,
> two-port model, database topology, test infrastructure).

> **Environment quick-start:** [`AGENT-ENV.md`](AGENT-ENV.md) — the machine-checked
> repo operating contract (where shared code lives: `libs/` vs `packages/`; how to run
> tests: the hoisted-root `vitest`; the operator-vite `@` cross-tree alias trap). It is
> GENERATED from the real config (`npm run gen:agent-env`) so it cannot drift, and
> `npm run doctor` asserts the same invariants as runnable checks. Read it first if you
> are new to the tree.

## ▶ Running / testing this app — it is the **Tauri DESKTOP app**, not a browser webapp

> The most-ignored rule in the repo. Read it before you try to "open the app".

**The ONLY supported way for an AGENT to run or test the app — it never touches the
owner's live desktop:**

```bash
scripts/verify-tauri-headless.sh -- bash -c '<your tauri-agent-tools assertions>'
scripts/verify-tauri-headless.sh --boot-only   # multi-step; run the printed stop script when done
                                               # under capability:bash: --boot-only-i-accept-task-lifetime
```

It boots `papercusp-desktop` on its OWN auto-picked Xvfb display (≥90) + VirtualGL, with
its own devUrl port and its own sidecar — embedded PG, migrations, webview, dev-bridge —
runs your assertions with `VERIFY_TAURI_PID` / `_PORT` / `_DEV_URL` / `_POLL` exported,
tears the whole tree down even on a failing assertion, and exits with your command's own
code. `--help` prints the full contract. ⚠ The **database and workspace are NOT isolated**
by default: every write you click is a real write to live state — pass
`VERIFY_TAURI_ISOLATED_DB=1` for a throwaway per-run PG + WebView profile before you
exercise write paths.

**The attended/human form is `cd papercusp-desktop && npm run dev`** (from the repo root).
It opens a REAL window on the inherited `DISPLAY`, which on this box is the owner's live
desktop `:1` — so it is for a human who asked for a window, **never** for agent
verification (agent-e2e §0 forbids focus-stealing; WI-2648 is the incident where synthetic
input leaked into the owner's real email draft). Either form boots embedded PG, the
operator sidecar, migrations, and the webview. There is no "just the webapp" mode.

> **You CAN — and therefore MUST — verify UI yourself; "I can't check UI
> headless" is a mistake, not a constraint.** Launching this shell is within
> YOUR reach (run the command above — it is one script; first cargo build ~2 min),
> and you then drive its webview **head-lessly, no focus-steal**, with the
> **`tauri-agent-tools`** CLI: `probe` · `eval` · `dom` · `click` · `type` ·
> `screenshot` · `check` (CI-style assert, exits 0/1) · `capture` (screenshot +
> DOM + console + logs). Full playbook: `/internal/docs/testing/agent-e2e` §0–§2
> (attach to a running shell, or start your OWN second instance). Therefore a UI
> task is **NEVER** "blocked on a Tauri/desktop session," and UI is **NEVER**
> "unverifiable headless." If you catch yourself deferring, punting, or shipping
> UI work as un-testable-without-a-human, STOP — that *is* this mistake: start the
> shell and drive it. (For non-Papercusp/arbitrary web pages, `verdict`; the
> operator UI only renders correctly inside Tauri, so never point `verdict` or a
> browser at `:3055`/`:3070`.)

- **Never open `:3055`, `:3070`, or `:3170` in a browser** (verdict / playwright /
  chrome / `xdg-open`). They are the desktop's *internal content source* — a
  browser view is the **retired** webapp and gives a broken/misleading result,
  and navigating verdict there has wedged the shared verdict daemon outright
  (no Tauri IPC bridge, so the SPA never settles — `goto` never returns, and
  every later command in the same session times out too, until `stop`+restart).
  A `PreToolUse` hook (guard-operator-desktop.mjs) blocks a `Skill`-shaped
  navigation call, but that hook's matcher does not cover verdict's real
  invocation path (a plain Bash command, per SKILL.md's
  `allowed-tools: Bash(verdict*)`) — so verdict-cli itself also refuses
  client-side, before ever contacting its daemon, for all three ports
  (EI-22200064677663549; the patch lives in `patches/verdict-cli+0.1.1.patch`).
- **Never start `apps/operator` as a standalone Next server** (`next dev` /
  `next start`) — retired. (The root `bin/dev`/`bin/prod` launchers are NOT the
  forbidden thing — they boot the Vite `:3055` + Hono `:3070` stack and invoke
  no Next.)
- A `curl http://127.0.0.1:3070/...` for a quick **API** check (not a UI check)
  is fine while the desktop is running.


The `:3055`/`:3070` layer **is the desktop's content layer**, not a separable
webapp — what's retired is the *act of running/browsing it standalone*. Detail +
the transport/persistence table:
[repo-conventions § deployment model](/internal/docs/system/repo-conventions).

## Almost all state should be in nuqs

**If a piece of state is reasonably user-meaningful, it goes in the URL via
[nuqs](https://nuqs.dev), not `useState`.** Non-negotiable: the agent → UI
control surface (`ui:get_state`, `ui:dispatch`) reads/writes the URL — anything
in `useState` is invisible to agents.

- **nuqs:** tab/view/mode selectors, panel/drawer/dialog open-state, selection
  ids, search/filter/sort/pagination, expansion toggles.
- **useState:** loading/saving/error lifecycle, mid-edit drafts, hover/focus,
  toasts, ref-coupled sync values, render-only state.

**When in doubt, choose nuqs.** Prefer `parseAsStringEnum` > `parseAsBoolean` >
`parseAsString` > `parseAsJson(shapeGuard)`; encode complex selections as a
short scalar (`"review:<id>"`) + `useMemo` lookup, never 1KB of JSON. 

## All client data sync goes through `@papercusp/sync`

Reads via `useSyncQuery({ queryName, args })`; writes fire
`notifySyncInvalidate(...)` (+ `useSyncMutate` for the hook). **Never** hand-roll
`fetch + setInterval`, SWR, React-Query, or a raw `EventSource` for query data —
the library is the one audited path (**SSE in every runtime** — desktop *and*
browser, no runtime branch; POLLING/REST only as the degraded fallback. 

Wiring: resolver entry in `packages/operator-core/lib/sync-resolver/index.ts`
(read) + `notifySyncInvalidate` from `packages/operator-core/lib/sync-sse.ts`
after the write commits. Genuine exceptions (byte streams, UI timers,
operator-mobile's polled path) and the full recipe:
`/internal/docs/data-sync` + the
[adding-a-sync-query](/internal/docs/agent-insights/adding-a-sync-query) insight.

## Scheduling: no bare `setInterval`, no new scheduler

Recurring work has exactly **two execution mechanisms** + **one declaration surface** — don't
add a third. Durable + Postgres-backed → a **DBOS scheduled workflow** (or a `tier:durable`
routine fired by `routinesTick`). A frequent in-process bounded sweep → declare a
**`tier:ephemeral`** blueprint `triggers.schedule` (deterministic `system:<action>` + `intervalSec`;
the per-host `ephemeral-executor` runs it). A watchdog / per-connection / cache timer that must
stay bespoke → still wrap it in `managedSetInterval(name, ms, fn, { category })` so it is VISIBLE
in `schedule:inventory` (*visibility ≠ control*). A bare `setInterval` fails
`lint:no-raw-setinterval` (the BASELINE is empty). Full model:
[the scheduler layer model](/internal/docs/agent-insights/two-tier-scheduler-and-timer-visibility).

## Spawning: no unenrolled `detached` spawn, and never kill by name

The process analogue of the scheduler rule above. A `detached: true` spawn creates a
process meant to **outlive the call that made it** — the root of a subtree — so it must be
enrolled in the task ledger: **`managedSpawn`** (`task-manager/managed-spawn.ts`) for an
async seam, **`beginSyncEnrolment` + `completeSyncEnrolment` + `finishSyncEnrolment`**
(`task-manager/enroll-sync.ts`) for a sync one. `lint:no-unenrolled-spawn` fails a new
un-enrolled site; genuinely-not-ours lifetimes (a human terminal window, a pre-operator
bootstrap, a release cut that survives the restart it performs) go in that guard's
ALLOWLIST **with a reason**. Ordinary short-lived spawns need nothing — cgroup membership
is inherited, so a `git rev-parse` inside an already-confined process is already accounted
for. That inheritance is the whole design: confine the ROOTS, and the kernel accounts for
every descendant, including ones that double-fork and reparent to init.

⛔ **Never kill by name or pattern.** `pkill -f '<binary>'` has twice killed the owner's
live desktop window and peer agents' Xvfb instances. Use **`processes:kill { taskId }`** —
it kills the whole cgroup subtree and cannot reach a recycled pid (PID wrap happens ~daily
here under fleet load). An `identity_mismatch` refusal is the rail working, not a bug. To
relieve pressure without losing work, **`processes:freeze`** beats killing.

| you want | use | not |
|---|---|---|
| what is running AND WHY (who launched it, for which work-item, what it costs) | `processes:list` | `ps`/`pgrep` — kernel-shaped, zero provenance |
| the six tracked AGENT process kinds | `dev:processes` (unchanged, deliberately narrow) | `processes:list` |
| a real whole-host process list | plain `ps`/`pgrep` (never gated) | `processes:list` — it will answer wrong, not empty |

Human pane: `/admin/tasks` (sibling of `/admin/schedules` — that one inventories everything
RECURRING, this one everything RUNNING). Full model:
[the task manager and the no-escape property](/internal/docs/agent-insights/task-manager-and-the-no-escape-property).

## Shared-lib singletons: pin through the primitive, never by hand

Module-scoped mutable state in a shared package (`const registry = new Map()`, a cache,
a pool, a `configure*()` host-seam object) is a singleton **only if the loader produces
exactly one module record**. Several ordinary seams break that with no error: tsx's CJS
preflight beside the ESM loader, the same file reached by bare specifier and by relative
path, `node_modules/@papercusp/*` symlinked into the repo, a bundled copy beside source.
When it splits, each record gets its own state and writes to one are invisible to readers
of the other. Nothing throws — you get a *partial* view that looks complete.

**Use `pinModuleState` from `@papercusp/module-singleton`, at module scope, once:**

```ts
const state = pinModuleState('@papercusp/your-pkg.state', () => ({ registry: new Map() }));
```

It pins to `globalThis` under a `Symbol.for` key — correct under *every* seam above, so
you never have to prove which one applies — and counts evaluations, so a re-split is
reported by `listModuleDuplications()` instead of being rediscovered the expensive way.
⚠ **Do not hand-roll the `Symbol.for` + `globalThis` pair.** Hand-rolling still fixes
correctness, but the key is invisible to the central report, which then answers a
confident `[]` while your module is split — the failure below, one level up.
**`npm run lint:no-hand-rolled-module-pin` fails on a new one** (and
`-- --list` prints the full measured population, which is how its allowlist is
re-seeded — never from a hand-run grep).

## Deployment model: desktop is the product; the standalone webapp is RETIRED

Shipping target = the Tauri desktop app; **SSE is the sync path that matters** —
`HarnessSyncProvider` passes a literal `syncType="SSE"` with **no** runtime
branch, so a plain browser tab runs the SAME transport as production. WS is
**retired** (nothing selects it); POLLING is the degraded fallback and is
catastrophic here (~40 registered queries re-fetched per tick against a
6-connection-per-host cap starves the pool), so a feature that only works under
POLLING — or that assumes the retired Zero WS — is incomplete. Source of truth:
`apps/operator/providers/HarnessSyncProvider.tsx`. Transport table +
stale-docs-to-mistrust list:
[repo-conventions § deployment model](/internal/docs/system/repo-conventions).

## Retired / preserved-not-active surfaces

Some code is **retired but deliberately kept** — not deleted, not deployed, not
tested, not to be extended. 

## Borrowable libraries — generic-first

Domain-free libs under `libs/generic/*` may be standalone Git submodules or ordinary superproject directories.
Before submodule-relative Git commands, check `git -C <path> rev-parse --show-toplevel`.
If it reports this checkout root, use superproject-relative paths; if the target root, use submodule-relative paths.
`BORROWABLE.md` is generated (`npm run gen:borrowable`). A genuinely domain-free algorithm STARTS as `libs/generic/<name>` behind a `configure*()` seam.
Never inside `operator-core/lib` for later extraction. `npm run lint:generic-first` (advisory) flags violations; add incidental hits to the `ALLOW` set in
`scripts/check-generic-first.mjs`. Long form + seam pattern:
[repo-conventions § borrowable](/internal/docs/system/repo-conventions).

## This app is in testing — there are no users yet

There is no production. **Don't defer fixes for "let's see how it fares in
production first"** — there's nothing to fare in. **Be bold — in alpha, timidity
is the failure mode, not breakage.** The genuine mistakes are the cautious ones:
preserving a design you know is wrong, back-compat shims, deprecation aliases,
half-fixes to dodge churn. When the correct fix is a breaking change — a schema
migration, an API redesign, a rename, ripping out a load-bearing-but-wrong
abstraction — **make it now, in full**: redesign instead of layering, rename
instead of aliasing, migrate schemas when they're correct, pick the best
tool/library not the safe one, prefer a maintained library or existing internal
surface over rolling your own, lift anything general into a shared/generic lib.
Surface what you're changing to whoever supervises your work; don't ask
permission to do it well.

## A blocker is work, not a stop sign — resolve it, don't just relay it

Hit a blocker — something in scope that's hard/big/risky, a failing dependency,
a broken tool, an env/config fault, a wedged service? **Don't pause to hand it
to the owner. Investigate the root cause, fix it, and fix it DURABLY** — resolve
the whole class so it can't recur, not a one-off patch that leaves the trap
armed for the next agent (a half-fix is the real failure mode here). Escalate to
a human ONLY when the fix is genuinely irreversible / high-stakes, outside your
authority, or you've actually tried and can't resolve it — and even then, bring
your diagnosis + a proposed durable fix, not just the blocker. Whatever you
genuinely can't resolve now, record durably on the work-item: use
`work_items:set_blocker` for an external event, gate, runtime, or human blocker
(with its kind, capability, ref, evidence, and next action), and use
`work_items:link { rel:'blocks' }` when another work-item must finish first;
never a prose message that scrolls away — and carry it forward in every status
report.

**Before burning hours re-deriving something a PEER may already know, ask the
router: `consult:get_feedback { question }`.** It answers instantly from the archive when a
closed consult already settled the question; otherwise it ranks every agent's
real transcript history (yours excluded) and launches an ISOLATED answer
session from the best-qualified peer's transcript, with why-they-were-chosen
evidence — the expert's own live session is never woken. Honest by design: a
below-floor responder is labelled `via:'minimum'`, and `min_agents: 0` returns
"no one knows more than you do — proceed", never a costumed expert. Reach for it at exactly the moments you'd otherwise
deep-dive an unfamiliar subsystem, re-debug a failure someone else already
fixed, or guess at another lane's design intent. (It is who-knows DISCOVERY —
for a KNOWN agent use `coord:send`; for live state, query it; for an owner
decision, `coord:ask-owner`.)


Interactive (human-present) PSU sessions can still take a fast redirect from the owner, but the default is resolve-don't-relay.

**A reversible judgment call you could make yourself is not an owner wall — park it.** Call `work_items:set_blocker { id, kind:'product-decision', ref, defaultIfUnanswered, decideBy }`: it opens a peer review of your default, objections must carry an alternative, and silence by the deadline means proceed. Only owner-authority topics (spend, destructive, publish, credentials, security) wait for the owner.


⛔ **Before reporting an OWNER-GATED credential/permission wall, exhaust the privilege you hold — here `sudo -n` is `NOPASSWD: ALL`.** Escalating after probing only the *unprivileged* path hands the owner a chore you could have done.

```bash
sudo -n -u postgres psql -d papercusp -c '<SQL>'
```

⚠ Run it via `capability:bash` (host context), never a psu Claude session's native `Bash`: that sandbox sets `NoNewPrivs` and unshares the network, so `sudo` and `psql :5432` both fail falsely. A wall is owner-gated only once host-context `sudo -n` failed; name what you tried and where — "no superuser is reachable" describes YOUR probes, not the machine.


## A cross-lane ruling is a plan Decision, recorded the moment it forms

Any agent — not only a fleet leader — who settles a trade-off, ratifies a scope, or issues a
ruling OTHER lanes must follow records it as a plan Decision **at the moment it forms**:
`plans:add-decision { slug, title, body }` (via the structured `### D-NNN` form the tool
produces — a hand-authored `- **D-NNN**` bullet in a plan body is NOT parsed as a decision by
`@papercusp/plan-parser`, so it never surfaces through the mechanisms below). Never record a
governing ruling only as a coord message: a message is not addressable after delivery, so a
peer who received a wrong paraphrase has no way back to the source. A decision is.

This is not a paperwork nicety — it changes outcomes. 

## Every plan ships with a graded acceptance rubric

⛔ **CARRYING A PLAN "START TO FINISH" INCLUDES THESE VALIDATION STEPS — they are the finish, not paperwork after it.** An owner who says "carry out the plan" or "finish it yourself" is asking for a SHIPPED plan. Stopping at the last implementation item and reporting done — or naming the remaining validation and handing it back — is the same silent halt in two costumes.

⚠ **You do NOT recruit the grader by hand — `plans:set-plan-status { status:'shipped' }` IS the recruiter.** It routes through the relevance router, excludes implementers/author/shipper for you, cascades past a decline, and mints a lineage-safe fresh judge if nobody is eligible. You GET a non-implementer by ROUTING to one, never by LAUNCHING one — a session in the author's spawn/rebind lineage is refused after a full boot is paid for. Hand-picking from `coord:presence`, or a `work_items:create` grading request, re-implements that cascade without its fallback.

⛔ **Recruitment only fires on `{acceptance_ungraded, self_graded_only}`.** Any other refusal — above all `acceptance_bar_contract_not_ready` — refuses WITHOUT recruiting, and its repairs are YOURS alone; recruiting then is premature because grading is not yet reachable. Get the refusal to read `acceptance_ungraded` FIRST, then call the same verb again. Stragglers, the per-item audit and the grader's evidence stay yours — doing them first is what makes grading cheap.

**Two independent evidence families gate `plans:set-plan-status → 'shipped'`: a per-item CODE-TRUTH audit, then a GRADED acceptance rubric.** After implementation is verified:

1. **Finish or intentionally drop every item** — `todo`/`blocked`/`needs-human` refuse shipping; a deliberate departure is `plans:set-status { status:'dropped', note }`.
2. **Audit the actual code, per item** — `plans:audit { slug, items:[{ itemId, verdict, citations }] }`. A code deliverable verifies only by `code`/`test` citations, in any profile; paths must resolve and their blob SHAs are stored. A non-code deliverable (a `general` plan's default, or declared) also verifies by `artifact`/`work-item`/`measurement`/`external`. Deliverables and plan `type:` resolve through the type registry at the plan's pinned revisions ([plan and item types](/internal/docs/agent-insights/plan-and-item-types)). Never treat a work-item, doc, or memory of writing code as code truth.
3. **Acceptance bars are seeded at plan activation** from the plan's `requirement` blocks (`plans:audit { phase:'activation' }`), OUTCOME criteria tracing to the goal + Decisions. At completion, amend them to as-built reality with `rubrics:amend`. No seed? Author one with `rubrics:propose { rubricRef:"<acceptance-rubric-slug>", kind:"acceptance", subjectPlan:"<plan-slug>", classRef:"plan-class-feature-ship", characteristic:"<umbrella-domain>", title:"<acceptance title>", criteria:[…] }` (an investigation may use `criteria:[]`).
4. **Vet its current revision** — `consult:get_feedback { policy:'rubric-vetting' }` (that key, NO responder count), improve, then attest with `scorecards:emit` against `meta-acceptance-rubric`. Any later rubric edit invalidates BOTH the attestation AND any independent grading, so batch every revision BEFORE requesting independent grading.
5. **A NON-implementer grades it** — `scorecards:emit { rubricRef, ratings }` with concrete evidence per criterion; the grader must be outside the rubric author's spawn/rebind lineage and spot-checks the audit citations.
6. **The implementer records the acceptance call** — re-emit the complete ratings with `acceptance:{ verdict, reasoning }`. The implementer owns the passing bar; a latest `reject` blocks ship until superseded.
7. **Ship** — `plans:set-plan-status { slug, status:'shipped' }`; the rubric auto-retires.

`force:{ reason }` waives ONLY the code-truth checks, and permanently marks the plan with what was waived, by whom and why. It NEVER waives rubric existence, vetting, independent grading, or the implementer's verdict.

Each refusal code names its own repair: [plan completion runbook](/internal/docs/agent-insights/acceptance-rubrics-on-every-plan-runbook) · [rubric vetting](/internal/docs/agent-insights/acceptance-rubric-vetting) · [verification profiles](/internal/docs/agent-insights/plan-verification-profiles).


## Verify mixed-family work-item citations against the base table

A zero-row lookup in `harness_shared.engineer_issues` does not prove a citation
fabricated: that view is issue-family only and omits feature-family `WI-`/`F-`
rows. Check a mixed `EI-`/`WI-`/`F-` set in the base table
`harness_shared.work_items` (`feature_id`), or with `work_items:get { id }`.
A work-item id names one row per WORKSPACE: scope by `workspace_id` only, since
a guessed `harness_slug` turns a real citation into a false zero.

```sql
-- sql-snippet-justified: the RELATION CHOICE is the lesson — only the base
-- table answers a mixed citation set; work_items:get is named above.
SELECT feature_id, item_kind, status, harness_slug
  FROM harness_shared.work_items
 WHERE workspace_id = '<workspace-id>'
   AND feature_id IN ('<EI-or-WI-or-F-id>', ...);
```

Call a citation fabricated only after this lookup and a nearby-id sanity check
both support absence. Every id you cite must be globally unique or carry its
scope: write `<slug>#P-NNN` / `<slug>#D-NNN`, never bare
([identifier-scope invariant](/internal/docs/agent-insights/identifier-scope-invariant)).


When citing a repo-relative file path in a work-item comment or checkpoint that
may be read from a DIFFERENT harness — this workspace holds ~50 independent
checkouts side by side under `~/papercupai-workspace/` (portal, calendar,
zero-harness, several papercup*/papercusp* trees, …) — REPO-QUALIFY the path:
prefix it with the checkout directory name, e.g. `portal/packages/ui/src/shell.tsx`,
not bare `packages/ui/src/shell.tsx`. A repo-relative path is only meaningful
WITH its repo; an unqualified one that happens to live in a sibling checkout
fails every same-repo probe (`ls`, `find`, `grep`) exactly like a fabricated
path would, and reads as a hallucination to the next agent even when it is
entirely accurate (EI-22169368425533789).

`work_items:checkpoint { dependsOn: ['file:<path>'] }` now probes sibling
checkouts automatically when a `file:` ref cannot be resolved in the item's own
harness, and names the repo it actually lives in when it finds a hit — but that
detector only fires for a `dependsOn` declaration, never for a plain path
quoted in prose. Qualify it yourself; do not rely on the detector to catch it.


## Branch discipline: the shared tree stays on `staging`; `main` is automation-only

- The canonical shared checkout (the repo root you are working in) **always has
  `staging` checked out**. Work on `staging` directly — **no `git worktree`, no
  feature branches**; coordinate via `locks:*` (per-edit hook is automatic) + `coord:*`
  (declare-intent), not tree isolation.
- **`main` is the promoted branch** — it only fast-forwards to a staging commit
  with no BLOCKING failure (the ratchet rule below); nothing and no one pushes it
  directly (a pre-push hook blocks you).


## Commit discipline: git-sync owns commit + push — you do neither

A background **git-sync** routine commits the whole shared tree and pushes to
`origin/staging` on a schedule (superproject + every submodule). **No `git add`
/ `commit` / `push`, no stashing/branching to isolate "your" diff** — just leave
work in the tree. Merge conflicts go to a `merge-resolver` agent, not you. From
`staging`, green-checkpoint (hourly) FFs `main` and release-trigger (≤15 min)
auto-deploys it to `:3070`. Pipeline view: `/admin/git`. Long form + symptoms:
[repo-conventions § branch + commit](/internal/docs/system/repo-conventions).


> ⚠ **Neither `git blame` NOR a commit's SUBJECT (nor a `Co-Authored-By` trailer) is evidence
> about a change in this repo — never cite one.** git-sync sweeps the WHOLE tree under ONE
> identity. For authorship use the commissioning work-item or a timestamp-correlated
> `sessions:search`; if neither resolves, say "not attributable" — never name a person.
>
> **Which commit carries your change → `TZ=UTC git log -1 --date=iso-strict-local --format='%cd %H %s' -- <path>`.
> NOT `git rev-parse HEAD`:** the tip is routinely a DIFFERENT commit from the same sweep. Only a
> `--date=*-local` format honours `TZ` (it is INERT on `%cd`/`%cI`); keep `TZ=UTC` on
> `--since`/`--until` too.
>
> ⚠ **Containment is a CONTENT question, never a date or ancestry one.** `git rev-parse
> <sha>:<path>` vs `git rev-parse staging:<path>` — equal blobs ⇒ it carries it.
> `merge-base --is-ancestor` proves REACHABILITY only. For "is my change live", ask
> `dev:pipeline_position { path }` or `state:read { cell:'gate.greenCheckpoint.candidate', as:'<path>' }`.
> Silent-misreport traps (moving `HEAD`, `rev-parse` of a missing path, submodule paths) with
> exact commands: [git evidence and containment recipes](/internal/docs/agent-insights/git-evidence-and-containment-recipes).

> 🚨 **NEVER run a tree-wide destructive git op on the shared checkout** — not
> `git reset --hard`, not `git checkout .` / `git checkout -- :/`, not
> `git clean -fd`, not `git stash`. 

**Never sit in a wait/poll loop for git-sync or the deploy — force it instead.** Staging
first: once `:3170` has your commit, `tools:invoke { name, args, build: 'staging' }` runs it
there, enough for a non-final item. Only a step needing **live `:3070`** forces it:
`PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --execute`
(env var **required**, else the rollback crash-loops `:3070` on `MODULE_NOT_FOUND`;
recover: `systemctl --user stop papercup-dev-api.service`, re-run with `--no-drain`).


**"Is my change live, and if not what is the ONE thing blocking it" is ONE call — `dev:pipeline_position { path }` — never a hand-diff.** It answers three *different* questions that agents routinely conflate:

| you want to know | read | not |
|---|---|---|
| is it live, and if not the ONE lever | `blockedOn` + `nextAction` | the row of position ticks |
| is this leg stuck, or just slow | `stages[].health` (`advancing`/`stalled`/`disabled`/`broken`) | `positions.*` alone |
| did my work reach origin | `gitSync.pushedRepos` | `gitSync.status` — `'synced'` is reachable with **nothing** pushed |
| is the running process executing my code | `serving.startedSinceCodeChange` | `positions.deployed` — a git fact, not a process one |
| is the gate judging MY code | `changeInCandidate.markerJudging` — pass `marker`, a literal string YOUR change introduced. `judgingContainsPath` answers only about THE PATH YOU PASSED, so its `true` is a verdict on your change only when that path is one you actually edited; read `missingReason` before believing a `false` | a bare `true` from a fixed probe path reused across wakes |
| will the next tick commit my half-finished refactor | `sweepExposure` — `Edit`/`Write` files are held until your turn ends (`turnHeld`); across turns, `locks:acquire` | assuming Bash-written files are held — they are swept |

`nextAction: null` is a **positive** answer ("waiting is correct"), never a missing one —
do not invent a lever when the honest move is to wait. Full field-by-field guide:
[reading pipeline state](/internal/docs/agent-insights/reading-pipeline-state-position-health-nextaction).

**About to ACT on one of these values — or quote it into a message, a plan, or a
work-item? RE-READ it, don't copy it: `state:read { cell }`** — `gate.greenCheckpoint.candidate` ·
`gate.greenCheckpoint.verdict` · `gate.greenCheckpoint.ownership` · `git.mainBehindStaging` ·
`git.pipelinePosition` · `deploy.3070.sha` (omit `cell` to list them). A transcribed copy goes
stale mid-turn.

✅ **`dev:pipeline_position` HANDS YOU THE HANDLE:** its `plane` block names, per volatile
value, the `cell` that re-answers it and a ready `reread` call. Copy the handle, not the number.

- **The handle is already addressed to YOUR subject:** the per-path cells
  (`git.pipelinePosition`, `gate.greenCheckpoint.candidate`) carry `as: '<the path you asked
  about>'`; re-reading without it answers about a different subject. An entry appears even when
  the value is `null`.

- **"Is the gate red about MY change?"** — `state:read { cell:
  'gate.greenCheckpoint.candidate', as: '<your path>' }`, a **blob containment** check against
  the candidate. Never read "the gate is red" as "the gate is red ABOUT MY CHANGE."
- **Waiting for one to CHANGE** (a verdict, a deploy sha) → `state:subscribe`, not a poll loop.

⛔ **`main` advances on a RATCHET, not on "fully green".** The gate promotes a candidate when no BLOCKING failure remains: every failing test blocks unless an ACTIVE downgrade record in `harness_shared.test_downgrades` covers its file and case (`decidePromotionRatchet` in `packages/operator-core/lib/release/promotion-ratchet.ts`). A red takes the ladder **fix → eject → downgrade**: fix it; else eject (revert) the change it is attributed to; only then downgrade it with `release:test-downgrade` (reason, owner, filed bug; a critical-area test also needs an acknowledgement and notifies the owner). Never hand-quarantine or skip a test to get past the gate.

⛔ **A RED CANDIDATE IS FROZEN ON PURPOSE — never "just re-run" the gate at tip.** The standard main-greening procedure is **freeze-and-converge** (`RELEASE_FREEZE_AND_CONVERGE_DEFAULT`, default ON): on the first real code red the gate opens ONE frozen repair queue, and every later run RESUMES that exact candidate rather than a newer tip.

So when the gate is red: **author the fix on the shared staging checkout as normal — there is NO repair worktree — wait for git-sync to commit it, then land it on the frozen lineage BY PATH: `release:repair-queue { op:'admit', paths:[...] }`** (dry run by default; `confirm:true` publishes). That lands your fix ON TOP of the frozen candidate (advancing `repairHead`); the queue re-tests that head itself, and the immutable candidate never moves. Admission is hunk-exact; a refusal `admission-incomplete` names a sibling to admit too — **the tip is NEVER widened for you.**

Do NOT fire `release:checkpoint-run` to "try again" as a bypass: when a frozen queue exists, it applies the queue policy and resumes the exact frozen lineage (`ready-to-test` uses `queue.candidate`; `ready-to-verify` uses `queue.repairHead`; non-suite states refuse before launch). Only when no frozen queue exists does it cut a fresh candidate from the current quiet cut at tip. `release:repair-queue { op:'retire' }` is **not a "make the gate move" lever** — only for a provably unreachable-green queue.

✅ **"Is the freeze ON, and if not WHY" is a READ:** `gate_health.freezeAndConverge` → `{ enabled, state, reason, candidate }` (`off` = switched off; `none` = ON with nothing frozen). A surprising refusal is build-scoped: compare `refusal_provenance` with `/api/health` on `:3170` and `:3070`.

Retire criteria, state table and the D-007/D-008/D-010 rationale: the `commit-discipline-freeze-and-converge-standard#evidence` corpus part.


✅ **It DOES answer *"which sha is the run judging right now"* — read `source.authoritative`
before you act on the sha:** `'retriage-marker'` is authoritative; `'run-probe'` is an
inference (on a CRON run, the checkpoint checkout's live HEAD). Do not fire a manual re-run off
an inferred candidate.

⚠⚠ **THE PREMISE UNDER EVERY RECIPE BELOW: the candidate is cut from your LOCAL `staging`,
NOT from `origin/staging`. The gate never fetches — so pushing is not a precondition for the
gate to SELECT A CANDIDATE, or to RUN.** PROMOTION is the other half: `pushGreenCandidateOrThrow`
runs BEFORE `deps.advance(...)` and RETHROWS on failure, so while the push credential is broken
**no green is recordable at all** (pinned by
`packages/operator-core/lib/doc-claims/gate-promotion-push-precedes-advance.test.ts`).

green-checkpoint resolves it as `opts.candidate ?? opts.candidateHint ?? cfg.integrationBranch`, and `integrationBranch` defaults to the literal `'staging'` (in `release-config.ts`). There is no `git fetch` invocation in `green-checkpoint.ts`, and its submodule resync is `submodule update --init --recursive`, never `--remote`. So the hop that matters for containment is **COMMIT** (git-sync's local commit), not the push.

⚠ **A path inside a SUBMODULE needs its own containment check.** From the superproject,
`git rev-parse <candidate>:<sub>/<path>` is ABSENT and `git log -S… -- <sub>/<path>` is empty —
both read like *"my fix is not in the candidate"* (and **every DB migration lives in
`libs/papercusp/libs/db/sql/`**). Ask the cell with the SUPERPROJECT-relative path:
`state:read { cell: 'gate.greenCheckpoint.candidate', as: 'libs/papercusp/libs/db/sql/727-….sql' }`
— it compares blobs inside the submodule at the gitlink the candidate pins
(`changeInCandidate.submodule`; `missingReason:'newer-commit'` = the superproject gitlink bump is
missing). ⛔ Not `git ls-remote`: the gate never fetches.

> ⛔ **`git show <ref>:<submodule path> > file` leaves a ZERO-BYTE file behind**, so a positive
> control built from it reports 0. Extract INSIDE the submodule and check the exit status:
> `git -C libs/papercusp show "HEAD:plugins/design-phase/index.cjs" > /tmp/before.cjs || { echo EXTRACT-FAILED; exit 1; }`

> ⚠ **Equal blobs prove that PATH is current — NOT that the candidate is**: the gitlink can move
> under an unchanged test blob. Diff the gitlinks too: `git diff --raw <sha> staging | grep '^:160000'`
> (a superproject `git diff -- <sub>/<file>` prints nothing).

Manual fallback: [git evidence and containment recipes](/internal/docs/agent-insights/git-evidence-and-containment-recipes).

Get this wrong and you wait on a push that was never blocking, or fire a manual
`release:checkpoint-run` that **discards a live auto-refire rescue** and costs a ~55min suite.

**Corroboration requires independent EVIDENCE, not independent recall.** This section's claim is pinned to the code by `packages/operator-core/lib/doc-claims/gate-candidate-ref.test.ts`.

⚠⚠ **STEP 0 FIRST — establish WHICH sha is actually being judged.**

✅ **ONE CALL ANSWERS STEP 0 AND STEP 1 TOGETHER — do this before you write any SQL:**

```
state:read { cell: 'gate.greenCheckpoint.candidate', as: '<your repo-relative path>' }
```

It returns the judged sha plus **`source.authoritative` — read that FIRST** (a `run-probe` reading is an *inference*). Everything below is the FALLBACK for when it answers `unknown`: [reading pipeline state](/internal/docs/agent-insights/reading-pipeline-state-position-health-nextaction).

## Ratified designs: implementation owes current passing visual evidence

## Ratified designs owe current passing visual evidence

After `design-phase.ratify_reference`, completion owes current passing `design-phase.compare_render` evidence for every case; inspect with `design-phase.get_design_evidence`. Each viewport/theme/state needs its own reference. Only engine verdicts count. Resolve missing, stale, invalid, and failing cases; visual parity never replaces responsive, interaction, functional, or accessibility checks. Explicitly retract obsolete references. While enforcement is report-only, treat returned `designEvidence` refusals as blocking.


## Commit discipline: git-sync owns commit + push — you do neither

🚨 **Never fire a manual `release:checkpoint-run` while a run is in its re-triage window** —
that window voids a STALE red and re-fires onto a newer tip; killing it discards the rescue and
costs a full suite.

✅ **You no longer have to remember to check — the verb refuses with the answer:** its `already_running` reply leads with `🚨 AUTO-REFIRE IN FLIGHT — STAND DOWN` when a refire is in flight for THAT run, names both candidates and the files the abandoned red named; `in_flight_retriage: null` means "no refire in flight", never "unknown".

⚠ And when it does re-fire: **a passing affected-tests suite is NOT a green gate** — the
lint/perf/desktop/delta gates and the `main` fast-forward still have to clear.

## Gate failure triage — re-run named files individually

`GATE_HELD_BY` / `AFFECTED_TESTS_FAILING_FILES` are a list of candidates, not proof that every
named file is failing at the current HEAD. Re-verify each path in its own invocation (for
example, `npm run test:file -- <one-path>`; with `testing:run`, submit one file per call).
A multi-file Vitest invocation can abort during collection when one file's mock or module graph
crashes, so its result must not be attributed to every requested path.

If a batch emits `TEST_FILE_ROUTE_ERROR` or `matched=0`, treat the result as **undetermined**:
zero files were measured. Re-run the paths individually and attribute red/green/fixed status
only from those per-file results. Never use a batch `matched=0` as evidence that the named files
are red, green, or fixed.

⛔ **A PASS at tip is NOT proof the verdict was stale** — the one containment trap that runs the
*other* direction. `test:file` runs the WORKING TREE, so a peer's uncommitted fix is silently in
your run: the file passes, you record "stale", and the gate keeps failing on the COMMITTED blob it
judged. The router stamps this for you — read its `TEST_FILE_PROVENANCE … uncommitted=N` banner and
the per-path `[DIRTY …]` / `[UNTRACKED …]` labels — and compare any non-clean path against the
judged candidate before calling it stale. ⚠ For a SUBMODULE path do that **inside** the submodule
(`git -C <sub> show <pin>:<repo-relative path>`): from the superproject `git status`/`git show`
answer about the gitlink and report nothing, so the one check that catches this returns empty.

⛔ **The converse holds too: a FAIL in the shared tree is NOT proof the leg is really red.** Some
suites assert over the LIVE WORKING TREE itself (`REAL TREE …`, shrink-only-baseline guards) while
dozens of agents mutate it and the gate judges an isolated clean checkout — the populations differ
by construction (EI-23817115274707255: ~26 failures across 18 unrelated files on the `lane-stateful`
leg). Read the gate run's OWN result (`state:read { cell:'gate.greenCheckpoint.candidateFailures' }`,
or `testing:runs { status:["fail","error"] }` `outputTail`) and never loosen such a guard. Tells it is
not substantive: process-level termination (SIGKILL/SIGTERM, per-file durations pinned at one
constant) and ZERO `Test timed out` strings. Before reproducing a HEAVY leg run
`node scripts/proc-guard.mjs check green-checkpoint` — a repro beside the gate's own run can cause
that signature. Leg-specific: `lint:tsc` reproduces faithfully.


## Server-side edits and the two-port model — no hot-reload

The Hono host (`bin/hono-host.ts`, MCP tools, `lib/endpoint-route`,
`apps/operator/lib/**`) has **no file-watch**, and on the dev box a `:3070`
restart does **NOT** pick up your edits:

- **`:3070`** = GREEN operator, runs from the **release checkout**
  (`papercup-release`, `main`). 

(`:3055` Vite *does* hot-reload.) Probe where the write actually lands; if it's
stale, restart the *right* host and re-probe. Detail:
[repo-conventions § two-port model](/internal/docs/system/repo-conventions).

⚠ **The MCP client URL does not prove which build served a call.** The `papercusp-su`
client connects through `http://127.0.0.1:9071/api/mcp`; the proxy's default upstream
is `:3070`, but the serving host is recorded separately for each tool invocation.
Records have shown the same owner served by both `port-3070` and `port-3170`. For a
specific call, use `dev:pg_query` to query `harness_shared.tool_invocations` by
`coord_owner_id`, `tool_name`, and `invoked_at`; read `serving_host` and
`serving_build_sha`. The writer captures the service and loaded build at invocation
time (`packages/operator-core/lib/projected-tool-deps.ts`), unlike the proxy URL or
current checkout. Compare that SHA with `/api/health` on the recorded host before
treating a route-level result as current.

Confirm which build an endpoint runs from its **health sha** — never a proxy's cwd or
boot time, which describe the proxy, not the code it forwards to:
`for p in 9071 3070 3170; do curl -s 127.0.0.1:$p/api/health; done`

⚠ **`:3170` is not the canonical working tree.** It serves an isolated generation of
the canonical tree's LOCAL committed `staging` (`sync-staging-checkout.sh` resolves
`rev-parse staging`, not `origin/staging`): an uncommitted or git-sync-held edit is
invisible there; a committed-but-unpushed one is not. `papercup-staging-sync.timer`
advances it every ~5 min, deferring while `:3170` has live clients until the build is
1800s old (journal: `Will advance to <sha>`); `dev:restart { target: 'staging' }`
only relaunches the same generation. Test uncommitted work with focused tests. Once
`:3170`'s `/api/health` build contains your change, exercise the real MCP surface:
`POST http://127.0.0.1:3170/api/mcp?superuser=1&client=$PAPERCUSP_SID&workspace=…`.
Run the identical sequence against `:3070` for an A/B whose only variable is the
build. Worked example:
[the :3170-vs-:3070 A/B](/internal/docs/agent-insights/connection-closed-6432-is-an-idle-tx-kill-not-pgbouncer).
⚠ Never bind a long-lived session's MCP to `:3170` — it restarts ~200×/day.


## Before you design or test — read the docs first

Two `/internal/docs` sections are **required reading before the corresponding
work**, not optional references. Check them *first*, then act:

- **Before ANY design work** — new or changed UI, an API/schema shape, an
  architecture, or a new durable surface (component, tool, table, service) —
  read the **design docs** at [`/internal/docs/design`](/internal/docs/design)
  and check the `design-phase:*` tools (the DTCG token set + component registry)
  for what already exists. Don't hand-roll a design without checking the system
  first.
- **Before ANY testing work** — writing, adding, or changing tests, or verifying
  behavior — read the **testing docs** at
  [`/internal/docs/testing`](/internal/docs/testing) (+
  [`/internal/docs/testing/agent-e2e`](/internal/docs/testing/agent-e2e) for UI).
  They say which of the four canonical frameworks to use and how (see also
  "Where new tests go" below).

## Read this before changing code — performance anti-patterns

Performance regressions here repeatedly come from the same small set of patterns
(serial fs loops, per-slug PG-pool opens, `<details>` gating, duplicate React
keys, stale Radix pointer-events overrides, …). **Read
`/internal/docs/performance` before any non-trivial change** — especially the
"What NOT to do" sections (A1–A14). If your change matches an anti-pattern,
change the approach first.

## Storage policy: Postgres by default

**New durable state goes in Postgres unless there is a specific reason it must
be a file.** No plain-JSON state files, no module-scoped TTL `Map`s, no "PG
mirror with file primary". Helpers: `packages/operator-core/lib/operator-state-pg.ts`.

- **Schema = migrations only; NO runtime DDL.** ⚠ **Pick the migration number via the atomic allocator — NEVER `ls sql/ | tail` by eye.** On this parallel fleet two agents racing an `ls`-then-write gap WILL pick the same NNN. Run `node scripts/next-migration.mjs --name <slug> --intent "..."` (or `npm run db:next-migration --`) FIRST — it reserves the number under an advisory lock (`harness_shared.migration_reservations`) and prints a `.DRAFT`-suffixed path.

  **Write and iterate at that `.DRAFT` path, not the bare `.sql` name**: the runner only applies files matching `*.sql`, so a `.DRAFT` file is invisible to boot auto-apply / `db:migrate` / the green-checkpoint preflight while you edit it — including a deliberate temporary both-ways guard-test mutation, which otherwise races the operator's auto-apply and can execute half-finished SQL against the live DB. When it is finished and tested, ARM it with the printed `arm_command` (`next-migration.mjs --arm <draft>`: it lints like boot, then publishes `libs/papercusp/libs/db/sql/<NNN>-…sql`, ≥107) — never a hand `mv`, which skips the lint (WI-10006549). Then run `libs/papercusp/libs/db/scripts/pull-schema.mjs`. Never an `ensureXxx()` / inline `CREATE TABLE`. `000-baseline.sql` is frozen/generated.
- **Never hardcode `localhost:5432`** — resolve via `getHarnessAdminUrl()`. Embedded-pg is the ship target; the dev box runs native PG on `:5432`.
- **Reading PG-canonical state? Query PG — don't dump-and-jq a projection.** Plans, work-items, issues, observations (`engineer_issues`), `tool_invocations`, scorecards and recipes live in Postgres; the `*:list` tools are projections. Plan Markdown is stored in PG and can be exported on demand; any on-disk mirror is optional, generated from PG, and may be absent. `dev:pg_query` is for **genuinely ad-hoc / analytic** reads (a one-off group-by, join, or recency slice you won't repeat). A HOT read with a stable shape belongs behind a TOOL that wraps the canonical SQL so it can't drift — "what's claimable" is `work_items:claimable`, NOT a raw floor query.


**Before you write `SELECT`, check this table** — these are the reads agents most often hand-write, and each already has a tool that scopes + applies the real semantics. (`dev:pg_query` echoes the same routing as a `See also:` line on every result.)

| you want | use | not |
|---|---|---|
| how many tests fail on the **frozen candidate** | `state:read { cell:'gate.greenCheckpoint.candidateFailures' }` — read `stillBrokenCount` (files with NO fix yet), not `failingFileCount`; `fixInRepairHead` says whether a file's fix already landed | ANY hand-written `test_runs` query — it mixes THREE populations and only one judges the candidate; aggregating them reports fleet churn as the gate's verdict |
| what issue-family work is claimable now | `work_items:claimable { harness }` | `WHERE status='open'` / the `work_items_claimable` view (overcounts ~13×) |
| a filtered work-item / issue slice | `work_items:list` (server-side filters) | a hand-written `harness_shared.work_items` query |
| what plans exist / the recent ones | `plans:list { updatedSince, createdSince, order, limit }` — `order` is `'updated'\|'created'\|'slug'` (NOT `'recent'` — that is `invalid_input`) | a hand-written `harness_plans` query |
| plan COUNTS (by status / harness / day) | `plans:list { groupBy, aggregateOnly }` | a hand-written `GROUP BY` |
| pickable plan items across plans | `plans:items { actionable: true }` | unnesting the items jsonb |
| prose / full-text | exact phrase → `search:fulltext`; paraphrased concept → `search:semantic` | `ILIKE '%…%'` |
| definition, references, type truth | `lsp:query` (compiler semantics) | `grep` for a declaration — cannot resolve shadowing or re-exports |
| call chains, impact radius, topology | `graph:query` with `op:'context'`, `op:'impact'` or `op:'trace'` and bounded `paths`; first-party JS/TS syntax/compiler evidence, with coverage limits and no runtime-execution claim | `gitnexus.query` fails closed before dispatch (D-065); unranked noise was a historical result (D-021) |
| who CALLS this symbol | `graph:query { op:'callers', name }` — `line1` call sites, no definition; index may be stale. **Empty is not proof of no callers**: measured needs-widening, held at observe, deferred to WI-10006543. | `gitnexus.impact { direction:'callers' }` — unsupported (only `upstream`/`downstream`/`both`); returns callees as `epistemic:"exact"`. |

Optional internal `gitnexus.context` / `gitnexus.impact` remain under `gitnexus-deterministic-integration-2026-10-05#D-005`; they are not the native default. D-004 still excludes GitNexus from shipped dependencies and installers.

⚠ **If `gate.greenCheckpoint.candidateFailures` is unavailable, the ONLY query that answers it is scoped to one population — and the blob check is half the answer:**

```sql
SELECT file_path, status FROM harness_shared.test_runs
 WHERE source='ci' AND worktree_dirty=false AND commit_sha='<the frozen candidate sha>'
   AND status IN ('fail','error');   -- 'failed'/'passed' can NEVER match
```

Then per path, `git rev-parse <candidate>:<path>` vs `git rev-parse <repairHead>:<path>`: **DIFFERENT blobs mean the fix ALREADY LANDED** and the file awaits re-verification, not repair. Equal blobs are the real queue. For a SUBMODULE path the blobs are identical while the gitlink moved — use `git diff --raw <candidate> <repairHead> -- <sub> | grep '^:160000'`. And `filesJudged` is the AFFECTED RADIUS, never the ~6,700-file suite: an empty failing list is **not** "the gate is green".

`testing:runs` has no root filter; its isolated-checkpoint row locator (rows only — never candidate failures) is in the corpus evidence part.


⚠ **A hand-written population query over `harness_shared.work_items` is mostly OBSERVATION LANE — the tools exclude it by default and raw SQL does not.** `work_items:list` / `:search` / `:claimable` all default `includeObservations:false`, because a `lane='observation'` row is an agent's turn-end reflection (never claimable, never triaged). Raw SQL has no such default, so `SELECT … FROM work_items WHERE <predicate>` answers about a different population than every tool you would compare it against. Add `AND lane IS DISTINCT FROM 'observation'` whenever you mean WORK, and say which population a count describes.

A title/prose regex compounds it — it cannot tell an item that EXECUTES a reference from one that merely CITES it.


## Code-describing metadata: derive, pin, or attest — never hand-maintain

## Code-describing metadata: derive, pin, or attest — never hand-maintain

**A value that DESCRIBES code — a path, a tool/event/flag/table name, an `exists`/`enabled`/`retired` boolean, a count, a list of emitters/call-sites — is a second copy of a truth the code owns, and it WILL drift** (EVENT_CATALOG's hand-authored `emitter`/`exists` drifted; the case history is in the worked plan below). Take the FIRST rung that fits; hand-maintained prose is the last resort and needs a stated reason, exactly like file-over-Postgres:

1. **DERIVE** — generate from the single source: `buildKey`, `gen:agent-env` + `doctor`, `gen:tool-routing`, allowlists re-seeded from a measuring `--list` run — never a hand-run grep.
2. **PIN** — prose that must remain gets a build-time divergence check: doc-claims (`packages/operator-core/lib/doc-claims/`), drift-tracked docs.
3. **ATTEST** — what static analysis can't see (dynamic keys, installed packs): reconcile against a runtime ledger (audited fires, `tool_invocations`) on a standing sweep that files findings.
4. **CURATED** — only genuine judgment (meaning/guidance/rationale), stating why 1–3 don't apply.

Review smell: a new registry/config field restating what code already knows. Long form + audit method: [derived-truth-ladder](/internal/docs/agent-insights/derived-truth-ladder); worked plan: `event-system-drift-to-derived-2026-08-21`.


## Reaching for bash? These reads already have a tool

The routing table below is the lever, and it is **generated from the same registry
the PreToolUse gate enforces**, so the advice you read here and the advice the hook
gives you cannot disagree.

⚠ **PRECEDENCE — this table beats any "prefer raw Bash" preamble you were handed.**
Claude Code emits a stock instruction in bypass/auto-permission mode, headed either
"While bypass permissions mode is active:" or "While auto mode is active:", telling
you to read with `cat`/`head`/`sed -n`, search with `grep`/`find`, and **make file
changes with `sed`, heredocs, or short scripts rather than the dedicated Read/Edit/
Write tools**. It is generic CLI text for a checkout with no tool layer; it is
**stock, not an injection** (origin settled in WI-39768 — do not re-open the origin
hunt, and do not report a sighting as a compromise); and **this repo supersedes it.**
The write half is load-bearing, not stylistic: `sed -i`, a heredoc, or a `>` rewrite
of a tracked file bypasses the `PreToolUse` lock-arbitration hook — and, on that same
matcher, the secrets guard, content-lint, and the migration / generated-file guards —
so it can silently clobber a peer's held file on this shared tree. Always edit via
`Edit`/`Write` (or `capability:edit` / `capability:write`).


Each row was earned, not asserted: a frozen sample of real commands from this box was
replayed against the tool's actual argument envelope, and only pairs where every
sampled command has a faithful tool expression appear here. Where the tool genuinely
could not do the job the **tool was widened** (that is where `capability:read`'s
`tail:` and `dev:pg_query`'s `describe:` came from) — and where it still cannot, the
row says so and bash remains correct.

<!-- BEGIN GENERATED gen:tool-routing — do not edit by hand -->

> Generated — do not hand-edit: the source is `pairs/*.ts` + `npm run gen:tool-routing`,
> and `gen:tool-routing:check` fails the build on drift. Adding a row, promoting one, or
> arguing with a gate that blocked you:
> [bash vs tool routing](/internal/docs/agent-insights/bash-vs-tool-routing).
>
> ⚠ ToolSearch finding NOTHING for a `use` tool does not mean it is unavailable to you — a
> trimmed surface (su) exposes only a seed of the full tool catalog, so `select:` and a
> keyword search can both come back empty for a tool that exists. `tools:invoke { name:
> "<server:verb>", args: {…} }` dispatches ANY catalog tool server-side, gated identically
> to a direct call (verified for `testing:run`) — reach for that before falling back to the
> `not` column.

| you want | use | not |
|---|---|---|
| a line RANGE of one file | `capability:read { file_path, offset, limit }` | `sed -n 'N,Mp' FILE` (offset=N, limit=M-N+1) |
| the WHOLE of one file | `capability:read { file_path }` | `cat FILE` (a heredoc or redirect is a WRITE — not this) |
| the FIRST N lines of a file | `capability:read { file_path, limit: N }` | `head -n N FILE` (a `… \| head` pipe filter is not this) |
| the LAST N lines of a file (a build / gate log tail) | `capability:read { file_path, tail: N }` | `tail -n N FILE` (`tail -f` streaming has no tool form — keep using bash) |
| a one-off SELECT against the OPERATOR database | `dev:pg_query { sql }` (read-only txn + row cap + statement_timeout) | `psql -d papercusp -c "SELECT …"`. ⚠ ONLY the operator DB — a `$VAR`/other-database connection has NO tool form, so keep using psql for those rather than risk querying the WRONG database |
| a table's columns / indexes / constraints | `dev:pg_query { describe: "schema.table" }` (a `*` glob lists relations) | `psql -c "\d table"` (`\df`/`\dn`/`\du` are other object classes — no tool form) |
| whether a systemd unit is active / failed | `dev:service_health { units:["<unit>"], scope }` — unitStates[].{loadState,activeState,active,failed} for any unit, plus unitsUnknown[] for ones systemd does not know; services[].up / supervision[].healthy for registered units | `systemctl --user is-active <unit>` — note it prints `inactive` for a unit that does not exist, which the tool reports as unitsUnknown instead |
| whether a local dev service is answering | `dev:service_health` — for the probed set (incl. :3170 staging), when you need only up/down | `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/api/health` — still required for :8788 and other unprobed ports, and whenever you read the body |
| what is listening on a TCP port / which process owns it | `dev:listening_ports { port }` (or `{ pid }` for the reverse lookup) — structured rows with pid, command and ownerVisible | `ss -ltnp` / `lsof -nP -iTCP:<port> -sTCP:LISTEN` / `netstat -tlnp`. ⚠ LISTEN sockets only — an established-connection query (`ss -tn`, `netstat -an`) or one lsof call spanning several ports still needs bash |
| to read git state (status/log/diff/show/rev-parse/merge-base) | `capability:git { args: ["log","--oneline","-5"], cwd? }` — argv, no shell, gated as git | `git log --oneline -5` — bash is not WRONG here; the gain is argv-safety and git-scoped gating. Shell-substituted argv (`git -C "$D" …`) has no tool form. For "is my edit live", prefer `dev:pipeline_position { path }` |
| to run specific test files and see which tests failed | `testing:run { files: [...] }` — spawns the router directly, so it never waits for a pc-heavy admission ticket | `npm run test:file -- <paths> 2>&1 \| tail -60` — pc-heavy-wrapped, so under load it queues behind every heavy job (measured: 14+ min without starting, one attempt killed SIGTERM/143 with ZERO output, vs 1471ms via the tool). A log-file redirect is not this — the tool writes no artifact |
| to run test files without hand-picking a Vitest config | `testing:run { files: [...] }` | `npx vitest run <path>` (a root-level run can match zero files and still exit 0 — the router refuses that) |
| a service's log lines in a time window, filtered | `logs:read { unit, since, grep?, level?, limit? }` (filter pushed down to `journalctl --grep`; repeats collapsed) | `journalctl --user -u <unit> --since <w> \| grep <pat> \| tail -n` (a streaming `-f` follow, a boot/cursor selection, or `sudo` elevation has no tool form — keep using bash for those) |
| to typecheck a project and see the errors | `build:typecheck { project: "packages/operator-core" }` | `npx tsc --noEmit -p <project> 2>&1 \| grep …` (the tool refuses a run that checked ZERO files — `-p .` does that here, and a `grep` over its one-line error prints nothing, which reads as clean) |
| the current date/time | `host.now` — already in your coord:orient payload (ISO-8601 UTC). Call nothing. ⚠ SNAPSHOT of when orient ran: on a LATER turn, or for any age/duration, use `date -u`. ⚠ UTC while this box renders LOCAL (-04:00) — put the other side in UTC (`TZ=UTC stat`) or you invent a phantom 4h gap. | `date` / `date -u` / `date +%s`. ⚠ a `$(date …)` substitution INSIDE another command is string interpolation — keep using bash; so is `date -d @<epoch>` (a different instant) |
| the load average / how busy the box is | `host.load` + `host.cores` — already in your coord:orient payload. Call nothing | `uptime` (`uptime -p` / `-s` ask for BOOT TIME — a different question, still bash) |
| how many CPU cores this machine has | `host.cores` — already in your coord:orient payload. Call nothing | `nproc` / `nproc --all` |
| free memory / whether the box is out of RAM | `host.memFreePct` + `host.psiMemSome60` — already in your coord:orient payload. Call nothing | `free -h` / `free -g` |
| to find where a symbol is DEFINED | `lsp:query { op: "workspace_symbols", name: "X", file: "<grep root>" }`; body: `capability:read` | `grep -rn "export function X" <one project dir>` (repo-wide: add `--exclude-dir={node_modules,.vitest-tmp,dist,coverage} --exclude-dir=sidecar` — generated bundles/caches are not source evidence; exhaustive exact-text search remains grep's job) |
| to install dependencies in this shared tree | `npm run install:safe` (or `npm run install:safe -- ci` / `-- install --legacy-peer-deps`) — serializes concurrent agents behind an fs-mutex, then verifies every declared dep actually landed on disk | a bare `npm install` / `npm ci` — including a named-package add — because it rewrites `node_modules/.bin` under every other agent's in-flight test run. ⚠ NOT claimed: explicit `--prefix` scratch installs or `--dry-run` |
| one relation's columns and their types | `dev:pg_query { describe: "schema.table" }` (same tool — also returns indexes, constraints and column comments) | a hand-written `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='…' AND table_name='…'`. ⚠ A column SEARCH across relations (`column_name ILIKE '%x%'`) has no describe form — keep querying the catalog for that |
| to FIND a relation whose name you half-remember | `dev:pg_query { describe: "*fragment*" }` — glob matched case-insensitively against `schema.name`; `{ describe: "schema.*" }` lists one schema | a hand-written `SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%fragment%'`. ⚠ Names only, one glob per call — an explicit `table_name IN (…)` list, a `table_type` filter, or anything else the catalog holds still wants information_schema |
| whether migration NNN applied, or the most recent migrations | `db:migrations { like: "795" }` — a bare number is a prefix match; an empty match returns a verdict (pending / draft-not-armed / no-such-migration) rather than an ambiguous zero rows | a hand-written `SELECT filename, applied_at FROM harness_shared.schema_migrations WHERE filename LIKE '795%'`. ⚠ One pattern per call — a `filename IN (…)` list, a POSIX-regex range (`~ '^(79[4-9])'`), `LIKE ANY (ARRAY[…])` or a `>= '750' AND < '760'` number range still wants SQL |
| a test file's run history, or which tests are failing | `testing:runs { filePath, status: ["fail","error"], sinceHours }` — typed status enum, and `outputTail` comes back on the red rows | `SELECT … FROM test_runs WHERE file_path LIKE '%x%' AND status='failed'` — ⚠ that literal can NEVER match (pass\|fail\|skip\|cancelled\|error\|running), so it reads as a clean "no failures". Aggregates, `DISTINCT ON`, an `output_tail` hunt, a `finished_at` window or `workspace_id IS NULL` still want SQL |
| to find filed issues by text, state, assignee or scope | `issues:list { q: "fragment", state, assignee, limit }` — `q` matches title + body, `rollup:"state"` gives counts over the whole filtered set | `SELECT … FROM engineer_issues WHERE title ILIKE '%x%'`. ⚠ NO id filter — a single-item read (`WHERE issue_id='WI-123'`) is `work_items:get { id }` — and no time-window arg, so a `created_at` slice, an OR of several fragments, a regex match, and `payload->`/terminal-column forensics stay SQL |
| the green-checkpoint gate's health (consecutive reds, observed candidate, whether a re-triage is in flight) | `routines:list { name: 'green-checkpoint', installSlug: '<your install>' }` — read `health.gate_health`, plus `nextFireAt` / `lastFiredAt`. ⚠ OMIT installSlug and EVERY install's row comes back (21 here, truncated to 12); row 1 is another pot's and reads healthy | a hand-written `SELECT metadata->'gate_health'->… FROM harness_shared.routines`. ⚠ Unprojected columns (`tier`, `concurrency`), cross-routine aggregates and JOINs still want SQL. "Is my change live" is dev:pipeline_position; the judged sha is state:read { cell:'gate.greenCheckpoint.candidate' } |
| one work-item (or up to 100) by id, including its terminal/authority columns | `work_items:get { id }` / `{ ids: [...] }` — whole row incl. terminalOwner, completionAuthority, plus holder + checkpoint; add payloadTier:"full" for payload/summary | a hand-written `SELECT … FROM work_items WHERE feature_id='EI-…'`. ⚠ `payload->` PREDICATES, `source_plan_slug` slices, aggregates and JOINs stay SQL |
| a filtered work-item / issue slice — text, state set, kind, assignee, plan of origin, or a created/updated window | `work_items:list { q, state, notTerminal, kind, assignee, sourcePlanSlug, createdSince, updatedSince, limit }` — add includeObservations:true to match a raw SELECT, and completionAuthority to list under-evidenced closes | `SELECT … WHERE title ILIKE '%x%'`, or `status NOT IN ('done',…)` — that IS `notTerminal`. ⚠ `q` is a literal substring over title+summary, not token search. No id filter; exclusive `>`/`now()` windows, non-union exclusions, source_plan_slug PROJECTION, aggregates and JOINs stay SQL |

<!-- END GENERATED gen:tool-routing -->

⚠ **A `head`-truncated search cannot support a NEGATIVE conclusion — "no callers exist" is precisely the verdict truncation manufactures.** Piping `grep -rn` into `head -N` is safe when you look FOR something (the first hit answers you) and unsound the moment you act on the ABSENCE of a hit: `head` cuts by POSITION and grep walks paths in directory order, so one noisy file (a test, a barrel, a docs blob) can fill the whole budget while the real production caller sits at N+1. The pattern is CORRECT and the match EXISTS — the output was simply cut before it, which is why the result looks like a clean negative rather than a failed search. Same family as the zero-work false-greens (`-t` matching zero tests, `pgrep -q`, a wrong-relation SQL zero-row, a `grep -r` that times out and prints nothing): an instrument that searched only part of the space, whose empty output is indistinguishable from a real absence.

- **Never bound a search whose EMPTY result you will act on.** For "does any caller exist", use `grep -rl` — one line per FILE, so 20 files fit in 20 lines instead of one file eating the budget — or `-c`; if you must bound it, `| wc -l` first so a truncated count is visible as a count.
- **Exclude the definition site when asking who CALLS this**: `| grep -v '<the lib dir>'` drops the definition, the barrel re-export, the docstrings and the tests in one move — both what you meant and what stops self-noise from crowding out the answer.



> @papercupai/papercusp-monorepo@0.0.1 set-doc-part
> tsx scripts/set-doc-part.ts --part-key reaching-for-bash-these-read-the-tool-call-is-al --show

The tool call is also cheaper: a structured result, no subprocess, nothing to re-parse. When a row caveat applies (a `tail -f` follow, a non-operator database, a `\du`), the bash form is the right answer — the gate will not fight you on those.

⚠ **No Papercusp tools at all? Read the refusal: four classes, four different doors.**

- **TRANSPORT** — no tools listed. Use `mcp-call` with your own `--client`; never let a write land under an anonymous identity.
- **DISCONNECTED** — tools worked, then calls refuse. Probe the same environment. Retry the original call only after a before-send refusal; if a write may have been sent, verify its outcome first.
- **TOOLLESS but connected** — run `node scripts/mcp-reconnect.mjs` from native Bash, then end the turn for host reconnect. Do not ask the owner to reconnect. If it remains broken or reports no host/refused ack/exit 3, request a carry-respawn; details are in the `#evidence` sibling.
- **IDENTITY `stale-artifact`** — transport changes cannot bypass server preflight. Read activation state; reconcile only when the process already runs the desired revision. Recovery is `coord:orient { afterCompaction: true }`; `mcp-call.mjs` CANNOT open this one.

Exact error meanings, commands, and branch evidence are in this part's `#evidence` sibling.


## `cd` outside the repo tree does NOT persist across Bash calls — a failed one silently falls back to the repo ROOT

**The Bash tool's own description says "the working directory persists between commands" — that is only true while you stay INSIDE this repo tree.** `cd /tmp/some-scratch-dir` succeeds and holds for the REST of that one call, but the *next* Bash call starts back at this repo's root, with a post-hoc `Shell cwd was reset to <repo root>` note on the PRIOR call's result — no warning before it runs, just after. A `cd` to a path still *inside* the tree genuinely persists across calls. The boundary is exactly "inside vs. outside this tree", not "cd never persists".

⚠ **The in-tree half is NOT the benign one — a persisted in-tree cwd changes which `package.json` a later ROOT `npm run <script>` resolves against.** npm walks up to the NEAREST enclosing workspace, so after a `cd packages/<pkg>/…` the root commands this guide prescribes — `test:affected`, `install:safe`, `doctor`, `gen:*`, `docs:rebuild`, `set-doc-part` — die with `npm error location …/packages/<pkg>` and `Missing script: "<name>"`. **The trap is the READING, not the error**: "Missing script" invites *"that script does not exist"* when the truth is *"wrong directory, and NOTHING was measured"* — so an agent mid-verification moves on believing it verified something.


**Why this is dangerous, not just surprising:** a multi-line script with no
`set -e` does NOT abort on a failed `cd` — it keeps executing every later line
in whatever directory it's actually sitting in. Combine the two: call 1's
`mkdir -p /tmp/x && cd /tmp/x` succeeds; call 2 opens with `cd /tmp/x` again
(cwd already reset to repo root) — if `/tmp/x` was never actually created (e.g.
call 1 was itself blocked by a `PreToolUse` gate before the `mkdir` ran), the
`cd` fails, prints "No such file or directory", and the REST of call 2's script
executes directly in **this shared monorepo root** instead of the intended
scratch dir. This is exactly how a `npm install <pkg>` meant for an isolated
scratch dir landed in the live tree and mutated shared `node_modules` while
other agents were working in it (repaired via `npm run install:safe`, no
lasting damage — but the near-miss is the point).

**The defensive pattern, every time a script leaves the repo tree:**
```bash
mkdir -p /tmp/my-scratch-dir && cd /tmp/my-scratch-dir || exit 1
```
`cd ... || exit 1` (or `set -e`) is the whole fix: a failed `cd` then kills the script
instead of falling through. Unsure where a PRIOR call left you? `pwd` first.

**For a `cd` that STAYS in the tree, don't leave one behind:** use a subshell,
`( cd packages/<pkg> && <cmd> )`, or re-anchor before a ROOT script:
```bash
root="$(git rev-parse --show-superproject-working-tree 2>/dev/null)"
[ -n "$root" ] || root="$(git rev-parse --show-toplevel)"
cd "$root" || exit 1
```
Test the VALUE's emptiness, never an exit status: from the superproject root
`--show-superproject-working-tree` prints an EMPTY string with exit 0. ⛔ So the
one-liner `cd "$(…superproject…)" || cd "$(…toplevel…)"` is a silent no-op there —
bash treats `cd ""` as success, the fallback never runs, and you stay where you were
with no signal (WI-10002083).


## Scratch probes: name the file `.mts`, not `.ts`

A one-off probe that imports repo modules belongs in the in-tree, gitignored
`.papercusp/scratch/` — it resolves workspace imports, where `/tmp` does not. **Name it `.mts`.**

Neither location sits under a `package.json` declaring `"type": "module"`, so tsx/esbuild compiles a
bare `.ts` there as **CJS**, and any top-level `await` — the natural way to write
`const { fn } = await import('file:///.../module.ts')` to measure something against the real
implementation — dies at transform time with:

```
ERROR: Top-level await is currently not supported with the "cjs" output format
```

⚠ **The error names the OUTPUT FORMAT, not the fix.** It reads as a problem with your code, so the
natural next moves are all wrong ones: hunt for an esbuild/tsconfig knob, or restructure the probe
into an `async main()` with a `.catch`. Nothing in the code is wrong. Rename `probe.ts` → `probe.mts`
and it runs unchanged.


## Long jobs: background them at the LAUNCH, don't poll for them afterwards

**"Is my job done?" is 12% of every bash call on this box** — ~2,950 calls in 7
days across 63 of 86 sessions: `ps`/`pgrep` (2,315), polling a task-output file
with `cat`/`tail`/`wc -c` (1,120), and bare `sleep` (1,082, and what follows a
sleep is overwhelmingly another poll). None of that is recoverable by swapping
the poll command, because the fix is one step earlier:

> For anything that runs longer than ~1–2 min, start it with
> **`capability:bash { run_in_background: true }`** and read it with
> **`capability:bash_output { bash_id, filter }`** — only matching lines enter your context.
>
> ⚠ **Duration is not the only trigger — LIFETIME is.** A process that makes an owner-facing
> deliverable VALID (an OAuth flow, a callback listener, a tunnel) must be backgrounded however
> short it is: a CLI child dies with your session, and every carry-respawn is a session death.

⚠ **Filter background output at READ TIME, never at LAUNCH TIME** — a launch pipeline
(`cmd | grep …`, `| head`) can leave the durable log empty if the job is killed before the
consumer flushes.

⚠ **Never wait on a process-table pattern you typed yourself.** `until ! pgrep -f '<pat>'; do sleep 5; done` can NEVER exit from an agent shell: your own `bash -c` argv contains the pattern, so the poll matches ITSELF (`grep -v grep` does not save you, and across `ssh host '… pgrep -f …'` it can kill the remote shell — a silent `exit 255`). Wait on the PID (`tail --pid=<pid> -f /dev/null`, or `kill -0 <pid>`), or bracket the first character: `pgrep -f '[l]int-tsc'`.

✅ **The purpose-built tool for a managed task is `processes:list { live:true }`.** For a host-visible shell, `node scripts/proc-guard.mjs check <pattern>` excludes your own ancestor chain, so it cannot self-match. ⚠ `capability:bash` can run in its own PID namespace: there `proc-guard` exits 2, and an empty `pgrep` or a missing `/proc/<pid>` says nothing about host liveness.

⚠ **Three `find` traps on this box return a CONFIDENT, WELL-FORMED EMPTY result:** (1) bfs `-newermt` rejects human-relative values and can silently mis-parse absolute ones — use `git status --porcelain`, `TZ=UTC stat -c '%y %n' <paths>`, or an `@<unix-seconds>` predicate with stderr visible; (2) symlinked sibling hives (e.g. `sidestage`) are skipped without `-L` — prefer `git ls-files` / `grep -rl`; (3) ⛔ but NEVER an UNBOUNDED `find -L` over a broad root (`~`, `~/.papercusp`, `~/papercupai-workspace`) — it never finishes (WI-10000836): `find -L <root> -maxdepth 6 -name node_modules -prune -o -name '<file>' -print`.

**AN ABSENCE CLAIM NEEDS A POSITIVE CONTROL** — first run the same search for something you KNOW is in that haystack.

⚠⚠ **`pgrep -q` DOES NOT EXIST on this box** — `pgrep -qf X && echo ALIVE || echo gone`
prints **`gone`** on the usage error while the process is alive. Use `proc-guard` above,
`pgrep -cf` (count), `pgrep -x <name>`, or `kill -0 <pid>` (EI-19446554284039165).

⚠⚠ **The same self-match trap exists in SQL, and the bracket fix does NOT transfer.** A `pg_stat_activity` probe filtered by `query LIKE '%pattern%'` **matches its own backend**, and Postgres matches `'%[p]attern%'` literally. Exclude yourself with `AND pid <> pg_backend_pid()`, or use **`dev:pg_active_queries`**, which takes no pattern and already excludes itself.

> ⚠ `pgrep -x` matches `/proc/<pid>/comm`, which the kernel truncates to **15
> chars**, so a longer binary name never matches. 

✅ **"Is this process actually DOING WORK right now?" — a two-sample delta over the
process's CGROUP, never a single-shot reading** (`ps -o %cpu` is a process-LIFETIME average).

The runnable recipe, and the two `/proc` methods that each report a confident FALSE IDLE on a
process burning a full core:
[is this process actually doing work?](/internal/docs/agent-insights/is-this-process-actually-doing-work).


⚠ **Measure the whole PROCESS TREE, not the pid you were handed** — a `MainPID` is often a wrapper sitting at `utime=0` while a child burns a full core.


⚠ Corollary: **a liveness beat emitted BY the process being judged cannot report main-thread saturation** — a saturated Node main thread stops every `setInterval` while looking perfectly asynchronous. Observe from OUTSIDE (`/proc`).


## Feature flags + PostHog

**Feature flags have one source:** `libs/flags/src/types.ts`; flip them via `/admin/features`, never JSON/PostHog directly or an ad-hoc env boolean. New flags default enabled: finished work must set the code default ON and verify it live in the same task—an override-only flip or "owner later" is unfinished. Default-OFF is only for incomplete/unsafe code, owner-authority/security/destructive surfaces, or an attended cutover kill-switch. Put every exception in `KNOWN_DARK_FLAGS` with justification and `DARK_FLAGS_REVIEW_BY`, and surface it in plan `## Now` plus completion. Reversibility is a reason to verify ON, not ship dead code.


⛔ **The dark allowlist is SHRINK-ONLY — never reconstruct or grow it, and never build a parallel one.** `KNOWN_DARK_FLAGS` exists ONLY to express the small set of genuinely-not-ready exceptions above (incomplete code / would-break-the-running-fleet / owner-authority / staged-cutover) — it is **NOT a parking lot for finished work**. `DarkCase` splits the set into two populations governed differently: the `DARK_FLAGS_HIGH_WATERMARK` size ceiling in `libs/flags/src/types.ts` (imported by `production-defaults.test.ts`) governs ONLY the **`parked`/`incomplete`** subset (`DARK_FLAGS_PARKING_COUNT`) — the actual parking-lot abuse; it **fails the build if THAT subset grows**, not the aggregate `DARK_FLAGS.size`. `owner-authority` / `cutover` entries (permanent or staged safety kill-switches) are **not rationed** by the watermark at all — they are governed only by the `DARK_FLAGS_REVIEW_BY` re-review date, so a legitimate new safety flag never has to fight a parking-lot budget. So: flipping a `parked`/`incomplete` flag ON *removes* its allowlist entry (the parking subset shrinks ✓); shipping a NEW genuinely-incomplete flag dark requires first **graduating an existing parked/incomplete dark flag** to make room (net-zero) or **explicit owner sign-off** to raise the watermark — never a quiet append. **Do NOT route around this guard** by re-introducing a second dark allowlist, a per-flag `process.env.PAPERCUSP_*` gate, a `darkReason` side-table, or any other parking-lot for finished-but-scary work: the temptation to park it dark "to verify later" is *exactly* the abuse this exists to stop — flipping it on and watching it work IS the task.

## Tests after editing

```bash
# Pass one comma-delimited value after `--changed-paths=` for YOUR radius.
npm run test:affected -- --changed-paths=path/to/first.ts,path/to/second.ts   # YOUR radius
npm run test:affected                  # unit only — the WHOLE tree's radius, not yours
npm run test:affected:integration      # also runs *.integration.test.ts
npm run lint:tsc -- --files=<the files you edited>   # TYPES — vitest does not typecheck
```

⚠ **ORDER MATTERS: typecheck LAST, after your FINAL edit — including the edit you made
to fix a failing test.** Vitest transforms via esbuild and never typechecks, so a green run
carries ZERO type information and an earlier clean typecheck never covered the last edit.
Re-run `lint:tsc --files=` over the FULL changed set — source and test files — as the last
thing you do.

⚠ **The dual runs the other way too: a TYPECHECK cannot see a collapsed test fixture.** After a multi-site identifier rename (`replace_all`), a fixture that needs N *distinct* entities still typechecks once two collapse onto one id; only RUNNING it surfaces `Encountered two children with the same key`. Run BOTH for every workspace touched, and substitute a different REAL sibling rather than reusing the surviving id twice.

⚠ **`test:affected` runs the suites of the WORKSPACES your changed paths map into —
so "green" can mean "nothing ran". To see what your change actually selects, ask
`testing:run { changedPaths: [...] }` — the same derivation, ~0.4s, and NO pc-heavy
admission ticket (it returns the PLAN and runs nothing, so read `mode:"plan"` and never
as a verdict). Or run the probe directly:**


```bash
node scripts/affected-tests.mjs --changed-paths scripts/lint-tsc.mjs,libs/flags/src/types.ts --print-affected
```

It emits `AFFECTED_WS\t<workspace>`, `AFFECTED_WS_CMD\t<workspace>\t<command>` per selected
TASK, and `AFFECTED_GUARD\t<workspace>\t<script>\t<command>` for repo-wide guards (which may
appear with zero `AFFECTED_WS` lines).

⛔ **Run the emitted command; never rebuild one from the workspace name.** `npm run
--workspace <name> test` is WRONG for a standalone package (a submodule like
`papercusp-desktop`): npm answers `No workspaces found` and **exits 1 having measured ZERO
tests**. A workspace with no `AFFECTED_WS_CMD` line has no selected task.

⚠ **The probe takes `--changed-paths`; the RUN takes it too — use it, or you measure one
radius and run another.** A bare `npm run test:affected` derives its radius from git against
`origin/main` (often ~1,500 commits back on this shared tree), which is correct for the gate
and wrong for you. Every run opens with an `AFFECTED_DERIVATION source=…` line;
`source=explicit` is what verifying your own edit looks like.

⚠⚠ **A BARE `npm run lint:tsc` typechecks `packages/operator-core` ONLY**, so a clean bare
run says NOTHING about an edit anywhere else. **Always pass `--files=<the files you edited>`** —
that form ROUTES each path to the baseline-gated leg that OWNS it. Read the
`LINT_TSC_RESULT status=`, not just the exit code — `partial` is not `clean`.

**The trigger to watch: adding a REQUIRED field to a shared interface** (or renaming
/ re-typing one). 

**Don't do that by hand — `npm run lint:required-field-strands`** AST-diffs your change against `HEAD` and names every exported type that gained (or tightened to) a required field; `--typecheck` exits non-zero only on real stranded sites. ⚠ Do NOT "fix" the errors by making the new field optional.

**The behavioural sibling — adding a CALL to an injected collaborator strands call-COUNT
assertions in ANOTHER workspace**, and neither `lint:tsc` nor `test:affected` can see it
(WI-37582: ~3 gate reds). Rewriting a returned or persisted output property's value strands
assertions the same way. `npm run lint:behavioural-strands` is the detector (a PostToolUse hook
fires it at the edit; pin `--base <sha>` once git-sync has swept the edit). Read the EXIT CODE:
0 = checked, no strands · 1 = strands named · 2 = NOT CHECKED. If a downstream count assertion
fails, UPDATE the count — never delete or loosen it.

**A migration that ADDS a column to a `harness_shared` table can silently strand a
sibling `*.integration.test.ts` fixture** that hand-rolls that table via an inline
`CREATE TABLE`; `test:affected` won't select it.

Schema/migration edits (`libs/papercusp/libs/db/**`) → `npm run
test:integration-only` (integration suites only; the graph won't catch them).
Don't run `npm run test:all` for routine edits. Each app/lib ships a `TESTING.md` — read it
before adding tests. Infra (Vitest 4, testcontainers PG, Docker required, CI,
property tests, knip, quarantine, secrets):
[repo-conventions § test infrastructure](/internal/docs/system/repo-conventions).


**npm only — never `pnpm`/`yarn` in this repo, even for a single-package test
run.** This is an **npm workspaces** monorepo (root `package.json`'s
`preinstall` runs `only-allow npm`); there is no `pnpm-workspace.yaml`. 

```bash
npm run test:file -- path/to/one.test.ts path/to/two.integration.test.ts
```

## Proving a guard is falsifiable — never mutate the shared tree to do it

A guard test that has never failed is untested — but never prove it can fail by
mutating the shared tree: git-sync can commit the mutant mid-probe even when nothing
goes wrong, and no `trap` prevents that. Use **`scripts/mutation-probe.sh`**: copy-out
is the default (no dirty window); `--fake-destructive` for subjects that delete;
`--against-commit` / `--against-last-without` (historical mode) when the pre-fix source
is in Git; in-tree mutation only under a held `mutation probe` file lock. Exit `0`
means the mutant was CAUGHT — the guard is falsifiable.

The tier table, exit codes, invocation forms and the sweep-lock recipe:
[proving a guard is falsifiable](/internal/docs/agent-insights/proving-a-guard-is-falsifiable).


## Browser checks — use `verdict`

Ad-hoc/exploratory browser verification → the `verdict` skill, **not** Playwright
MCP tools or ad-hoc Puppeteer. Playwright is only for running/extending the
committed `apps/operator/e2e/*.spec.ts` suite. `verdict` is for
**arbitrary/external** pages — operator UI (`:3055`/`:3070`) is verified inside
the **Tauri shell** per `/internal/docs/testing/agent-e2e`, never by pointing
verdict at those ports.

## Use Context7 for current library docs

Before non-trivial APIs from third-party libraries (Tauri 2, Next.js 15, nuqs,
Hono, Radix, Vercel AI SDK, Vditor, BlockNote, …), call the `context7` MCP tools
(`resolve-library-id` → `get-library-docs`). Library APIs change faster than
training cutoffs; don't guess from memory.

## Adding a tool — the per-role guidance discipline

1. **Define** in `packages/operator-core/lib/agent-tools/<group>/<verb>.ts` (or
   `packages/agent-mcp/src/tools/...` for read-side).
2. **Import** it from `packages/operator-core/lib/agent-tools/index.ts`.
3. **Add `guidance: { when, notWhen?, chaining?, byRole? }`** 

   > It is a ROOT entrypoint that queues behind `scripts/pc-heavy.sh`, which is
   > what makes it runnable when you actually need it. To measure ONE tool
   > instead — seconds, no pc-heavy queue — **`npm run tool-weight -- <tool>`**
   > (`--json`; `--all` for the catalog). It prints the total AND the per-field
   > split (`description · when · notWhen · chaining · byRole`), so you cut the
   > field that is actually heavy instead of eyeballing it — the heavy one is
   > routinely `chaining`, not `description`.


> **Editing a live tool counts too.** In practice nearly every prompt-weight gate
> red has come from *growing* an existing tool's `description`/`guidance`, not from
> adding a new one — and an editor never reads an "Adding a tool" section, so the
> breach lands committed and freezes the fleet gate hours later. 

Per-tool when/not-when goes on the tool; cross-tool patterns in
`<role>.tools.md`; behavior rules in `<role>.persona.md`. The split is
intentional — see `packages/operator-core/lib/prompt-assembly.ts`.

⚠ **A caller's `limit` bounds ROW LISTS ONLY — never an aggregate. If a count is
computed over a capped fetch, the RESULT must say so ON THE AGGREGATE.** Marking
only the row list is not enough: the aggregate is what gets read as a verdict, and
a bounded measurement rendered as a confident number is indistinguishable from a
real zero. 

The fix pattern, both halves: pin the census fetch independently of the caller's
`limit` (`censusLimit`), and expose a boundedness marker beside the counts
(`truncatedByLimit`) so a floor is never read as a total. **Guard it behaviourally,
not by field name** 

## Prompts are auto-generated — edit the source, never the rendered output

Every agent-facing prompt is assembled at launch/spawn from sources: chat-surface
roles from `apps/operator/prompts/<role>.{persona,tools}.md` + the tool-guidance
catalog; psu playbooks from
`apps/operator/prompts/papercusp-su-{engineer,power}.tools.md` (which splice
THIS `CLAUDE.md` in as the Project guide — repo-convention changes belong here);
harness spawn prompts from `libs/papercusp/packages/harness/prompts/<role>.md`.
**Never edit rendered outputs** (`~/.papercusp/*-collaborator*.md`, anything
under `papercup-release`, captured prompts). Dev edits load immediately
(`PAPERCUSP_RELOAD_PROMPTS=1`). After a `<role>.tools.md` edit run
`npm run lint:tool-prompts`; after a substantial SU-playbook edit run
`npm --prefix apps/operator run llm-test -- --target su`. Long form:
[repo-conventions § prompts](/internal/docs/system/repo-conventions).

## Where new tests go — four canonical frameworks

Every new test goes in **exactly one** of: **Vitest**
`<package>/lib/**/<name>.test.ts` · **Playwright**
`apps/operator/e2e/<name>.spec.ts` · **Cargo** `#[cfg(test)]` · **LLM
scenarios** `packages/operator-core/lib/llm-testing/scenarios/<role>/`. **Never** new
`.mjs` integration scripts or tsx smoke scripts (CI lint P-038 fails the build).
`npm --prefix apps/operator run lint:tests` guards registry coverage — if it
fires for a new subsystem, widen a domain in
`packages/operator-core/lib/testing-domains-registry.ts` then `npm run
gen:contract` (root). See `/internal/docs/testing` §1.0a.
