# Performance remediation evidence

Plan: `papercusp-log-performance-remediation-2026-09-23`.
Driving work: WI-10002801. Measurement/producer work: WI-10002823 (P-001).
This is current-build implementation evidence, not final shipment acceptance.

## R172 operation timing and clean P006 tests — 2026-10-02

The changed r172 diagnostic passed preparation and boot, then failed its honest
performance assertion. Popup was 812 ms against 1500 ms; FCP was 1351 ms against
3000 ms; actual footer LCP was 4819 ms against 4000 ms. The matched footer queued
its first frame at 3162 ms and ran at 4692 ms, with about 1 ms of measured reads.
This sample supports small observer reads with a long queue interval. It does
not explain the prior 134 ms sample or establish a product/CPU cause.

The new operation rows were observed in native execution. The launcher logged
one isolated collection and published 25 measures; its JSONL was removed by
normal completion, so no retained row/hash claim is made. Official run
`20261002T080301Z-1987766`, raw hashes, summary and identity-bound cleanup are in
`r172TerminalDiagnosticCurrent` in the native audit JSON. All seven sampled
owned PIDs were absent, the exact nonce scan was empty, and owned private
profiles/HOME/tmpfs were removed. R-7 and its frozen cohort remain open.

Separately, P006 clean committed tests at `920030a3b939` passed all 41 tests
across three files with zero skips. Exact terminal rows 20499866, 20500782 and
20500781 record clean execution. Source hashes and the retained clone are in
[p006-current-clean-contracts-2026-10-02.json](p006-current-clean-contracts-2026-10-02.json).
Five maintained lifecycle fault controls each caught the named fault while the
independent calibration passed. Fresh one-to-one evidence was bound and selected
before twelve stale bindings were withdrawn; historical runs and the baseline
were preserved. The governing evaluator now passes BLOCKER@3 and TERMINAL@3.
Other P006 clauses, rubric ratification, scorecard reuse and shipment remain open.

## Shared target-schema readiness — 2026-10-02, Fire161

The maintained verifier now checks shared schema readiness before allocating its
work directory, copying dependencies or building the private API. It extends the
existing PG probe with `--require-applied-schema`, reuses the migration runner's
eligibility and numeric ordering, and reads the existing migration ledger through
a read-only connection. Pending and unavailable results refuse preparation with
distinct exits. The probe has bounded connection, query and process deadlines.
It sources the same operator `.env.local` as the launcher and prints a target
fingerprint rather than credentials. Ordinary launcher fallback and the isolated
PG route retain their existing behavior.

The registered Node suite passed 19 tests with no skips, including actual CLI and
shell fixtures. Eight new checks failed against the old source. The verifier's
eight focused files now have terminal passing ledger rows: seven passed in the
initial matrix; the source-snapshot suite passed all 26 tests after repairing its
stale admission-wrapper fixtures and line-continuation assertion. Syntax and diff
checks passed. Exact source/log hashes, commands and ledger IDs are retained in
`sharedSchemaReadinessFire161` in the native source/output audit JSON.

A bounded execution of the real preflight against the selected shared DB returned
ready, with no pending eligible migration files, during 07:43–07:44Z. That is a
dated read, not a future boot guarantee: recheck before another native attempt.
No native instance was launched, and there is no new popup, FCP or LCP result.
P-007/R-7 and the separate P-006/P-008 acceptance remain open.

## R171 boot failure recovery — 2026-10-02, Fire160

The newer Fire159 record supersedes the old unlaunched preparation note. R171
launched once with rebound manifest `c8473370b035`. The maintained verifier's
official result is **FAIL at boot**, with assertions blocked. WDIO never started;
there is no new popup, FCP, LCP, operation-partition or isolated-collection result.

The owned API's boot proof reported pending migration
`1339-session-gate-suppressed-ask-kind.sql` against backup-locked
`session_pending_gates`. Its request-only migration preflight timed out after
20 seconds and refused to serve. A native-addon abort followed that refusal;
the abort's independent mechanism remains unproven. Preparation had already
spent 324855 ms, followed by 269454 ms in the failed boot phase.

Current scoped cleanup checks recovered the exact per-launch nonce and found no
remaining processes bearing it. Both recorded API PIDs are absent; the owned
source snapshot and SPA copy are removed, while small logs remain. The assertion's
identity/result/native files, profiles, HOME and tmpfs root were never created.
This is exact-run cleanup evidence, not global process or port absence.

Before another expensive attempt, extend the existing PG probe and verifier
preflight to establish the selected shared target schema's readiness before
copy/build work. Reuse the migration runner's selection rules and ledger;
preserve its backup guard, ordinary launcher fallback and isolated-DB path.
This detector repair was pending at Fire160 and is verified above at Fire161.
No unchanged R171 replay is justified.

Exact result, manifest, log and cleanup references are under
`r171BootFailureRecoveredFire160` in the native source/output audit JSON.
P-007 cause, product repair, R-7 and the frozen cold/warm cohort remain open;
P-006/P-008 acceptance remains separate.

## First-frame observer operation guards — 2026-10-02, Fire154

The existing startup probe now records separate first-frame intervals for the
connection check, each ancestor's computed-style lookup, visibility properties
and parent traversal, then rectangle and viewport checks. Records remain
independent for footer and subtitle, are bounded to 99 per candidate, and are
never appended by later frames. The existing read and short-circuit order is
preserved. Throwing operations retain timing without exposing private errors.

Four new direct/bundled guards failed against the old aggregate-only probe.
A controlled fixture distinguishes 10 ms of style lookup, 13 ms of visibility
properties, 8 ms of traversal, 7 ms of rectangle reads and 24 ms of viewport
checks within a 62 ms interval. Separate guards cover exceptions, first-frame
retention, candidate independence and the 32-ancestor limit. These are controlled
observer measurements, not native rendering or product cause evidence.

The red run also exposed an existing fixture's fractional-clock equality:
Node returned 8636.999999999998 for a requested 8637 ms duration. An integer
fixture start removes that arithmetic nondeterminism while retaining the exact
assertion and production timing precision. The complete red result was
82 pass / 5 fail; the final maintained suite is **87/87 pass**, zero skips,
exit 0. Separate typechecking passed. Exact source/log fingerprints are under
`firstFrameOperationGuardsFire154` in the native source/output audit JSON.

r170's 134 ms aggregate remains unpartitioned historical evidence. Native
adoption, timing overhead and a paired observer-off comparison are unmeasured.
Fresh source/payload/manifest bindings and the logged isolated collection path
are required for one justified changed native diagnostic. P-007 root cause,
product, R-7 and its cold/warm cohort remain open; P-006/P-008 remain separate.

r171 preparation is now complete, with an independent preserved app/baseline,
two freshly compiled payloads and 21 current selected source/config bindings.
The manifest binds the 87-pass suite, separate typecheck, exact index and derived
assertion. Single early script, independent baseline identity, initially absent
private roots and Bash syntax checks passed. The assertion recovers only the
logged unique launcher collection and records whether it remains available;
it cannot adopt the former shared file. At Fire154 preparation time, r171 had
not launched. Its later failed boot is recorded above; exact preparation
fingerprints remain under `r171PreparationFire154` in the audit JSON.

## Isolated WDIO measure persistence — 2026-10-02, Fire152

The controlled launcher/worker regression confirmed the shared-file defect:
after launcher A recorded a failing interaction, launcher B's preparation reset
erased it. Both distinct and reused profile names reproduced the loss. JSONL
append safety protects simultaneous writes; it did not isolate separate runs.

The existing writer now allocates a fresh exclusive collection file before
preflight. Workers inherit its exact path; new launchers replace an inherited
prior-run path. Read, reset and publication operate only on that collection,
with no fallback to the former shared file. Failed publications retain their
own file. The runner logs the selected path so native evidence recovery can
bind it. Existing receipt schema and profile identity are unchanged.

The canonical Node suite went from **78 pass / 2 fail** to **83/83 pass**, zero
skips, exit 0. Separate package typechecking passed. Guards exercise overlapping
distinct, reused and unnamed profiles with actual worker forks, inherited-path
replacement, reset/read isolation, refusal of a stale legacy file and retention
of an unpublished prior receipt. Exact source and log fingerprints are under
`measurePersistenceIsolationFire152` in the native source/output audit JSON.

This establishes a persistence defect class and its guarded fix. It does not
establish historical receipt contamination or native adoption. No new native
run occurred. r170's terminal summary and cleanup hashes were recovered and
matched; its popup and LCP budgets remain failed. Its writer/config/test source
bindings are now historical. A later justified native preparation must bind
the new files and recover the logged collection path. P-007 cause, product,
R-7 and the cold/warm cohort remain open, as do separate P-006/P-008 acceptance.

## Fresh lifecycle diagnostic preparation — 2026-10-02, Fire149

Prepared r170 from an independent copy of the preserved app and raw baseline,
using the maintained startup and Web Vitals builders. The manifest binds 21
current source/config files, both compiled payloads, the shell, baseline, SPA
index, verifier and assertion. Exact source and log fingerprints recover the
78-pass v5 guard suite and its separate successful typecheck. Index reconstruction,
independent file identity, initially absent private roots and assertion syntax
checks passed before launch. The maintained desktop-native runtime route was read.

The one changed diagnostic completed **FAIL**, with verifier and suite exit 1.
Popup was **1937 ms** against 1500 ms, FCP was 1618 ms, and actual footer LCP
was **5341 ms** against 4000 ms. The footer's paired requests were queued at
4769 ms, its frame callback arrived at 4820 ms, its geometry read completed at
4954 ms, and its timer arrived at 5006 ms. The first read occupied 134 ms;
without an observer-off control this is a measured observer cost, not proof of
the product's initiating cause. Popup request/headers/response/content/preview
phases were 40/1289/1333/1355/1921 ms cumulatively from the click.

The v5 native trace retained one renderer zombie observation and then missing
procfs entries during suite completion. It preserved exact earlier lifetimes,
unknown signal/exit status, and `not-reaped` only at the zombie read. There was
no unexpected WebDriver session loss or popup timeout in this run. This proves
native detector adoption; r169's loss cause and native timeout-path adoption
remain unverified. Five owned PIDs and the source snapshot were absent before
cleanup. Exact tmpfs identity and retained logs matched. Only the owned profiles,
HOME, tmpfs logs and matched stale IPC socket/per-port advert were removed;
the peer's default advert was preserved. Port 33700 refused at that check.

The maintained writer uses one shared `results/measures.jsonl`, and its reset
removes that same file. A dated 25-row snapshot matches the emitted measurements;
it cannot establish isolation between concurrent named runs. Verify that class
with controlled launchers before the acceptance cohort and extend the existing
writer if needed. Media restrictions, observer work, distinct clocks, changing
private API and unknown original whole-SPA graph remain limits. P-007 cause,
product repair, R-7 and its frozen cold/warm cohort remain open; P-006 and P-008
acceptance remain separate. No unchanged native replay is authorized.

Exact preparation and terminal fingerprints, raw references and failure-class
audit are under `r170PreparationFire149` and `r170LifecycleTerminalFire149` in
`p007-native-source-output-audit-2026-10-01.json`. Preserved runtime artifacts
are under `$HOME/.papercusp/perf/p007-native-current/r170-*`.

## Native disappearance detector — 2026-10-02, Fire147

The maintained v4 sampler forgot previously observed identities when they
disappeared from descendant discovery. That detector gap prevented distinguishing
a missing procfs entry from an unreaped zombie, reparenting, PID replacement,
or incomplete discovery after r169 lost its WebDriver session.

The existing collector and sampler now retain at most 64 owned lifetime
references and perform two stat reads, bounded to 4096 bytes each, for identities
missing from the current sample. Their buffered observations distinguish
`procfs-missing`, `identity-replaced`, `same-identity-present`, `zombie`, and
`unavailable`. They preserve the last owned observation time. Signal and exit
code remain unknown because this sampler cannot wait on those targets; only
an observed zombie establishes `not-reaped`. Existing sample, byte, duration,
environment and output-descriptor bounds remain in effect. The v5 header
declares this evidence contract. No additional collector or service was added.

The baseline passed 71 tests. Six new fixture guards failed against the old
implementation. After the extension, one existing boot-race assertion still
failed because the new refusal message omitted identity/boot wording; correcting
that message preserved the refusal and restored the guard. The final maintained
Node suite passed **78/78**, zero skips, exit 0. Separate package typechecking
passed, exit 0. The real child-process regression observed a child before exit,
received SIGTERM in its actual parent, and verified that the running sampler
retained the exact missing identity while leaving signal and reaping unknown.

An intermediate commentary overstated the first green result by reading the
last typecheck command's shell status. That statement was immediately retracted;
the retained logs record the single failing unit assertion and the separately
run final checks. Commands, exact source/log fingerprints and the audit of the
r168/r169 measurement gaps are in `nativeLifecycleGuardFire147` in
`docs/evidence/p007-native-source-output-audit-2026-10-01.json`.

This is detector verification only. No new native popup run was launched in this
turn, and no crash cause, performance repair, R-7 acceptance or shipment is
claimed. The prior r169 result remains historical evidence on its original
sampler; its two changed sampler/test fingerprints now differ from current
source. The next native preparation must bind the v5 source and its verified
suite to a fresh owned artifact and manifest. P-007, P-006 and P-008 remain open.

## Paired callback result and native session failure — 2026-10-02, Fire146

Recovered r169 completed with verifier and suite exit 1; it was not replayed.
The actual LCP node joined the Accounts footer at **4716 ms**, with FCP at
1314 ms. Footer observation was at 3523 ms. Its paired requests were queued at
3524 ms, the frame callback arrived at 4578 ms, the geometry read completed at
4579 ms, and the companion timer arrived at 4723 ms. Both callbacks were late:
1054 ms for the frame and 1199 ms for the timer. The first geometry read took
1 ms. This contradicts the prompt-timer/frame-only hypothesis; it identifies
paired scheduling behavior without establishing its initiating cause.

WDIO then lost its session at spec line 121, before popup navigation. No popup
duration, attempt timeout or late-total observation was collected. The driver's
new timeout guard remains verified by its controlled tests, with native adoption
unverified for that path. Bounded journal/coredump reads for the owned app and
renderer during the failure window returned no records. The crash-or-hang label
and missing appsink warning do not establish a signal or cause.

The maintained v4 sampler records current owned descendants but has no
per-identity disappearance or exit-status observation. Its last app/renderer
snapshot spans 04:39:09.083–09.090Z. The first follow-up at 09.190–09.191Z
contains no process rows and an unavailable app `exe` read (`ENOENT`); later
samples contain no process or unavailable rows. This corrects the initial
overbroad audit wording: the first missing sample was unavailable, not clean
absence. It does not distinguish death, zombie/reaping, reparenting or loss
from discovery. The selected [upstream warning branch](https://chromium.googlesource.com/external/github.com/WebKit/webkit/+/f27346baf833b1134f43b57d859570103117aa87/Source/WebCore/platform/graphics/gstreamer/GStreamerSinksWorkarounds.cpp)
logs and returns false; that function does not abort. The upstream commit has
not been matched to the installed WebKit source, so it is a constraint on the
inference, not a native causal proof. The next detector change belongs in the
existing probe, with explicit unknown signal and process-reaping semantics.

All 16 prepared source fingerprints still match. The summary preserves the
raw logs, native process trace, API identity and exact hashes. Five owned PIDs,
the source snapshot and socket were absent before cleanup. The saved tmpfs
device/inode and log fingerprints matched; only r169's private HOME, profiles
and tmpfs logs were removed. Port 33700 refused at that cleanup check. The
default IPC advert belonged to another runtime and was preserved.

Evidence: `r169PairedTerminalFire146` in
`p007-native-source-output-audit-2026-10-01.json`, backed by
`$HOME/.papercusp/perf/p007-native-current/r169-native-summary.json`
(`a6082fa59c8d…`) and `r169-cleanup-receipt.json` (`9defeea88e92…`).
Current API identity, separate clocks, media suppression and observer work
remain confounds. Before another native attempt, audit the maintained crash
evidence path and add the justified causal detector or isolated preflight.
No unchanged r169 or earlier replay; cause, initiating caller, product repair,
R-7 and the frozen five-cold/five-warm cohort remain open.

## Popup timeout observation guard — 2026-10-02, Fire142

The maintained driver had a confirmed observation race: an eight-second wait
could expire before `endInteraction` emitted the completed measure and consumed
its start mark. The subsequent diagnostic read omitted completed measures, then
the classifier treated the absent mark as proof that timing never began. The
driver also retained previous phase measures when a new click never began timing.
This is a detector defect. The r168 log lacks the post-timeout total count and
phase start times needed to establish whether this race occurred in that run.
Its 13 saved raw-file fingerprints still match; no unchanged r168 was replayed.

The fix extends the existing classifier and `app-mount` driver helpers. Each
trigger clears prior phases and captures its page-clock boundary and synchronous
start. A single follow-up read attributes totals and phases to that start,
including their exact start times. Late completion retains its real duration.
An observed begin or current phase with a missing start and no total now fails
as inconclusive instead of being retried away as void. The generic failure text
no longer claims a dashboard never opened. The product's mark writers are unchanged.

Canonical classifier regressions reproduced **26 passed / 3 failed** before the
fix, then passed **29/29**, zero skips. Existing mark-writer tests passed **14/14**.
Maintained WDIO Node integration tests execute the serialized helpers against the
real User Timing API and real begin/phase/end writers. The first run caught an
injected `__name` dependency; inline callbacks removed it. The final suite passed
**71/71**, zero skips, and package typecheck passed. It retains an exact 8637 ms
completed measure after start consumption and excludes old or different-start
phases. These are controlled guard tests, not a new native performance sample.

Exact source/test/log fingerprints and commands are recorded under
`attemptTimeoutGuardFire142` in `p007-native-source-output-audit-2026-10-01.json`.
Next: prepare a fresh r169 payload/manifest with the current paired-timer sensor
and this driver, verify the owned runtime route and exact fingerprints, then run
one changed native diagnostic. P-007 cause, initiating caller, product repair,
R-7 and the frozen cold/warm cohort remain open; no shipment is claimed.

## Frame-first callback recovery — 2026-10-02, Fire139

The one changed r168 native run reached a startup measurement. Its popup attempt
timed out and its follow-up read found no start mark; it was classified
**UNMEASURABLE**. That read did not collect a total-measure count.
The pre-click scheduler log and request/preview phase measures are present, so
the earlier claim that its row never opened a dashboard was wrong. The classifier's
"never began timing" inference requires a writer/attempt-freshness audit; there is
no accepted popup timing. FCP was 1807 ms and LCP was 6642 ms. The actual LCP
node joined the Accounts footer: its frame request was at 4767 ms, callback at
6283 ms, and read completion at 6284 ms. Its companion timer was cancelled at
eligibility, so this run cannot compare timer and frame scheduling.

That cancellation originated in the probe's eligibility cleanup and callback
state check. The probe now preserves the independently queued timer after frame
eligibility, while explicit stop, replacement and the existing deadline still
cancel it. Two canonical regressions failed before the fix; **68 tests, zero
skips**, and the package typecheck pass afterward. This fixes the sensor lifetime,
not the product latency cause. The r168 payload and manifest remain dated proof;
they do not contain this later fix.

Exact runtime, raw hashes, cleanup and guard references are in
[the source audit](p007-native-source-output-audit-2026-10-01.json),
`r168PairedDiagnosticFire139`. Seven observed owned PIDs and the source/socket
were absent; owned private profiles/home and tmpfs logs were removed after
identity/hash checks. Port 33700 already accepted connections again at cleanup;
no signals were sent and no peer runtime was touched. P-007/R7 and separate
P-006/P-008 acceptance remain open. Audit current and selected frozen interaction
mark cleanup, phase provenance and timeout classification before another expensive
native run. The absence of a start mark at timeout does not establish no popup.

## Paired startup callback preparation — 2026-10-02, Fire135

The existing early probe now records the first frame request, one companion
zero-delay timer per candidate, the first frame callback, and completion of its
style/geometry reads. This distinguishes a prompt timer with a delayed frame
from two delayed callbacks or a costly read. These are callback observations;
they do not identify a main-thread, import or paint cause. Cancelled, unavailable
and overdue timer observations remain null.

The canonical WDIO Node suite passed **67 tests, zero skips**, after the three
new regressions failed against the previous source; the package typecheck passed.
Source `921941fe76dd`, test `d717c2a5cd28` and final unit log `ff10bca4f775`
bind this preparation. Fresh r168 early/Web Vitals payloads and an independent
saved SPA are bound by manifest `bcad7d1075d5` and assertion `59d77782439a`.
At that preparation boundary, no r168 native run had started. Baseline preparation caught one insertion newline
before compilation; recovery used the exact saved raw baseline and added an
assertion for its hash and absent probe marker.

Exact references, predictions and limits are in
[the source audit](p007-native-source-output-audit-2026-10-01.json),
`pairedFramePreparationFire135`. The leader's later observation that port 33700
was reused does not invalidate r167's dated cleanup receipt; it prevents a current
global port-absence claim. P-007 cause/product/R7 and the separate P-006/P-008
acceptance remain open. The next run must validate its own selected ports and
runtime identity, preserve failed cohorts, and join the actual LCP candidate.

## Measurement profiles

The original [audit](../audits/application-performance-audit-2026-09-23.md)
preserves SQL counter intervals, profile paths, native run/build identities and
metric writer references. Those historical means, maxima and individual UI
interactions must not be compared with new p95 values as a speedup.

The frozen observational baseline below covers **[2026-09-23T22:00:00Z,
2026-09-23T23:00:00Z)**, workspace `papercusp-workspace`. It contains naturally
occurring requests with uncontrolled concurrency and cache state. It is useful
for prioritization and population attribution; it is not a controlled benchmark.
Do not generate production traffic merely to enlarge the sample.

Controlled comparisons for P-002 through P-008 use the existing project fixtures,
test databases, spawner seam and native WDIO suite. Before changing each path,
record its fixture/source hash, immutable subject build, host, transport and
request list. Reuse that exact corpus and list for both sides. Use:

- **normal:** concurrency 1; separate cold and warm cache windows; at least 100
  completed calls per backend workload on each side, retaining failures.
- **burst:** concurrency 8 over the same request list and corpus; record queue
  recovery, cancellations and obsolete work. Run in an isolated test instance.
- **native:** existing packaged-desktop scenario, repeated cold/warm runs;
  retain individual outcomes and missing metrics. Budgets remain popup 1500ms,
  FCP 3000ms and LCP 4000ms. Browser results cannot replace native acceptance.
- **sustained:** after integrating the source lanes, a bounded 30-minute normal
  workload plus the isolated burst. This is P-009 acceptance, still outstanding.

Changing fixture population, transport or cache policy creates a new profile,
not a comparable second window. No controlled speedup is claimed here.

## Frozen tool observations

Milliseconds from `tool_invocations.duration_ms`. The writer is
`packages/operator-core/lib/projected-tool-deps.ts`: dispatch duration is supplied
by the caller and `invoked_at` records settlement before buffered persistence.
Errors use the existing rollup definition `status NOT IN ('ok','refused')`.
The following selected groups share serving host `port-3070`, build
`80521d598f`; transport is MCP except memory search (`in_process`).

| Tool | Completed | Errors | p50 ms | p95 ms |
|---|---:|---:|---:|---:|
| activity:report | 1209 | 1152 | 113.0 | 239.0 |
| work_items:get | 147 | 0 | 202.0 | 6985.3 |
| sessions:search | 27 | 0 | 1089.0 | 7032.3 |
| plans:get | 24 | 0 | 184.0 | 439.1 |
| coord:orient | 19 | 0 | 9741.0 | 17891.9 |
| memory:search | 10 | 0 | 2136.5 | 5650.2 |

Groups below 100 observations are exploratory. The fast activity-report numbers
mostly measure rejected calls, not successful useful work. Background-host groups
were returned separately under builds `509f7b0b56`, `d1605eb516`, and `42936cb124`;
they are not pooled with these request-host measurements. The query returned the
12 largest groups, so this table is a named subset, not a complete tool census.

Reproduction SQL (read-only, bounded):

```sql
SELECT tool_name, transport, serving_host, serving_build_sha,
       count(*)::int AS n,
       count(*) FILTER (WHERE status NOT IN ('ok','refused'))::int AS errors,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
FROM harness_shared.tool_invocations
WHERE workspace_id = 'papercusp-workspace'
  AND invoked_at >= '2026-09-23T22:00:00Z'
  AND invoked_at < '2026-09-23T23:00:00Z'
  AND tool_name IN ('coord:orient','memory:search','sessions:search',
                    'work_items:get','plans:get','activity:report')
GROUP BY tool_name, transport, serving_host, serving_build_sha
ORDER BY n DESC LIMIT 12;
```

The selected names are logical calls, not dispatch-wrapper names. For a broader
census, reuse `dispatchWrapperExclusionPredicate` from the existing rollup.

## Frozen route and query observations

Same fixed window/workspace, grouped by route template and semantic status `ok`:

| Route | Recorded calls | p50 ms | p95 ms |
|---|---:|---:|---:|
| /agent-mcp/console/bootstrap-su/heartbeat | 8664 | 6.0 | 337.9 |
| /:transport | 7026 | 3.0 | 5.0 |
| /agent-mcp/mid-turn-context | 2182 | 7.0 | 5010.0 |
| /desktop/version | 390 | 0.0 | 1.0 |
| /ui/presence | 270 | 3.0 | 13.6 |
| /health | 232 | 0.0 | 1.0 |

Writer: `packages/operator-core/lib/endpoint-route/telemetry.ts`, elapsed wall
time from route start to completion. Definitions may sample or disable recording;
these are recorded executions, not guaranteed total traffic. This ledger does
not identify build/host, so cross-build route comparisons remain unqualified.
Read query: the same time/workspace predicates above against `route_invocations`,
group by `path,status`, order by count descending, limit 6. Other routes and
statuses are outside this bounded result.

The audit's fixed **22:04:51–22:05:06Z** database interval remains the SQL baseline:
session-search statement `3939267458425839640`, 4 calls, 19899.153ms total,
4974.788ms mean. Memory lexical statement `3802103855579733629`, 5 calls,
3265.271ms total, 653.054ms mean. These are overlapping database execution costs,
not CPU shares or p95. Recheck actual statements/plans and the same fixtures in
their owning lanes before optimizing. Loop profile-trigger p95 951.1ms is a
selected saturated window, not a normal-workload distribution.

Native baseline remains the audit's identified packaged runs: `fd4e0ee48511`
at 2026-09-23T06:43:44Z (popup 4364ms, FCP 3026ms, LCP 4565ms), and
`2633f4772ec2` at 14:43:45Z (popup 1798ms; an expected Web Vitals metric missing).
No missing metric is zero or a pass.

## P-001 producer and detector

Root cause: the performance history's only producer was the improvement watchdog,
which was owner-paused on August 24. Its last tick and last backend snapshot align
at 2026-08-24T16:46:53.652Z, while system-health ticks continued. The performance
flag was enabled in the checked processes. The watchdog pause is preserved.

The existing active system-health sweep now calls the existing collector only
when its latest persisted row is at least 15 minutes old, then checks whether
persistence advanced. It does not dispatch the learning watchdog's findings.
Warnings are rate-limited, including read failures. No new routine, flag, table
or manual production sample was introduced.

The Infra panel independently reads the existing snapshot series. At two missed
intervals it reports `warn` and the last persisted timestamp even if the producer
never runs. Missing history warns; unreadable or future timestamps are unknown;
the explicit performance-rig kill switch remains distinguishable as disabled.
The status and metric use the existing Health/Overwatch model.

Natural backend samples observed during this work:

| Persisted timestamp (UTC) | Loop p95 ms | PG connection saturation % |
|---|---:|---:|
| 2026-09-23 23:46:25.936220 | 21.3 | 40.8 |
| 2026-09-24 00:02:54.917852 | 89.2 | 44.9 |

Read directly from `perf_regression_snapshots`, scoped by workspace and ordered
by `captured_at`. The loop metric is the collector process's current histogram;
PG saturation is the existing `pgHealth()` measure. Null orphan rate with zero
dispatch samples remains unknown. These two samples establish resumed
persistence; they do not establish a general latency improvement.

The active `papercusp-bg-host.service` was inspected at 00:05Z: PID 2790598,
started 23:44:07Z, working directory canonical `papercusp/apps/operator`, bundled
Node entry `dist-host/hono-host.mjs`, port 3271. That bundle contains the new due
collector path. This background/current-build plane is distinct from deployed
green request host :3070. The later Infra surface addition still needs serving
runtime readback; no final deployment is claimed.

## Verification and remaining acceptance

The project's `npm run test:file -- ...` router selected four unit files plus
the integration config for `perf-regression-producer.integration.test.ts`:
**407 unit tests + 6 integration tests passed, zero skipped**, finishing
2026-09-24T00:15:30Z at HEAD `8dc662ace4b400befaed20cd54e33873f49bda24` with local
changes. The integration test uses an injected timestamp store and clock, calls
the real producer/independent reader/Infra status and summary, and does not mutate
production data. Its durable test run is **19210434**, bound to `PERF-P-001@1`
by evidence row **10747**. The changed source files pass scoped semantic
typechecking; 24 import-graph diagnostics remain outside the requested files.
This is not a whole-tree typecheck or a release-gate verdict.

At 2026-09-24T06:16:20Z, a read-only call to the existing
`readSharedSnapshot('system.health', 'papercusp-workspace', 1, 3600000)`
returned a snapshot computed at **06:15:18.879Z**, evaluated at
**06:15:10.308Z**, with `panels.infra.data.performanceHistory` equal to
`{ status: 'ok', lastCapturedAt: '2026-09-24T06:04:16.218Z', ageMs: 659225,
note: 'lastCapturedAt=2026-09-24T06:04:16.218Z' }`. The shared snapshot was
about 62 seconds old when read. This verifies the new field on the current
background-host snapshot and a naturally persisted recent sample; it is one
runtime read, not a duration or availability distribution. The pipeline-position
read for `system-health/compute.ts` identified the current background-host build
as `ff35678573` and staging operator build as `8702d166fa`, both containing the
field. The green release operator at `80521d598f` did not yet contain that code,
so final deployed-plane verification remains open.

The `PERF-P-001@1` integration test binding is current. An operational binding
for `AUTO-BAR-R-1-P-001@1` records the current-build readback above; its source
measurement includes this report, so it must be remeasured when this paragraph
changes. The rubric itself is still awaiting independent vetting.

For the P-001 intent-tested coverage census, the real project integration suite
`perf-regression-producer.integration.test.ts` exercises six distinct outcomes:
two missed intervals produce an Infra warning with the last timestamp without
calling the producer; a failed insert remains overdue until a later persisted
sample; no series warns with `lastCapturedAt=never`; unreadable storage stays
unknown; a future timestamp stays unknown; and the explicit kill switch stays
disabled without querying storage. The first two cases are counterexamples to
an assumed healthy producer and would fail their assertions if the alarm or
persistence check were removed. The suite passed all six cases in recorded run
**19210434**, with zero skipped. This covers the clause's producer, persistence,
reader and Infra presentation path at the intent-tested L3 rung. It does not
claim a mutation probe was run.

P-001 item closure remains gated on the plan's spec-adequacy certification.
P-002..P-009, controlled before/after workloads, independent final acceptance,
the sustained observation and final shipment remain open.

## P-002 current-build compatibility verification

The existing fixes in EI-24045346484356708 (search) and EI-24022555028936462
(hook schema) were reused. No replacement search or reporting implementation
was added. At HEAD `8dc662ace4`, the named schema-contract and search integration
files were clean before/after the real test router: **6 + 53 tests passed**, zero
skipped. Durable runs: **19214023**, **19214026**. The wider shared tree was dirty.

One additional regression in the existing `activity/activity.integration.test.ts`
parses a generation-bearing `glance_stale` payload, invokes the real report
handler against isolated Postgres, verifies its stored activity row and checks
the payload forwarded to the mocked bundle builder. The suite's **21 tests
passed** at `a9e70782dc445de8678ce6d6440b509edcd7d0a3`, named file clean, durable
run **19214046**. This extends the earlier schema-only guard through the write
and bundle-dispatch path.

The actual staging serving tool accepted both a glance-only payload and one
with the returned generation plus `glance_stale:true`. The latter returned
`ok:true`, activity id `6229328`; tool invocation **29298348** records
`port-3170`, build `8dc662ace4`, status `ok`, duration 34ms. This is a single
compatibility result, not a latency percentile. The installed hook source's
generation/glance-stale construction was read directly.

**The green release runtime remains different:** contemporaneous installed
hook invocations **29298345** and **29298520** on `port-3070`, build
`80521d598f`, still report `invalid-input`. P-002 must not claim deployed hook
compatibility until the corrected build reaches that serving plane.

Staging session search returned two results for `performance audit` (invocation
**29298514**, `port-3170`, `8dc662ace4`, 3100ms). Its bundle contains the bounded
50,000-row compact-token fill. An equivalent index-only primary query for the
same dictionary terms selected **Bitmap Index Scan: session_turns_tsv_idx**.
The existing integration tests cover primary/fill separation, literal-token
recall, full primary result sets, and coverage-graded behavior.

A second bounded diagnostic around a scoped `performance producer overdue`
search observed highlighted index-only statement **-5382584474920240673**
advance once (31.117ms accumulated execution delta), along with other shared
traffic. Its recorded SQL ends with `AND text_tsv @@ q.andq` and has no
substring OR arm. The old statement **3939267458425839640** also advanced in
these windows; the ledger is shared across hosts, so its increment cannot be
attributed to this staging call. This confirms coexistence, not elimination of
the old deployed query. Final serving-runtime evidence remains required.

## Acceptance contract repair

The plan's generated acceptance rubric lacked METHOD and structured checks for
all nine criteria. A concrete amendment is saved on **WI-10002801,
thread-post:1142917**, with exact apply payload and preview approval JSON.
It preserves the original outcomes, falsifiers, scope and evidence planes,
adds runnable checks and pins the existing clause proof layers. The preview
confirms no transition to manual-only proof. A live, eligible independent
reviewer was asked to countersign the full method text as well as the hashes;
the amendment is not yet applied. Source completion is not final certification.

## P-003 cancellation substrate progress

After the desktop-terminal interruption, the predecessor's last calls were
read-only investigation; no edit or test was in flight. Work resumed on
WI-10002825. The generic `process:exec` handler now reuses the sidecar's
`spawn:cancel` channel, scopes request IDs per connection, and aborts a
connection's processes when it disconnects. Cancellation acknowledgements mean
the signal was requested; the original execution result waits for child close.

The process runner accepts local control callbacks, prevents spawning after an
abort during admission, and no longer fabricates completion after a fixed
20-second timeout. Kill timers are removed at child close before asynchronous
admission settlement. Observer callback failures cannot own the child lifetime.
The IPC client's explicit close rejects its pending calls through its existing
teardown path.

Six real-process/Unix-socket integration cases cover graceful cleanup before
settlement, two clients sharing a numeric request ID, disconnect cleanup,
admission cancellation, escalation when SIGTERM is ignored, and observer failure.
They pass along with the existing IPC and Git-sidecar suites. Durable runs:
**19218407**, **19218405**, **19218406**, at
`ce8c9311f7ecd58cb1ba1bf92cf62edfdc6344a3` with local changes. Final scoped semantic
typechecking of all four changed source/test files passes; 24 diagnostics remain
outside that requested set. `git diff --check` passes.

**This is preparation, not the P-003 performance result.** Signal-bearing
`runGitBounded` calls still take the local path. Before routing them through the
sidecar, transport loss must not cause an unsafe local retry or premature
repository-lock release while the remote child may still run. Descendant
termination, profiler overhead and comparable launch/loop benchmarks also remain
open. No speedup or final P-003 acceptance is claimed.

## P-005 resumable-session reads

`listResumableSessions` filtered candidates by converting each complete
`adv_sessions` row to JSON to read optional `port_status`. That conversion also
serialized the launch payload. The scored/ranked stages then carried full
metadata and converted the row again to recover the optional harness scope.

The existing query now checks `pg_attribute` once per call, uses the direct
status column when present, and accepts legacy rows when the column is absent.
Absence is not cached, so a completed rollout is observed on the next call.
Ranking carries only identity, backend and activity; metadata is hydrated after
selection. No table, index, feature flag or parallel cache was added.

Bounded read-only live probes on September 24 separated these costs:

| Probe | Observed execution time |
|---|---:|
| Recent-300 filter using whole-row JSON | 2275.154, 1830.139 ms |
| Equivalent direct-column filter, interleaved | 16.263, 15.200, 14.832 ms |
| Full original listing | 2918.519 ms |
| Direct filtering with metadata still before ranking | 1194.302, 938.348 ms |
| Direct filtering with metadata after selection | 79.435 ms |

These are exploratory `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` executions on a
changing live population, not paired production percentiles. A separate
single-statement snapshot compared the complete original and revised results
with `EXCEPT ALL` in both directions: 37 rows each, zero differing rows.
The broad picker scope is deliberately cross-workspace.

The existing database integration suite now exercises pending/failed ports in
every candidate arm, cross-workspace results, a genuinely absent port column
followed by its return, exact-id recovery, activity ordering and per-backend
floors. An eight-reader burst returns the same fixture rows. The retained
1000-row fixture has 16384 payload characters per row; 100 alternating calls
per filter measured p50 13.490 ms (legacy) and 0.803 ms (direct) in the final
run. That benchmark isolates candidate filtering, not the complete HTTP route.

At 07:59:28Z, all 75 tests across the four focused `adv-sessions` suites passed,
zero skipped, at `30b6cf0d98` with local changes. Scoped typechecking found no
diagnostics in the changed files; 26 diagnostics remained elsewhere in the
import graph. `git diff --check` passed. An earlier new benchmark fixture failed
because a JSON constructor needed an explicit text cast; it was fixed before
the final run.

P-005 remains open for coordination/orientation and Learning/roster stage
profiling, complete current-build acceptance, and the plan's controlled full
workload evidence. No shipment or whole-plan completion is asserted here.

## P-005 orientation core-read overlap

Existing invocation `29360561` completed at 2026-09-24T07:44:47.458Z with
`duration_ms=7295`, serving build `d06ec6cafb`. The same owner's preceding
`in_process` rows were assignments `29360536` (2355ms), list `29360544`
(1480ms), inbox `29360545` (373ms), and observe `29360550` (497ms).
`recordInvocationImpl` stamps completion time; these timestamps and the source
confirm sequential execution in this one request. They do not establish a
production latency distribution or a controlled before/after comparison.

`composeOrient` now starts its existing bounded assignments promise after fleet
scope recovery and joins it at result assembly. The independent backlog, inbox
and eligibility reads proceed while it is in flight. The assignments promise
still publishes the early aggregate-fallback snapshot on settlement. Existing
scope recovery, claim filtering, deadline, failure and delta semantics remain
covered by the orientation suite; no cache or durable surface was introduced.

The new regression failed before the change: only `fleet:assignments` had
started while the backlog should have been in flight. The final test exercises
one and eight concurrent readers with deterministic leg delays (100ms
assignments, 80ms list, 30ms inbox, 20ms observe) and asserts complete result
parity at 130ms, including exclusion of an unavailable item. This is a simulated
dependency schedule, not a measured production speedup.

Verification at HEAD `431b0e2a22` plus local source/test edits:

- `orient.test.ts`: final 215 passed, zero skipped, 08:27:26Z.
- `orient-obligations.integration.test.ts`: 7 passed, zero skipped, 08:26:14Z.
- Scoped typecheck: zero diagnostics in the two changed files; 23 diagnostics
  elsewhere in the loaded import graph. No whole-project typecheck claim.

Learning/roster stage measurements and complete current-build acceptance remain
open on WI-10002827.

## P-005 Learning observations

Historical `sync-slow` logs identify `learning.observations.summary` with empty
query/filters (2177–2951ms examples on 2026-09-23) and paged observations.
The writer `sync-resolver/resolve-observability.ts` logs elapsed resolver wall
time above 2000ms, with a per-query 60-second suppression window. These selected
warnings are neither complete traffic counts nor latency percentiles.

The shared `observationScopedCte` materialized every scoped observation's body,
title, id, timestamp and expanded refs, even when the summary consumed only
kind/scope/role/confidence facets. Default page reads also materialized the whole
corpus before sorting/limiting their display rows. The existing CTE now projects
only fields required by a summary predicate, retaining text and refs for search
and refs for plan filters. Pages allow CTE inlining so the database can push down
filters/cursors and defer display projection until after the limit. Summary
facet scans still share one materialization. No cache, schema or flag was added.

Read-only live EXPLAIN observations on 2026-09-24:

| Query | Existing | Revised | Temporary blocks written |
|---|---:|---:|---|
| Default summary, interleaved probes | 1783.348 / 2200.304ms | 683.561 / 447.872ms | 8557 → 0 |
| Default 201-row page | 1413.162ms | 384.441ms | 8556 → 0 |

The summary probes each scoped 138,260 rows. A single-statement `EXCEPT ALL`
comparison returned 35 summary rows per version with zero differences; a
separate snapshot returned 201 page rows per version with zero differences.
These changing-live-data probes isolate the projection cost, not production
percentiles. An initial exploratory query used `id` instead of the view's
`issue_id` and failed; the table above includes only corrected successful runs.

Permanent real-Postgres guards in
`learning-observations-query.integration.test.ts` capture the production query
and inspect its executed plan. The summary guard failed before the fix with
50,205 unnecessary reference expansions; it now observes zero for an unfiltered
summary while confirming reference search still expands refs. The page guard
bounds expansion to the 200 display rows plus the next-page sentinel. Other
cases preserve body/ref/plan search, cross-facet predicates, exact totals, zero
matches and cursor termination; eight simultaneous summaries return equal data.

The same test reintroduces only the legacy unused columns into the captured
default-summary query and alternates 100 calls per version on the same 50,205-row
fixture. Every complete result equals the reference. Final warm SQL measurements
at stable HEAD `bb78d46e51`, 2026-09-24T08:42–08:43Z:

| Variant | p50 ms | p95 ms |
|---|---:|---:|
| Legacy projection | 215.711 | 335.447 |
| Revised projection | 95.487 | 104.106 |

This is a warm, isolated SQL fixture benchmark. Cold route latency, transport,
queue recovery and sustained production workload are not measured by it.

Final three-suite run: 23 passed, zero skipped, clean named paths and stable
HEAD `bb78d46e51`, completed 08:43:30Z. An earlier passing run crossed an
auto-commit and was repeated to obtain this stable provenance. Scoped typecheck
reported zero diagnostics in the two changed files and 23 elsewhere in their
import graph. Roster source-stage profiling and complete current-build acceptance
remain open; this is not a shipment claim.

## P-005 roster and served-read observations

The existing roster already batches source joins and enrichment joins, resolves
transcript freshness concurrently, and shares reads through a 2s fresh/15s stale
cache. A fresh diagnostic process with the runtime flag override store installed
measured the existing source joins concurrently at 100–134ms. Complete merge
samples with and without transcript decoration were 127ms and 192ms respectively;
their order/cache state differs, so subtraction would not isolate decoration cost.
The existing roster cache measured 108.7ms for its first read, 0.025ms for a fresh
hit, and 110.7ms for eight concurrent readers after clearing only this diagnostic
process's cache. All eight shared the identical result object, with 73 active
rows and no degraded fields. Log: `.papercusp/scratch/bash-7d7bb319-406.log`.
An earlier probe omitted runtime flag setup; it is not the basis for these values.
No roster source change was justified by these probes, and they do not explain
the historical primary-active-leg six-second timeouts under other conditions.

The existing REST audit harness was then used against `:3170`, whose `/api/health`
reported `sha=0f1d0bd04e`, `bundleStale=null`. Two sequential observed passes:

| Query | First HTTP ms | Second HTTP ms | UTF-8 response bytes, second pass |
|---|---:|---:|---:|
| advRoster.list | 1120 | 7 | 264540 |
| plans.attentionCounts | 5 | 2 | 232 |
| plans.attentionRefs | 261 | 24 | 196613 |
| learning.observations.summary | 347 | 339 | 1767 |
| learning.observations | 9 | 8 | 121228 |

These are HTTP wall times from two requests per query, not percentiles or proven
cold/warm worker states. The generic audit still flags roster bytes above 250KB
and Learning summary wall time above 150ms. This is backend read evidence, not
a completed desktop user journey. Log: `.papercusp/scratch/bash-4b6546bd-dbe.log`.
The initial diagnostic mistakenly requested `/health` and received HTML; it
aborted before the query audit. The corrected probe uses `/api/health`.

### Measurement repair

While reusing that harness, EI-24132496490732089 corrected two defects: REST and
in-process audits counted UTF-16 string units as bytes, and the in-process model
omitted the route's timing envelope. Guards compare against actual
`Response.arrayBuffer()` bytes and the real REST handler under a fixed clock.
Before repair, a 375049-byte response was reported as 125049 and missed its
budget violation; after that correction, route calibration caught 112 omitted
timing bytes. Final tests 19266588/19266589: 24 passed, zero skipped, at
`86bf19b66e` plus local source edits. Scoped typecheck: zero diagnostics in three
changed files, 23 elsewhere. The item is recorded done with proposed completion
authority until git-sync commits its exact source blob; the settlement reconciler
owns that promotion. No deployed-fix claim is made here.

A subsequent read found the exact verified source blob committed at
`bf59109b709c0da8033899ba6cc4de0107b89380`; all three declared working-tree blobs
matched their committed counterparts. The completion record still retained its
older proposed stamp at that read, so automatic settlement remains unverified.

### Exact warm-count clause

PERF-P-005@1 requires p95 ≤250ms across 100 completed warm reads. The existing
attention fixture now reports and asserts that percentile. Run 19267334 passed
14 tests at `4fe29369c7` plus the local test change: frozen profile
`attention-1000-items-2000-ascii-body-v1`, workspace `ws-attn`, concurrency one,
100 calls per mode, counts p95 0.176041ms, cold count construction 6.762740ms.

A permanent counterexample injects a 275ms wait at the real handler's metadata
callback in six of 100 completed warm reads. It independently counts the six
over-budget observations and confirms the same budget assertion rejects them
(observed p95 275.197474ms), while the source is still read only once. This is a
passing negative-scenario test, not a mutation-probe process; no production
source was mutated and the clock was real. Bindings 11236/11237 attach the run
and counterexample to PERF-P-005@1. The evaluator passed and emitted card
EI-24133989725260512; independent grading audit remains pending. This does not
close P-005 or establish shipment.

### Fresh-client and concurrent SQL verification

Run 19270264 added a separate real-Postgres case to the existing Learning
integration suite. It captures the current production summary query and restores
only the legacy unused projection for comparison. Both variants read the same
50,205-row fixture. Four rounds alternate variant order; each creates a new
eight-connection pool, measures its first request, then starts eight simultaneous
requests. Every complete result equals the current-query reference.

| Variant | First request on a fresh pool, range ms | Eight-reader completion, range ms |
|---|---:|---:|
| Legacy projection | 215.8–246.3 | 239.5–255.9 |
| Current projection | 103.4–129.7 | 131.2–151.1 |

The database and OS caches are warmed; only the client pool starts fresh. This
does not measure a cold database, HTTP transport, production p95 or desktop
rendering. The focused invocation passed the new case, with the seven unchanged
cases excluded by `-t`; their earlier proof remains separately recorded above.
Provenance: stable HEAD `2bf2467436` plus the local test addition, finished
2026-09-24T09:36:25Z. No application source changed in this verification step.

The warm-count card EI-24133989725260512 now has a passed independent audit,
EI-24134111853441553, stamped 2026-09-24T09:21:22Z. P-001's separate card
EI-24123000311780258 failed its independent audit EI-24133643922268786: replay
changed freshness from pass to fail and reported evaluator-build drift. That
failure remains unresolved and must not be described as pending or passed.

### P-001 evidence-scope correction

The failed audit correctly detected two stale bindings. Their measured moved
path was this whole-plan report; the implementation and test hashes had not
changed. Bindings 11264/11265 replace the counterexample/census bindings with
the complete implementation set already tracked by test binding 10747. The
six-outcome census is preserved in the immutable binding details. Run 19210434
remains the executed proof; it was not rerun. The old failure stays in history.

The corrected unscoped evaluator passes PERF-P-001, and certification under
the plan's governing `plan-class-bugfix` filed EI-24135395646362393. Its fresh
independent audit subsequently passed at 09:46:47.402Z via
EI-24135710606333042 (re-read at 09:56Z). This
supersedes the earlier card, not its historical failed audit.

A fresh bounded read of the existing shared Health row returned snapshot
`computed_at=1790242945921`, `evaluatedAt=1790242938485`, producer version 1,
and performance history `{status:'ok', lastCapturedAt:'2026-09-24T09:38:26.971Z',
ageMs:233293}`. The operational binding persists these values and its query
directly, with implementation-only source dependencies, replacing binding
11011. This is current-build shared-snapshot evidence, not final shipment.

The new Learning concurrency test also passed the scoped TypeScript gate
(`LINT_TSC_RESULT`, exit 0, HEAD `2bf2467436`). The full compiler reported
diagnostics elsewhere; this does not claim a clean whole-project typecheck.

## P-003 descendant cancellation

EI-24136230241945593 measured another cancellation gap in `process:exec`.
`sidecar-exec-process.ts` signalled only the direct child. A command that spawned
a helper could exit on SIGTERM while the helper retained its output pipes;
the original request then never completed. The new real-process regression
failed against the old implementation at its 90-second integration timeout
(run 19273899); teardown explicitly killed the recorded helper PID.

The existing execution seam now creates a referenced POSIX process group, using
the same group-signal pattern already used by capability/bash. Abort, idle and
hard-deadline termination signal that group. Escalation stays armed after the
parent exits, and admission settlement waits until the group is gone. A failed
group-liveness probe stays unverified and cannot fabricate an exit receipt.
Windows retains direct-child behavior; this evidence was collected on Linux.

Two permanent cases launch a helper that ignores SIGTERM, with inherited or
independent stdio. Both assert the helper is dead at admission settlement and
before the caller receives its result. This covers both a helper retaining the
output pipe and one outliving a parent whose pipes have already closed.

The full cancellation/Git group passed **28 tests, zero skipped** at stable
HEAD `5623ff3768` plus the local fix (runs 19273906/19273907/19273908). After
adding the settlement-time observation, both new cases passed at stable HEAD
`48ca7f163b` with clean named paths (19273911); the other nine integration cases
were deliberately filtered on that focused rerun. A preceding focused run
crossed an auto-commit and is not the final provenance reference. Scoped
TypeScript checking of the two edited paths passed; unrelated diagnostics
remain elsewhere. `git diff --check` passed.

The older intermittent progress test passed its targeted recheck and this full
run, but its historical failure cause is still unmeasured. No flake-resolution
claim is made. Mutating Git remains on the local path: the separate transport-loss
exit fence, profiler-start overhead and full multi-repository performance proof
are still P-003 work. This is source/current-build verification, not shipment.

### Normal parent exit must also wait for helpers

EI-24137289590776306 extends the same exit-proof invariant to a parent that
exits normally. The previous implementation waited for the process group only
when `terminating` was true, and ignored later cancellation once `childClosed`
was true. A helper with independent stdio could therefore remain alive after
admission settlement and the caller's result.

Three real-process regressions failed against that implementation (run
19273936): each observed `settled` where the helper was alive and the call
needed to remain `pending`. The cases cover eventual normal helper completion,
caller abort after the parent exits, and the absolute deadline after parent
exit. The same existing group-exit check now runs on every close; cancellation
and timeout guards remain active until the group is confirmed gone. No new
registry, tool or persistence surface was introduced.

The full lifecycle suite passed 14 tests, zero skipped (19273939), and the
Git-sidecar suite passed 16 tests, zero skipped. Both ran at HEAD `53172e7894`
with the local implementation change; the integration test was also locally
modified. Each new case observes helper death both at admission settlement and
at caller completion. This is Linux process evidence; Windows still uses the
direct-child contract. It does not establish transport-loss recovery or shipment.

### Shutdown waits for active requests to finish

EI-24137972449455522 found a distinct lifetime boundary in the server shutdown
handler. It aborted request controllers and destroyed sockets, then invoked
`process.exit(0)` from `server.close()` without waiting for those requests.
Closing network sockets does not establish command termination or admission
settlement. A regression using real IPC and a real child failed on the old
server (19273997): the intercepted exit call occurred while execution was still
pending. Only `process.exit` was intercepted, to keep the test runner alive.

Shutdown now reuses the active controller set as the drain condition and exits
after both socket closure and request completion. Signal handlers remain
installed while draining so a repeated SIGTERM does not bypass cleanup. The
full lifecycle suite passed 15 tests, zero skipped (19274002), at HEAD
`53172e7894` plus local source/test changes. Scoped typechecking of the server
and test passed; diagnostics outside these files remain. This verifies the
server's exit decision and real child cleanup, not recovery from SIGKILL or a
lost transport response. Those failure modes remain P-003 work.

The final suite adds an idle-shutdown liveness check and asserts repeated
shutdown retains the signal handler until settlement, then removes it. It
passed **16 tests, zero skipped** (19274010) at stable `cb4aa8932b`, with the
named test path clean after the background commit. The prior 15-test run and
scoped typecheck above remain the source-change validation; this final run
strengthens lifecycle coverage without changing the server implementation.

### Profiler investigation: preserve V8 state with bounded overlapping recordings

This is an exploratory mechanism result, **not an implemented monitor fix**.
The prior probes (native transcript `01a0d245-47d2-7e13-9365-3a1b016fbac2`)
established that reusing an inspector Session, or switching to Node's direct
`v8.startCpuProfile()`, still paid substantial startup cost. On the same
25,000-function fixture, reused Session starts took 83–95 ms; the direct API
took 90–97 ms. Those probes did not retain an active native profile between
captures.

Node v25.9.0's bundled V8 source explains the distinction:
`deps/v8/src/inspector/v8-profiler-agent-impl.cc`, `startProfiling` constructs
`CpuProfiler::New` when `m_startedProfilesCount` is zero; `stopProfiling`
disposes it when the last recording stops. `Profiler.enable` alone retains no
native profiler. Source read:
https://raw.githubusercontent.com/nodejs/node/v25.9.0/deps/v8/src/inspector/v8-profiler-agent-impl.cc

At approximately 10:38Z, a fresh Node v25.9.0 process retained 25,000 distinct
`new Function` instances. It used one enabled inspector Session and captured
100 ms windows in order: ordinary, three overlapping, ordinary. A named
`console.profile` anchor remained active during the middle captures and was
ended before the final control. Ordinary `Profiler.start` calls took
142.04/143.96 ms and stops took 31.59/31.46 ms. Overlapping starts took
0.443/0.055/0.058 ms and stops 0.240/0.242/0.606 ms. First-sample deltas tracked
the ordinary startup cost, while overlapping deltas were 0.008–0.011 ms.
These five observations are a mechanism probe, not a production p95 claim.

A separate 12-round probe used 50 ms foreground captures and rotated the
anchor by starting its successor before ending its predecessor. The initial
anchor cost 108.04 ms; later foreground starts took 0.032–0.113 ms and complete
anchor rotations took 0.137–0.289 ms. At most two anchors overlapped, 13 ended,
and none remained after shutdown. The largest ended anchor had 49 samples and
2,021 serialized JSON bytes. After disconnect and explicit GC, heapUsed was
1,745,608 bytes above the pre-start measurement; this single delta is **not** a
leak test or a steady-state memory bound. Both probes ran in their own Node
process, with no profiling or configuration changes to a serving host.

Next: prove rotation, cleanup, capture fidelity, flag/safety-cap behavior,
failure cleanup and sustained memory/CPU cost in the project test framework.
If viable, extend the existing monitor's tick and capture seam rather than
adding a separate profiler service or timer. Continuous sampling overhead and
rotation delayed by a wedged loop remain explicit risks. No production code
has been changed for this candidate, and P-003 remains open.

### Project profiler experiment and cancellation repair (10:55Z)

The mechanism is now exercised by the canonical integration suite in
`packages/operator-core/lib/event-loop-profiler-overlap.integration.test.ts`.
It spawns an isolated Node v25.9.0 process retaining 25,000 functions, records
48 overlapping 60 ms work/idle windows between two ordinary controls, and
rotates the anchor after each window. Run **19278072 passed 2 tests, zero
skipped**, at `db87ad0325` with the new test uncommitted. Every capture contained
multiple samples of fixture work. All 49 anchors ended, with at most two live
at once. Ordinary starts took 103.03/81.36 ms; the median overlapping start
was 0.043 ms and median rotation 0.214 ms. The largest anchor held 84 samples
and 4,018 serialized bytes. Across four GC observations, heap varied by
12,712 bytes and RSS stayed at 109,133,824 bytes. This short fixture is not a
long-duration leak test or a bound during arbitrary main-thread stalls.

The initial fidelity assertion failed in runs 19278066/19278069 because V8
inlined `profilerFixtureWork` into `capture`: the actual missing-name profiles
contained sampled `capture`/`now` frames. The corrected assertion requires
multiple work-loop samples, including its sampled `performance.now` calls,
rather than insisting on an uninlined function name. No product regression
was inferred from those fixture failures.

The separate idle-cost experiment alternates five unprofiled and four active
500 ms windows, excluding profiler construction/destruction from CPU timing.
Active sampling consumed about 20 ms CPU per window versus 0.15–0.41 ms in
controls: approximately **4 percentage points of one core** additional CPU.
This explains why fast warm starts alone are insufficient acceptance evidence.
Continuous overlap has **not** been integrated into the serving monitor; its
steady cost, delayed rotation, dynamic gate and saturation safety still need
a satisfactory design and verification.

Review also exposed **EI-24139818636862387**: monitor stop did not cancel CPU
work. A pending async gate could resolve true after shutdown and start a new
capture; an active capture retained its duration timer and native sampler.
Two canonical counterexamples failed against old source in **19278080**:
shutdown still created the output directory, and cancellation was still
recording after 500 ms. The fix gives the monitor an AbortController, checks
shutdown after the gate, passes its signal through capture setup and sampling,
clears the duration timer on abort, disconnects in `finally`, and removes
cancelled partial writes before publication. It reuses the existing monitor
and capture function without adding a service, flag or recurring timer.

Verification: **54 lag-monitor tests (19278088) plus 9 profiler-safety tests
(19278087) passed, zero skipped**, at `db87ad0325` with local source/test changes.
Coverage includes a pending gate, active direct capture, active monitor
capture and pre-aborted capture, alongside existing dynamic-gate, safety-cap
and retention cases. Scoped typechecking of monitor, unit test and overlap
integration test passed with zero requested or imported diagnostics; diff
whitespace checks passed. The new EI's claim was admission-pending, so this
repair was implemented under the already-held WI-10002825/P-003 lane. Source
verification is not independent acceptance or shipment. Transport-loss fencing,
profiler startup remediation and the remaining P-003 performance proof stay open.

The lifecycle repair's completion subsequently succeeded with state **done**
and **committed** completion authority. This does not promote P-003 as a whole.

A follow-up parameterized experiment, **19280662**, passed **4 tests, zero
skipped**, at `befef09f6b` plus the edited integration test. Sampling intervals
were set explicitly through `Profiler.setSamplingInterval` before recording.
At 1 ms / 10 ms intervals respectively, median overlapping starts were
0.052 / 0.044 ms and median rotations were 0.244 / 0.191 ms; both versions
produced 50 useful captures and ended their 49 anchors. The 10 ms fidelity
fixture deliberately uses a 100 ms work interval (versus 30 ms at 1 ms) to
provide enough samples; these are not comparable throughput measurements.
The **idle CPU comparison does use identical 500 ms windows**: added median
CPU fractions were 0.0391 and 0.00808, or about 3.91% and 0.81% of one core.
The coarser sampler is promising but does not resolve the remaining lifecycle,
dynamic gate, saturation and long-duration recording-policy questions. It has
not been integrated. Scoped typechecking of the updated integration test passed.

### Loaded profiler comparison and delayed rotation (11:13Z)

The full isolated profiler suite now passes **5 tests, zero skipped** in
**19281929** (`befef09f6b` plus the edited integration test). Its additional
100 Hz fixture runs the same fixed arithmetic workload before, during and
after recording, verifies identical checksums, and rejects controls whose
median CPU times differ by more than 15%. The first attempted workload called
25,000 generated functions and kept optimizing between controls (349.77 ms
before versus 94.58 ms after); that comparison is **invalid for overhead** and
is not performance evidence. The stable replacement measured median CPU times
of 26.42 ms before, 27.93 ms active and 27.17 ms after, about 5.4% higher active
than the combined control median in this run. This is a controlled observation,
not a production throughput claim or a confidence interval.

The test deliberately prevents rotation for at least one second. That recording
grew to 1,134,358 microseconds and 104 samples; rotation is therefore **not a
hard duration bound while the main thread is blocked**. All 25 anchors ended.
RSS changed from 81,739,776 bytes before profiling to 101,720,064 bytes at the
first in-recording observation and stayed there through the remaining checks
and disconnect. Observed JS heap during recording ranged from 32,777,576 to
32,831,792 bytes. These short measurements do not establish long-term retention.
Continuous profiling remains unintegrated pending an acceptable recording
policy and its dynamic-gate, saturation and retention tests.

### Queued output is progress: idle checks must let the pipe drain (11:31Z)

**EI-24124212290448236** now has a deterministic reproduced mechanism. The
sidecar and local Git tests wait for a real Node child to report readiness,
block the parent's CHECK phase for 450 ms, and record timestamped child writes
every 40 ms during the block. They require at least three writes inside that
interval. With a 150 ms idle deadline, old source committed its idle verdict
before the next POLL delivered those already-written bytes. The sidecar returned
-1; the local runner also appended a false idle-timeout diagnostic. The original
historical runs 19248786/19248790 lacked the reason text, so those two instances
cannot individually be attributed from their saved output alone.

Old-source controls: **19283365** failed the real sidecar queued-output case,
**19285491** failed the corresponding local case, and **19285506** failed the
action-level pending-progress case. In both real-process files, a separate
continuously-writing child still hit the absolute hard deadline. The action
test pins the same pending-progress interval with fake time; the OS-pipe phase
ordering is established by the real-process cases.

The fix extends the existing idle guards in `sidecar-exec-process.ts`,
`run-git-sync.ts` and `git-sync-action.ts`. An expired idle timer schedules its
verdict with `setImmediate`, allowing POLL to deliver pending output first.
Progress cancels that pending verdict and renews the existing idle timer.
Termination and settlement clear the pending check. Absolute hard deadlines
are unchanged. No timeout budget was widened and no periodic timer was added.

Verification: **36 tests, zero skipped**, across sidecar routing/progress
(19285494), local progress (19285493), and process cancellation/lifecycle
(19285495), at `edf012976b` plus local source/test changes. The full action and
signal-routing suites subsequently passed **144 tests, zero skipped**
(19285510/19285509). The latter runner began at `edf012976b` and its ledger
recorded `fb6b5c136c` after background git-sync committed during the run; its
aggregate provenance stamp is unknown, so it is current-tree evidence, not a
claim of an immutable single-SHA execution. Scoped typechecking of the seven
changed source/test files found zero requested-file diagnostics and 29 other
loaded-graph diagnostics. Diff whitespace checks passed.

This review also found a **separate, still-open** P-003 lifetime gap, recorded
as **EI-24141765530574665** (detail post 1143263): local Git only signals its
direct child, leaves escalation timers armed, and can force settlement after
20 seconds; the outer action also starts lease cleanup immediately after abort
without waiting for child exit. Its existing mock rejects synchronously on
abort, so it cannot detect that release interval. The next acceptance guard
must delay actual child settlement and assert repository leases stay held.
The idle-race repair does not resolve that gap or prove PERF-P-003 complete.

## P-003 local command lifetime and repository leases (2026-09-24 11:54Z)

The gap above is now repaired in the current source under WI-10002825 and
EI-24141765530574665. Two independent boundaries needed changes:

- The local Git runner signalled only its direct child and could resolve after
  parent close while an ignored-stdio helper was alive. It also fabricated
  completion after 20 seconds and left its SIGKILL timer armed after settlement.
- The action guard rejected its pipeline promise immediately on abort, then
  stopped the repository lease heartbeat and released leases while the actual
  Git execution was still pending. The old test's child mock rejected immediately
  on abort, so it never exercised that interval.

Local Git now owns a referenced POSIX process group and uses the same exit fence
as the sidecar. The existing sidecar signal/probe code was extracted into
`fleet/process-group-lifetime.ts`; this keeps local Git independent of sidecar
admission imports and prevents a second implementation of that lifetime rule.
Only successful exit proof permits completion; failed probes remain pending.
The existing 10-second escalation is cleared on settlement. Pre-aborted requests
return without spawning. Windows retains direct-child behavior; helper-group
coverage here is POSIX-only.

The action reuses `RunGitSyncOpts.runGit` to track real Git promises separately
from the cancellation race. Cleanup waits for these promises before starting its
15-second DB-cleanup budget or stopping the heartbeat. Setup and metadata awaits
retain their existing liveness deadlines, and no new Git call starts after abort.

Counterexamples: old-source run **19288100** failed both delayed settlement
variants (resolve/reject); old-source **19289497** failed all three local cases
(pre-aborted spawn, cancelled helper, successful parent with a live helper).
The full action/local/IPC lifecycle run passed via detached recovery
**05f155f3-0ad2-416a-91a1-87bc7b41bb27**, rows **19289816**, **19289815**,
**19289818**, at HEAD `9449244055` with local source edits. The action regression
was then strengthened to keep the child pending for 20.1 seconds of fake time,
past both deadlines and the cleanup budget: **19289822**, 2 passed, 141 unrelated
cases filtered. It confirms lease renewal during cancellation and release only
after settlement for both fulfillment and rejection.

Scoped typecheck passed all six changed TypeScript source/test paths with no
requested-file diagnostics; 23 other import-graph diagnostics remain. The spawn
lint initially flagged the already-governed, awaited sidecar group; the existing
documented awaited-group exemption now covers both runners (EI-24143584172308161).
`git diff --check` and the spawn lint pass. This is source/current-build proof,
not deployment proof or P-003 completion. IPC transport-loss exit fencing,
profiler policy and comparable multi-repository performance remain open.

Final compatibility results: **19289825–19289827** passed 41 routing,
cancellation and spawn-guard cases with no skips; **19289828** passed 18
Git-sidecar cases with no skips; the full `run-git-sync.test.ts` suite passed
as **19289841**, detached run **ce8ba1a3-33dc-4c77-b40a-a17aadc41edc**.
The background routine committed the named source/test paths at `a131b1bcb6`;
their working-tree state was clean when checked. EI-24141765530574665 closed
with **committed** completion authority. The minor lint-exemption item
EI-24143584172308161 was closed with proposed authority before that sweep;
its recorded content manifest awaits automatic settlement. Neither result
claims deployed behavior or completion of the whole performance plan.

## P-003 file-output progress and idle-check liveness (2026-09-24 12:16Z)

EI-24142656580054437 is reproduced and repaired. `stdoutPath` sends stdout
straight to a file descriptor, so it emits no pipe data events. The idle guard
previously observed stderr alone and killed a healthy file-only writer.
Old-source run **19289858** failed the binary streaming and hard-deadline
controls; the silent-after-one-write control passed.

The existing idle-deadline callback now samples the already-open output handle's
size. It never reads/copies the file contents into JavaScript and adds no polling
timer, watcher or config key. Size changes renew the idle deadline and report
observed output activity. This conservative sampled observation can add up to
one idle interval after the last write; the independent absolute deadline is
unchanged. A generation check invalidates pending stats after pipe progress,
cancellation or child exit. A failed size probe terminates with an explicit
verification-failure diagnostic rather than inventing output progress.

The new cases also isolated EI-24144921179345016. With the size-probe change
alone, **19289859** still failed: the unreferenced one-shot `setImmediate`
could wait for child close or the hard deadline when no pipe traffic woke POLL.
Removing only `idleCheck.unref` made the three file-output cases pass in
**19289860**. The same correction is applied to the local Git and action guards;
their existing cancellation paths still clear the one-shot handle.

Final verification: **19289865** passed all 17 fd-handoff cases, including byte
fidelity, streaming, stopped output, hard timeout, and delayed-stat races with
stderr progress, abort and the hard deadline. **19289864** passed 18 existing
sidecar cases; **19289868** passed 5 local lifecycle/progress cases;
**19289869** passed 143 action cases; **19289870** passed 16 real IPC lifecycle
cases. All 199 passed with zero skips. Scoped typecheck passed the four changed
TypeScript source/test paths, with 23 other import-graph diagnostics; diff
whitespace checks passed. This proves current source behavior, not deployment,
transport-loss exit recovery, a profiler-overhead remedy or P-003 completion.

### P-003 prerequisite: failed SIGKILL escalation is not successful delivery

EI-24146077216039124 was found while evaluating the existing task-manager
containment surface for transport-loss recovery. Both `killTask` and
`killScopeUnit` ignored the result of the escalated `systemctl kill` command,
then reported successful pending termination even if that command failed.
They now propagate `command_failed` and retain the original command error.

The initial interpretation that any successful pending response was itself a
bug was withdrawn after reading EI-20130774106283501. That behavior deliberately
avoids retry advice after accepted SIGKILL delivery while reaping is pending.
It is preserved. A successful kill response therefore still is **not** proof
that every process has exited; a future transport fence needs separate proof.

The permanent test holds the cgroup populated, accepts SIGTERM, and rejects
only SIGKILL with a bus-disconnect error. Old source failed both task and scope
cases in **19289906**, reporting `ok:true` and `no retry is required`. Fixed
source passed all 53 control cases in **19289907**, including accepted-delivery
and delayed-reaping controls. The accompanying processes/kill suite passed
10 cases: 63 tests total, zero skips, at HEAD `2cc99b2e34` plus the local source
and test changes. Scoped typecheck found zero diagnostics in the two changed
files (25 other import-graph diagnostics); `git diff --check` passed. This is
source verification only. The overall P-003 transport fence remains open.

### P-003 live-server connection drain (server-death recovery still open)

Plan decision D-001 preserves other users of the shared sidecar. The existing
`spawn:cancel` capability response now includes random server and connection
generations. `process:exec` can require that identity before admission; a
reconnected socket cannot silently run a request bound to its predecessor.
The new IPC `process:drain` operation runs on another connection, revokes the
original socket before any await, aborts its existing controllers, and joins
the original exec promise. Closed connections retain only their unfinished
requests. Completed responses are not cached: a missing result is returned as
`null`, meaning unknown outcome with confirmed exit, never permission to replay.
This extends the existing IPC and controller maps without a table or timer.

The project integration suite covers disconnection while the child is alive,
delayed admission before any PID, stale connection and server generations,
same-connection refusal, isolation from another client's live command, and
repeated drain after one completed file mutation. The old-source run
**19289919** failed all five new cases on the absent capability; cleanup also
reported three secondary rejected promises, subsequently handled in the test
helper. Fixed **19289921** passed all 21 real-process cases; the IPC client
suite passed 11 cases. Total: 32 passed, zero skipped, at HEAD `2cc99b2e34` plus
local source/test changes. The three changed TypeScript paths pass scoped
typecheck with zero requested errors and 23 other import-graph diagnostics.

This verifies the **live-server half only**. No Git caller uses the new fence
yet, and signal-bearing mutations remain local. Next: bind the handshake to
kernel process/cgroup identity, prove recovery when that exact server dies,
then integrate the caller without retrying an ambiguous mutation or releasing
its repository lease early. Do not use `killScopeUnit.ok` as an exit verdict,
nor destroy a live shared sidecar after a single client's connection fault.

### P-003 kernel containment and cancellable caller recovery (13:09Z)

`sidecar-exec-lifetime.ts` now supplies strict exit observations using the
existing process-identity parsers, task-manager scope names and scope-control
operation. The spawner mints the managed task ID before launch and passes its
expected scope to the server. The capability response advertises containment
only when the kernel confirms that exact scope, so an unconfined fallback
cannot accidentally authorize killing the caller's inherited scope. The
snapshot binds PID, boot/start identity, cgroup path and mount/scope inode
identities. Read errors, malformed data and changed mount/scope identities
remain unknown. A dead/recycled/zombie server permits cleanup of its original
scope; only `cgroup.events populated=0` or confirmed removal of that previously
observed scope establishes exit. A signal receipt does not.

Signal-bearing `runCommandViaSpawnerSidecar` calls now use a separate connection,
verify containment before dispatch and send the preflight connection fence.
On transport loss they revoke/drain that connection through the existing
`process:drain` protocol, or reap the confirmed-dead server's original scope.
Failed observations keep the promise pending, preserving the caller's lease.
A lost result resolves as an unknown outcome after exit is proven; it neither
throws into local fallback nor uses the infrastructure-fault prefix. Other
calls on the shared host connection remain independent.

Verification at HEAD `bbdf4f8d19` plus local changes: **59 unit tests** across
the lifetime, caller cancellation, spawner launch/confinement and IPC suites
passed. The updated process integration suite passed **22 cases**, including
the actual caller losing a reply after a real file mutation: one mutation,
child exit before resolution, and a second client's command still alive.
That in-process test substitutes the containment handshake; the separate
Linux integration test uses real managed systemd scopes and kernel reads. It
kills the test server while its helper survives, observes the populated scope,
then verifies cleanup and preservation of a separate live scope. It passed
with zero skips. Its first run (19293964) failed only on the expected orphan
warning from deliberate fixture teardown; marking the managed fixture's
teardown explicitly corrected that test setup. The seven initial changed
TypeScript paths passed scoped checking (23 other import-graph diagnostics).
The added Linux test subsequently needed its required `TaskSpec.argv` field;
the final test/typecheck result is recorded on WI-10002825.

The joined proof subsequently passed in **19294001** at `c3df817a17` plus local
changes: all **three** Linux integration cases, zero skipped. Two cases launch
the actual IPC server and exec implementation in separate managed scopes,
substituting only admission persistence with a fixture receipt/barrier. The
actual caller's containment handshake and recovery are unmocked. Killing the
server after a file mutation confirms scope exit and exactly one mutation;
killing it while admission waits confirms exit with no child/mutation ever
created. The server accepts an optional exec dependency for this fixture; its
default remains the production implementation. The parameterized fixture's
Vitest context typing was then corrected without changing these assertions.

With that proof in place, `runGitBounded` now allows signal-bearing mutations
through the same cancellable sidecar path. Optional Git locks are disabled only
for the read-only command set. Routing regressions distinguish safe preflight
fallback from a post-dispatch unknown outcome, which must not replay locally.
The final routing/test/typecheck results are on WI-10002825. Profiler policy,
comparable multi-repository measurements, independent acceptance and shipment
remain open; these are source verification results, not a deployed-runtime
claim. Prior tests 19293953–19293958 cover the first 59 unit/21 integration
matrix; 19293980 adds the full-caller live-server case (22 passed). The later
13:11 run crossed an automatic commit and is not used as settled-source proof.

Final changed integration/routing verification at settled `c3df817a17` plus
local changes: **19294006** (22 real IPC/process cases), **19294007** (3 actual
Linux scope and separate-server cases), **19294008** (5 Git routing/fallback
cases) all passed, zero skipped. Together with the unchanged 59-case unit
matrix this source unit has 89 passing cases. Scoped typechecks cover the
changed source/tests with zero requested diagnostics; the last four-file
compile reports 24 other import-graph diagnostics, not a globally clean build.
`git diff --check` is clean. The final subsequent edits only rename the read-only
set and correct lifecycle documentation. No shipped-runtime claim is made.

### P-003 warm recorder source unit (2026-09-24 13:37Z)

Decision D-002 selects a 100 Hz recorder owned by the existing lag monitor.
`event-loop-cpu-recorder.ts` retains V8's code map using overlapping named
anchors, rotates on the existing monitor tick, and supplies foreground profiles
through the existing `captureCpuProfile` artifact/retention seam. There is no
new service, timer, flag or persistence table. The existing opt-in gate controls
the whole recorder. Gate OFF/error, unsafe p95, delayed rotation and shutdown
disconnect it and cancel active capture. A gate read spanning a tick revokes
sampling; its stale result cannot restart it. Startup/slow rotation and
foreground start/stop costs are logged explicitly as observer cost.

This is a **soft** rotation bound. Native recording continues while JS cannot
run. On the next overdue tick, disconnect discards the old profiles rather than
serializing them. Node v25.9.0's bundled `v8-profiler-agent-impl.cc` corroborates
that path: `disable()` calls `stopProfiling(..., false)` for console recordings
and `stop(nullptr)` for the foreground; only `serialize=true` builds the
protocol profile. The public `v8.startCpuProfile()` API has no sample-limit
argument. No hard duration/memory bound or production overhead SLO is claimed.

Canonical verification on `a0d29c3d57` plus local changes:

- Recorder lifecycle unit run **19294029**: 10 passed, zero skipped; overlapping
  anchors, one initialization across captures, disabled/unsafe/overdue/stop
  revocation, pending setup, failure recovery, cancellation and single-flight.
- Real isolated Node integration **19294031**: one passed, zero skipped. Forty
  captures all contained multiple workload samples on a 25,000-function fixture.
  Initial warmup cost 123.35 ms; foreground starts ranged 0.039–0.155 ms.
  The deliberate overdue tick discarded the recorder, capture while unavailable
  rejected, and a safe reinitialization cost 96.07 ms. Largest foreground was
  18 samples / 2,790 bytes. Eight explicit-GC observations had constant RSS
  166,952,960 bytes and heapUsed 49,930,656–50,033,336 bytes. This is a short
  retention check, not a long-lived leak proof. Idle sampling used 4.102 ms CPU
  over 499.47 ms; after disable, 0.204 ms over 502.69 ms. The earlier baseline
  had 8.096 ms CPU, so it is **not** used to infer incremental overhead here.
- Final monitor run **19294033**: 57 passed, zero skipped, including new quiet
  prewarming, gate-OFF-during-capture and slow/stale gate cases. Safety-posture
  run **19294032**: 9 passed, zero skipped. Five-file scoped typecheck passed
  with zero requested or imported diagnostics.

The first unit run failed one monitor case because the Vitest global console
does not provide the native profiling behavior. The adapter now imports Node's
native `profile/profileEnd` functions; the full monitor suite then passed. The
real integration already uses Node's actual inspector. Existing experimental
idle/loaded overhead results above remain relevant, but multi-repository Git
measurement, sustained profiler acceptance and independent audits remain open.

### P-003 comparable multi-repository transport proof (13:46Z)

Run **19294494** passed the new canonical Git benchmark, zero skips. The full
method and final table are in `papercusp-p003-git-sidecar-benchmark-2026-09-24.md`.
Four temporary repositories, five read/write commands, 100 calls per block,
local/sidecar/sidecar/local order, pre-populated indexes and identical result
checks yielded zero fallbacks. Signal-bearing caller entry p50 was
29.24/0.54/0.45/26.59 ms; loop-delay p95 was 36.21/11.10/10.66/31.16 ms.
The real IPC/Git/kernel path uses fixture admission, so production DB/queue
latency and a full scheduled git-sync action are explicitly outside this proof.
No new production p95 or universal speedup claim follows. Source is
`a0d29c3d57` plus local edits; scoped test typecheck has zero requested and
23 other import-graph diagnostics. P-003 still needs sustained observer-cost
acceptance and independent verification; whole-plan acceptance/shipment remains
open.

## P-003 exact cancellation-clause proof (2026-09-24 14:02Z)

PERF-P-003@1 now has bindings **11508–11511**. Current-source action run
**19295455** passes the two delayed-child lease cases (141 unrelated cases
filtered); historical red **19288100** supplies the caught counterexample.
Real IPC/process runs **19294007/19294006** supply the separately bounded
integration layer. This composes the action's awaited promise with the child-exit
boundary; it does not claim a production-DB end-to-end action. The revision-2
adequacy evaluator passed and emitted **EI-24151782242112283**, pending independent
audit when filed. P-003's sustained profiler acceptance is still open.

## P-004 lineage projection (2026-09-24 14:15Z)

The live source query for ten frozen recent candidate/parent identities took
**2266.560 ms** under bounded `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`.
Its `adv_sessions` edge scan took **2148.190 ms** and 82,632 buffer hits.
An isolated launch-parent extraction measured **2402.494 ms**, 4,511 edges from
30,026 scanned rows. A narrow owner-only scan, returning more rows, took
**10.321 ms**, 2,218 hits. The expensive operation is repeatedly extracting the
parent from prompt-bearing launch JSON, not recursive traversal alone. These
are individual live measurements, not production p95 or CPU shares.

Migration **1217-adv-session-launch-parent-projection.sql** extends the existing
session table with a stored generated `launch_parent_owner`. PostgreSQL derives
it from `NULLIF(launch_spec->>'launchedBy', '')` for old and new application
writers. No new edge table, cache, service, or timer is introduced. The shared
`identityEdges` query reads this scalar, preserving the existing directed graph
and workspace predicate. The additive migration uses a five-second lock timeout;
deployment must apply it before running the changed query.

The new project integration suite reconstructs the pre-migration table shape,
seeds 4,000 sessions with 16 KiB launch documents, applies the migration twice,
and verifies backfill and subsequent parent/blank/null/absent updates. It tests
cycles, the 64-edge bound, consult ancestry, sibling eligibility and foreign
workspace exclusion against both query variants. Both variants execute the
production query; only the legacy arm replaces the scalar with JSON extraction.

| Frozen fixture measurement | Legacy JSON | Stored projection |
|---|---:|---:|
| Counterbalanced lookup median (10 calls each) | 42.119 ms | 10.782 ms |
| EXPLAIN execution | 40.961 ms | 11.434 ms |
| Shared buffer hits | 25,084 | 84 |

The eight-candidate acceptance workload completed **100 calls**, identical
grouping each time, with **12.252 ms p95**. This is an isolated fixture, not the
live ten-candidate population. The test asserts the 500 ms bar, lower median
cost, and fewer buffer accesses as a mechanism guard. Ledger runs **19295800**
and **19295801** pass all **14 tests, zero skips**, at `76b15a89a4` plus local
changes. Scoped typecheck passes both source/test paths and their import graph.
Raw test output is `/tmp/p004-lineage-tests-20260924.log`.

The absolute-path migration dry run succeeded; no live SQL apply or shipment is
claimed. The relative-path dry run incorrectly selected the detached
`papercusp-staging` checkout (tracked under **EI-24070880772695626**); Git confirms
the actual main checkout remains `papercusp`, branch `staging`. Memory lexical
profiling, independent acceptance and whole-plan shipment remain open.

## P-004 lexical field normalization (2026-09-24 14:28Z)

Frozen query: `papercusp memory lexical retrieval ranking scope deterministic
query performance timeout lineage candidate exclusion active history search`
(16 tokens), `user_id=harness:papercusp`, top-K 10, memory kind, active/current
rows. Bounded live EXPLAIN of the source query measured 595.992 ms. Moving its
match predicate before the projection fence measured 449.177 ms but increased
buffer hits from 20,675 to 69,580; that variant was not selected.

The selected change keeps the existing query structure, scope/validity guards,
admission, weights and rank-before-limit. PostgreSQL `lower()` normalizes each
field once behind the existing `OFFSET 0` fence; already-lowercase query tokens
then use `LIKE`. This removes repeated case conversion for each token in both
filtering and scoring. Counterbalanced live source-query EXPLAIN runs measured
580.770/206.182/216.389/602.697 ms (legacy/current/current/legacy), with comparable
buffer counts. These are four controlled statement executions, not service p95.

The real-PG suite compares the production query to its ILIKE predecessor across
mixed case, Unicode, JSON null/numeric/array fields, escaped compound identifiers,
memory/entity separation, archive status, foreign scope and validity windows.
Repeated results and complete result payloads/scores agree. Its 2,000-row frozen
wide-text benchmark uses counterbalanced five-call blocks, ten calls per arm:

| Measurement | Legacy ILIKE | Normalize once |
|---|---:|---:|
| Median caller time | 718.137 ms | 179.363 ms |
| EXPLAIN execution | 935.211 ms | 259.254 ms |
| Shared buffer hits | 119 | 119 |

Ledger **19295840** passes all seven PG cases, zero skips. **19295830** passes
96 memory-store unit cases. Scoped typecheck passes the three changed paths and
their import graph. Raw final test output is
`/tmp/p004-lexical-final-20260924.log`; source is `f6cdc8cbe2` plus local edits.
The first PG attempt exposed a stale fixture missing the now-required storage
profile; the next exposed an untyped polymorphic JSON parameter. Both fixture
faults were corrected before the successful run; neither was a passing test.

P-004 lineage binding **11537** passes traceability, layer, oracle, execution and
freshness checks. Adequacy remains **unknown** for falsifiability and the L4
floor: a targeted counterexample is still required. Broader independent
acceptance and shipment remain open. P-003's cancellation scorecard now has a
passed independent audit, **EI-24151960564427869** (2026-09-24 14:05Z).

## P-004 latency falsifier (2026-09-24 14:37Z)

The preceding adequacy gap is now cleared for **PERF-P-004@1**. The sanctioned
copy-out mutation tool inserted an awaited 600 ms delay in a temporary copy of
`lineagePartyKeys`. Original baseline **19295851** and unmodified relocated
baseline **19296562** passed (100-call p95 17.292 and 12.727 ms). Mutant
**19297277** completed its 100 calls and failed specifically at the 500 ms p95
assertion, measuring **619.196 ms**. Two unrelated cases were filtered in each
probe run. The script returned `verdict=caught`, `baseline_exit=0`, `guard_exit=1`.
Its TS syntax checker reported `mutant_parse=unchecked`; the actual Vitest run
loaded the module, ran the benchmark and failed the named numeric assertion.
This is not an import failure. The shared source was unchanged by the probe.

Bindings **11546/11547** supersede the earlier test recipe and add the targeted
mutation. The revision-2 adequacy evaluator passes with no blocking criteria;
scorecard **EI-24154001676167368** is filed for the automatic independent audit.
The broad P-004 acceptance and shipment are still open. Logs and frozen mutant
are at `/tmp/p004-lineage-mutation-20260924.log` and
`/tmp/mutation-probe.TneDEs/`; the canonical scorecard retains its replay recipe.

## P-004 independent lineage audit (2026-09-24 14:41Z)

Scorecard **EI-24154001676167368** now records a passed independent audit via
**EI-24154238373657663**, auditor `role-063527fe-25e9-444c-90b5-ee7a8b184221`.
This covers the exact lineage clause, not broader P-004 acceptance or shipment.

## P-006 memory cancellation source unit (2026-09-24 15:10Z)

Work item **WI-10002828**. The two-second contract is the existing cold prompt
cache deadline (`MEMORY_BLOCK_COLD_DEADLINE_MS`); the five-second value is an
individual background injection phase limit (`MEMORY_INJECT_TIMEOUT_MS`). They
measure different waits. Neither limit was changed by this source unit.

The cancellation gap originates between the memory query and its embedder:
`embedWithinBudget` rejected only its own timer, `mem0-client` passed text alone,
and `embed-coalesce` had no consumer lifetime. The sidecar client already
accepted a signal, but this path never delivered one. The existing coalescer,
backend options, client seam and deadline wrapper were extended; there is no
new scheduler, admission store, service or flag.

Each coalesced consumer now carries an optional signal. Cancelling one leaves
live siblings intact; the last cancellation aborts upstream. An abandoned
generation cannot populate the vector cache or remove a replacement flight.
Raw promises still settle only when upstream settles: abort is not proof that
native inference exited. The existing tracked deadline/admission mechanism
therefore retains its host lease while non-cooperative work drains. The
injection search phase forwards its existing timeout through this path.
Cancelled query embeds throw instead of returning null, preventing per-scope
legacy re-embedding after cancellation. A cancelled local model initialization
does not proceed into inference.

The original coalescer failed five newly added guards (eight existing cases
passed). The final focused project runs are:

| Suite | Ledger run | Passed |
|---|---:|---:|
| Coalescer cancellation, cache and generation safety | 19303705 | 13 |
| Actual loopback HTTP sidecar and local startup | 19303706 | 18 |
| Memory backend scope, budget and cancellation | 19303378 | 72 |
| Existing client compatibility | 19302433 | 7 |
| Existing hybrid ranking contract | 19302434 | 60 |
| Deadline and raw-work tracking | 19303379 | 27 |
| Injection wiring and existing recall semantics | 19303424 | 83 |
| Cross-worker admission including cancelled native work | 19303707 | 7 |

These runs had zero failures and zero skips. Two exact-shape injection fixtures
initially failed because they lacked the added signal field; they now assert
that field explicitly. A test-mock type error was also corrected. The generic
memory package typecheck passed; the four changed injection/deadline paths
passed scoped operator typecheck (`/tmp/p006-operator-tsc.log`). This does not
assert that the whole operator tree typechecks.

The HTTP tests observe actual request closure after query-budget expiry, one
request and no legacy/retry amplification, and successful delivery to a sibling
with a longer budget. The admission test verifies that a second worker remains
at capacity until a cancelled but non-cooperative embed completes. Those tests
protect transport and resource lifetime; they do not measure production recall
quality. Single-scope legacy mem0 search and already-running native/SQL work
are not claimed physically cancellable.

Still open: end-to-end phase attribution and budget allocation, missing-table
admission diagnosis, the frozen 100-call normal and concurrency-8 delivery
workloads, broader acceptance, and shipment. No 95% within-two-seconds recall
claim is made from these source tests.

## P-006 rendered-delivery measurement (2026-09-24)

`packages/operator-core/lib/memory/bench/prompt-delivery.integration.test.ts`
extends the existing corpus/gold-set/seed and bench-host seams. It runs the
actual hybrid backend, injection renderer and bounded rendered-block cache.
Memory, feedback, surfaced-memory ledgers and recall telemetry all use a migrated
throwaway org database. The separate prose-corpus leg is explicitly disabled,
and advisory feature flags are pinned false. This profile therefore measures
the memory leg in isolation; it cannot establish combined prose delivery or
deployed-runtime acceptance.

The request list is the complete frozen gold set. Eligibility is fixed from
nonempty `expected` keys before searching; failures and empty results remain in
the denominator. A useful delivery must contain a rendered memory ID mapped to
one of those expected keys, with a `ready` caller result within the unchanged
2000ms deadline. Any-context delivery is reported separately. The normal cold
query, normal immediately primed query, and concurrency-eight cold query windows
use the same corpus and ordered requests. Every measured turn has an independent
session and cold rendered-block cache. The client is recreated before each
window; this does not mean the native model or PostgreSQL caches are cold.

Per-call records retain caller/build/availability/search/embed timings, hybrid
leg statistics, retrieved and delivered keys, errors and deadlines. Late builds
are joined after recording the caller outcome, so late delivery cannot be
credited within deadline. Source/corpus/request hashes and resolved embedder
profile are emitted with the measurement.

The first invocation (`/tmp/p006-prompt-delivery.log`) seeded successfully but
failed before measurement because source fingerprint paths assumed the repo
root while `test:file` runs from the package directory. Module-relative path
resolution fixes that instrument error. No delivery result is inferred from
that invocation. The corrected invocation is recorded separately.

The original `agent-obligations:waiting-on` missing-table error is already
corrected in `agent-obligation-reader.ts`: it bootstraps and reads through the
lock package's transaction pool instead of the org pool. The real PostgreSQL
guard `agent-obligation-waiting-on.integration.test.ts` has historical local
failure/pass receipts 19149327/19149335. This is existing source/test evidence,
not a fresh production observation or a new fix in this continuation.

Corrected measurement receipt **19307105** passed both integration tests with
zero skips, on `fc794d786897159f742fe4981242689d54fa1e75` plus local test changes.
The raw per-call records, source/fixture hashes, model profile and units are in
[`tests/evidence/p006-prompt-delivery-2026-09-24.json`](../../tests/evidence/p006-prompt-delivery-2026-09-24.json).
The corpus has 114 entries; each measured window runs all 150 gold queries, of
which 120 have expected relevant keys. Warm priming calls are setup, excluded
from the measured population. Resolved model: Harrier OSS 0.6b, native 1024;
live push contract: cosine 0.58, lexical 0.4, cosine-gated fusion.

| Profile | Calls | Eligible | Useful by 2000ms | Caller p50 / p95 | Search p95 | Post-search p95 |
|---|---:|---:|---:|---:|---:|---:|
| Normal cold query | 150 | 120 | 114 (95%) | 240.14 / 318.36ms | 311.93ms | 8.17ms |
| Normal immediately primed query | 150 | 120 | 114 (95%) | 54.48 / 106.24ms | 62.68ms | 42.17ms |
| Eight-reader cold-query burst | 150 | 120 | 114 (95%) | 240.89 / 469.33ms | 168.86ms | 324.88ms |

Each window had zero caller deadlines and zero recorded errors. Each retained
the same six gold misses (`lg-015`, `lg-030`, `lg-033`, `ei-003`, `ei-016`,
`ss-043`). The expected keys were absent from retrieval on those calls;
`ei-003` delivered a different key. Thus these six misses cannot be attributed
to deadline expiry or renderer removal. Any-context delivery was 115/120,
which is deliberately not substituted for the useful-delivery numerator.

`embedMs` in the raw readings sums individual embed-call durations, which can
overlap; it is work-duration attribution, not wall-clock critical-path latency.
The table's post-search metric is `max(0, buildMs - availableMs - searchMs)`;
it includes remaining rendering/hygiene/composition work, not pure CPU render
time. The burst's larger post-search time is a finding requiring attribution,
not evidence by itself of a CPU or resource bottleneck.

This establishes the 95% clause on the named isolated profile only. The broader
P-006 end-to-end budget/allocation and combined prose path, independent evidence
audit, sustained acceptance and final shipment remain open. No baseline speedup
or production percentile is claimed.

### Falsifiability and exact-clause adequacy

The existing `injection-block-cache.test.ts` guards were run through
`scripts/mutation-probe.sh` with a verified `mutation probe` file lock. Baseline
19307551 passed all eight tests; mutation 19307552 replaced only the delivered
ready block with `null` and failed five delivery assertions. The script recorded
`verdict=caught` and verified byte-identical restoration; the lock was released.
This is a transport/delivery counterexample, while 19307105 supplies the real
corpus quality and timing measurement. No failed mutant remains in the tree.

Bindings 11632 (measurement) and 11630 (caught mutation) target PERF-P-006@1.
The evaluator passed this exact clause and filed card
**EI-24158413223694826**. Independent audit was not yet verified at this write.
Binding 11632 supersedes 11626 to distinguish the active frozen-workload clause
from the broader plan residue; the combined prose path and shipment limitations
remain explicitly recorded above and in the binding. This does not close P-006.

The final benchmark file passes Prettier and `git diff --check`. Scoped
`build:typecheck` reports zero diagnostics in this file with a complete scoped
verdict (15.6 seconds); 23 import-graph diagnostics outside it remain. The full
operator compiler also completed with errors outside this file, and no diagnostic
in this file (`/tmp/p006-bench-tsc.log`). Neither result establishes a clean whole
operator build. A later scorecard read confirmed the independent audit was
pending with a dispatch reservation; no audit PASS is claimed here.

## P-007 native baseline and phase diagnostics — 2026-09-24 16:12Z

WI-10002829 owns this work. The first native run used the existing packaged
release shell selected by WDIO at
`/mnt/data/cargo-target/release/bundle/deb/Papercusp GUI_0.0.20_amd64/data/usr/bin/papercusp-desktop`
(binary timestamp September 16). This is an old-package baseline, not a staging
acceptance result. `DISPLAY` was removed from the runner environment so its
existing driver wrapper provided a private Xvfb display.

Command: from `tools/perf-test/wdio`,
`env -u DISPLAY PAPERCUSP_PERF_RUN_ID=p007-baseline-20260924T1559 npm run test:wdio -- --spec ./specs/plan-popup-open.perf.spec.ts --spec ./specs/smoke.spec.ts`.
Log: `/tmp/p007-native-baseline-20260924.log`; persisted desktop receipt
`perfrun-1790265553071-rrdf99`. Popup **1507ms** exceeded the unchanged **1500ms**
budget. Web Vitals smoke passed with FCP **2457ms**, LCP **3558ms**, and no missing
expected metric. This run does not explain the earlier missing-metric incident.
The sidebar's first candidate was `papercusp/su-agent-behavior`.

Extended the existing User Timing seam and shared `PlanDocumentView` callback:
`content-ready` is cumulative click-to-data-and-React-mount; `renderer-ready`
follows CSS/JS loading; `preview-rendered` follows the awaited Vditor preview.
The original total still ends after shared plan decoration, at `onParsed`.
Phase diagnostics are first-observation-only, bounded to the current interaction,
and do not change the total endpoint or budget. WDIO retains these diagnostics,
the opened plan identity, and resource durations (paths only, no query strings).
`PAPERCUSP_PERF_PLAN_SLUG` can freeze the selected visible sidebar plan; it cannot
silently fall back to a different plan when the requested row is absent.

Source verification: `npm run test:file -- apps/operator/app/_components/perf/perf-marks.test.ts apps/operator/app/admin/plans/PlanEditor.test.tsx libs/generic/ui-primitives/src/PlanDocumentView.test.tsx`
passed **32 tests, zero skipped**, receipts **19311377/19311378/19311379**.
Log `/tmp/p007-phase-tests-20260924.log`: superproject `c36a6834a5` plus local
edits; ui-primitives `287d95c71a` plus local edits. Delayed-render and cancelled
render cases distinguish preparation from actual completion. Scoped app source
typecheck passed with zero requested-file or import-graph diagnostics.

The runner's own typecheck was blocked before checking source by its retired
`moduleResolution=node10` under installed TypeScript 7 (TS5108 reproduced in
`/tmp/p007-wdio-tsc-original-20260924.log`). NodeNext matches the current Node/tsx
runtime and exposed one unsafe optional row lookup, now guarded. `npm test` now
runs typechecking first; `npm run typecheck` and all four existing runner unit
tests pass. The scoped tool's relocated configuration separately failed to find
runner-local ambient types; the successful runner-local check is authoritative
for this project. No pure typecheck is presented as a behavior test.

Remaining: build and exercise the instrumented current UI in the native shell,
attribute and fix the measured latency, investigate any reproduced missing
metric, and retain ten named-build native results plus cold/warm coverage.
The isolated Vite build is queued through the existing heavy-work admission and
singleflight wrappers, output root `/tmp/p007-current-20260924`, log
`/tmp/p007-current-build-20260924.log`. No P-007 acceptance or shipment claim.

### P-007 finer attribution and body-read optimization — 16:30Z

Frozen current UI snapshot `/tmp/p007-native-current-20260924` used the unchanged
native shell SHA256 `ebdba9181122d5da2d5446efd4aebae2f714cd122111845ec96b6ccbb6082a34`.
Its SPA index hash was `7540a6b3723732bd233c425985fbf5330f67ed97d2cfe0911c8de2c7fff1ea06`;
the complete `spa-sha256.json` manifest hashes to
`3e7669728cfaf4252d529c3b6e5cfaf3bde8f76cfb42cac8e1d8d855ed29d719`.
The entry dependency graph reaches the new phase instrumentation. Native result
`perfrun-1790266630922-9f0vyh` was **2630ms**: content-ready2576,
renderer-ready2584, preview-rendered2629. FCP2494/LCP3692 passed. Raw resource
timing was empty, so it supplies no network attribution in this custom protocol.

A second snapshot `/tmp/p007-native-detail-20260924` (SPA index
`ac646930a9dd7d34e63f091f6612eccfc27ea42d7a08a4f2097edc270e80939c`)
adds detail-mounted/data-ready marks. Native receipt
`perfrun-1790266932270-f8qluy` failed at **4081ms**: detail-mounted209,
data-ready3194, content-ready3989, renderer-ready4003, preview-rendered4080.
Thus this run's largest interval is the detail's wait for data; renderer prep and
preview are small. These are diagnostic runs on different snapshots, not a
controlled speedup comparison. Logs are `/tmp/p007-native-current-20260924.log`
and `/tmp/p007-native-detail-20260924.log`. The narrower PlanDetail instrumentation
passes 14 existing tests (19314246); its scoped typecheck is clean in that file,
with 86 diagnostics elsewhere in the loaded graph.

The full plan read unconditionally loads fresh descendant execution history
outside the document cache. The popup does not consume this history. Extended
the existing `plans:get` option set with `includeHistory` (default remains true),
and the existing UI read-dispatch seam supplies false for body reads. Explicit
History headings and prior-attempt references still retrieve history. This
removes proven unused work; its share of the native latency is not yet measured.
No second reader/service/cache was introduced. Tests compare the complete result
apart from history, preserve raw bytes/version, and alternate UI/agent reads
through the same cache to guard against contamination.

`get.cache.test.ts` + `read-dispatch.test.ts`: **39 pass, zero skipped**,
receipts **19314960/19314959**, source `eaa65935fc` plus local edits. Scoped
typecheck: four requested files clean, 23 other graph diagnostics. Logs:
`/tmp/p007-plan-read-tests-20260924.log`. Native improvement remains unverified:
both MCP and explicit :3170 reads still rejected the new option on running
build `c36a6834a5` at 16:30Z. Do not confuse source proof with runtime activation.

Correction to the earlier build note: the command completed successfully, but
the requested `VITE_BUILD_OUT_ROOT` path was absent; the completed build appeared
in the regular dist. The reason is unverified. Both test snapshots were copied
under the existing dist build lock, leaving the native binary unchanged. No
process was killed: cancellation guards refused to signal an unmatched process,
and the original queued command completed normally. No commands remain running.

### P-007 staging activation and native isolation repair — follow-up

The plan-read changes are committed in the canonical tree at `abab84b83d` and
are now active on :3170: an authenticated `plans:get` with `includeHistory:false`
returned `su-agent-behavior` version89 without history. The automatic staging
sync performed the activation; no manual restart was needed. The obsolete
git-sync await196699 was already settled/not found when cancellation was tried;
that call did not itself cancel anything.

A bounded paired diagnostic used the same full/raw plan and warm document cache,
alternating only `includeHistory`, via the existing `code:run` tool after a recipe
search returned no match. Version89/content hash
`042f83e599a6f2bbee674297754fe0cbc5539050efd2ec077f6bc3de168f5750`
stayed identical. Server tool-wall samples in order:

| includeHistory | milliseconds |
| --- | ---: |
| true | 34 |
| false | 176 |
| false | 8 |
| true | 18 |
| true | 206 |
| false | 8 |

This small diagnostic establishes neither a native speedup nor history loading
as the cause of the older multi-second popup delay. Native backend selection
and client-side/transport timing still need the controlled comparison.

**EI-24161953656319715:** the server's established `PAPERCUSP_HOME` override was
honored by `serve.ts` and the JS host-platform reader, but native Rust HTTP and
IPC discovery joined the default workspace home. A real Cargo regression used
two temporary discovery roots and ran each environment case in its own child
test process. The original production reader returned port40001 instead of the
explicit isolated port40002 (receipts19318917/19318918). This is a measured
discovery mismatch, not evidence that an actual user operation crossed instances.

The existing native discovery path now shares `native_papercusp_dir`: HTTP,
raw/validated IPC, the recovery reader and debug IPC initialization honor the
override; unset/empty preserves the default, and a missing explicit directory
does not adopt another instance. Existing WSL/default-discovery tests also run
their environment cases in isolated child processes to avoid parallel-test races.
Final `main.rs` SHA256:
`0471cbdbc9857987a28e545e8c4ea8180ce44fdbf5edeb3eab703cf7ec2738d9`.

Project command:
`env PC_HEAVY_COALESCE=0 scripts/pc-heavy.sh node scripts/report-cargo-tests.mjs --manifest-path papercusp-desktop/src-tauri/Cargo.toml -- discovery --nocapture`.
**64 tests passed, zero failed/ignored**; final regression receipt19318988
(earlier isolated pass19318923). Logs are
`/tmp/p007-native-discovery-control-20260924.log` and
`/tmp/p007-native-discovery-suite-20260924.log`. A post-edit attempt without the
coalescing opt-out replayed the old failure instead of executing new source;
that result is explicitly not new test evidence (EI-24162290157408503).

The fresh release-shell build is still queued through `pc-heavy`; log
`/tmp/p007-native-release-build-20260924.log`. Its artifact will use the frozen
current SPA and a private `PAPERCUSP_HOME` containing the fresh :3170 discovery
advertisement, preserving the real user's home/preferences. Full GUI validation
of the discovery fix and P-007's ten-run native acceptance remain open. No
shipment claim; the discovery work-item remains owned until runtime proof.
### P-007 fresh release GUI on staging — further evidence

The release binary built from the repaired native source is
`e41628e003effa300146c646ad820b79fa0a0607d2412b2d460c0581cb50d5c0`.
Its build completed through `pc-heavy` (`/tmp/p007-native-release-build-20260924.log`).
The complete private test artifact at `/tmp/p007-staging-native-v2-20260924`
paired that shell with staging UI index
`1ba14a354070f1d517bbdfe58b281fc750f4e3e58ca4e6de8156a31b3d303611`.
The private `PAPERCUSP_HOME` contained an operator.json derived from a
PID/port-verified live :3170 IPC advertisement; that PID answered `/api/health`.
The existing WDIO runner used private Xvfb, its documented stage report URL,
and `PAPERCUSP_DEV_API_TARGET=3170` to prevent a persisted environment choice.
The user's real desktop preference file had the same digest before and after
both native runs. The release GUI mounted the stage Plans view and rendered a
real plan, completing runtime verification for the discovery fix
**EI-24161953656319715** (resolved). Cargo proof above remains its recurrence
guard; macOS/Windows packaged runtime was not exercised.

The first attempted frozen slug `su-agent-behavior` was not visible in this
sidebar and correctly produced an **UNMEASURABLE** run with zero candidate
rows (`/tmp/p007-native-v2-staging-20260924.log`); it is not a speed result.
Using the same artifact and the visible
`papercusp/goal-agent-behavior-feedback-2026-09-06` plan:

| run | popup ms | detail mounted | data ready | content ready | renderer ready | preview rendered |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| first | 5767 | 1853 | 4994 | 5583 | 5592 | 5760 |
| repeated, slug pinned | 2457 | 408 | 1722 | 2275 | 2284 | 2450 |

Both runs exceed the unchanged **1500ms** popup budget and were recorded by
staging as `perfrun-1790269938151-rn3167` and
`perfrun-1790270296139-s9vrqe`. Logs are
`/tmp/p007-native-v2-discover-20260924.log` and
`/tmp/p007-native-v2-pinned-second-20260924.log`. These two valid timings
falsify acceptance for this build/profile; do not fill a ten-run success card.
The request/response split and its code-change effect were not present in that
served UI, so the data-ready interval is not yet attributable to backend,
transport, or React work. The resource timeline remained empty.

To resolve that attribution, the existing `fetchPlan` path now marks request
start and parsed response, suppressing a response mark after cancellation.
`plans-api-result.test.ts` passes **17 tests** including a delayed cancelled
response; its two changed TypeScript files have a clean scoped typecheck.
Log `/tmp/p007-request-phase-tests-20260924.log`. Staging source now contains
these marks and its newer UI bundle index hashes to
`6a2421698ff114c5da0b20afa4905200065664aca7f56fad0e80d3c472413c58`;
the maintained staging sync was activating at this write. The next native
measurement must pin the same visible plan and record that served build identity.
P-007 and overall shipment remain open.

### P-007 request/response split on the served staging UI

The maintained staging sync completed and `/api/health` returned 200. The
served staging UI index hashed to
`6a2421698ff114c5da0b20afa4905200065664aca7f56fad0e80d3c472413c58`
and its compiled assets contain the new `request-started` / `response-ready`
marks. The release GUI artifact remained binary
`e41628e003effa300146c646ad820b79fa0a0607d2412b2d460c0581cb50d5c0`;
its private `PAPERCUSP_HOME` was refreshed from the new live :3170 discovery
advertisement (PID2063159, health200). The real desktop preference digest
remained unchanged.

For the same visible `papercusp/goal-agent-behavior-feedback-2026-09-06`
plan, the official packaged WDIO popup spec measured **2919ms** against
**1500ms**, staging receipt `perfrun-1790271276438-mkc1da`, log
`/tmp/p007-native-v2-request-response-20260924.log`:

| cumulative click-to-phase | milliseconds |
| --- | ---: |
| detail mounted | 449 |
| plan request started | 635 |
| response JSON ready | 2082 |
| data state ready | 2106 |
| content ready | 2743 |
| renderer ready | 2750 |
| preview rendered | 2913 |

The request through parsed JSON took **1447ms**; React data state followed
24ms later. Content readiness added 637ms after data state, and preview
rendering added roughly 170ms. Resource-timing entries were absent under the
native custom protocol. Three later direct loopback GETs for the same plan,
`mode=full`, returned HTTP200 with 194163 bytes each; their tool-wall times
were **765/245/409ms**. They were sequential warm reads through a different
transport and do not by themselves assign the native delay to backend or IPC.
The popup remains over budget; a ten-run PASS is unsupported.

The staging sync needed roughly eleven minutes before the API bound :3170:
unit start13:22:04 EDT, health200 by13:33:18. Its PID stayed stable and a
ten-second sample advanced **9.97 CPU seconds** while process state was R.
This measures CPU-active startup but not which code path consumed it; no
generic host-load cause is claimed. The service eventually recovered.
**EI-24165259633128552** is assigned for root-cause profiling and a startup
regression guard; P-007 work could proceed once the API was healthy.

### P-007 REST reader coverage correction — 2026-09-24

The previous `includeHistory:false` optimization covered `callPlansReadRaw`,
the live-query reader. The actual popup uses `fetchPlan` → REST `dispatchRead`
in `endpoint-route/routes/admin/plans.ts`, which independently prepared the
tool request and still requested descendant history. The earlier claim that
the popup's body-read optimization was active was therefore incomplete.
The running REST endpoint returned a `history` field (10553 serialized chars)
for `goal-agent-behavior-feedback-2026-09-06`, version75, content hash
`b93fd310da29722b856fb4f7281e866af7fc0fbf94722ee0e74bca4c563cfbb0`.

The existing REST reader now defaults `includeHistory` to false for `get`,
preserving full payloads, raw bytes and explicit opt-ins. The existing query
boolean allowlist now converts `includeHistory=true/false` to booleans.
Explicit History headings remain forwarded (the real tool's existing cache
tests cover their precedence). Other read verbs are unchanged.

Before the fix, the new REST route tests failed three cases: missing default
omission, explicit true, and explicit false. Control log:
`/tmp/p007-rest-history-control-20260924.log`. After the fix, REST route,
live reader and real tool cache suites passed 47 tests. The combined run also
caught the existing coercion allowlist expectation, which needed the newly
supported key; after updating that expectation, its 9 tests passed. Zero
skipped across these 56 cases. Logs:
`/tmp/p007-rest-history-tests-20260924.log` and
`/tmp/p007-rest-history-coercion-tests-20260924.log`. The four changed source/test
files passed scoped typecheck (`/tmp/p007-rest-history-tsc-20260924.log`) on
`6325d8e8b7` plus local edits. This guards the actual popup route, which the
earlier live-reader-only test missed.

A small paired tool-wall check on the same version/hash returned milliseconds
`true:851, false:190, false:32, true:133`. Both false reads omitted history;
both true reads retained it. This is a warm server diagnostic, not a native
latency acceptance result. Staging still served the pre-fix REST reader at
the time of this check; native performance remains open.

### P-007 active REST fix and visual preparation experiment

Git-sync committed the REST fix in `a48f6294fb`. The maintained staging sync
waited for its active-client deferral ceiling, then built and restarted :3170.
Before the next native run, health reported that exact source and REST omitted
history. The pinned plan stayed at version75 with the hash recorded above.
The same release shell and private discovery root attached to PID1321809.

The native popup still failed: **2330ms / 1500ms**, receipt
`perfrun-1790273512555-7dpmg5`, log
`/tmp/p007-native-rest-history-20260924.log`. Cumulative phases were
mounted374, request544, response1535, data1555, content2124, renderer2133,
preview2321. The request interval was991ms; data-to-preview-preparation added
569ms. The real desktop preference digest and the plan revision/hash were
unchanged before/after. One before/after sample does not establish a speedup
distribution; this result still falsifies acceptance.

The next source experiment starts the shared `PlanDocumentView` visual
preparation in a layout effect rather than a passive effect. This starts asset
preparation before the initial empty-preview paint; it preserves asynchronous
asset loading, real render completion, cancellation, and the existing timer
end. The hypothesis is that this removes part of the measured post-commit gap;
native impact is not yet verified.

The new React lifecycle guard observed false before the source change: the host
finished its visual commit before preview preparation began. Its first fixture
also unmounted before the asynchronous preview drained, disturbing the next
test; the fixture now awaits completion before cleanup. Final shared suite:
14 pass, including render completion and cancellation, log
`/tmp/p007-layout-final-tests-20260924.log`. Operator PlanEditor/PlanDetail:
19 pass, log `/tmp/p007-layout-tests-20260924.log` (that earlier combined run
also records the fixture failure). Zero skipped. Full ui-primitives typecheck
passed, log `/tmp/p007-layout-typecheck-20260924.log`. Source is superproject
`a48f6294fb`, ui-primitives `8713ca5d25` plus the two local file edits.
The next native run must verify that the served SPA includes this experiment.

#### Layout experiment activated and measured — 18:29Z

The layout edit committed as ui-primitives `4bfdeb7`, included in superproject
`bd4a524d6e`. Maintained staging sync completed at 18:28:37Z with that exact
health SHA. The disk SPA index SHA256 is
`4e6c749f0bec1b86a1c34509af0ab150e323bc44bb2c0fee2db15d3d00fe5f58`.
An initial byte-equality preflight failed: `host-spa.ts` injects bootstrap
globals into served HTML (49,935 bytes versus the 38,729-byte disk file).
Both reference `index-f6e25fef.js`; the served `src-3571ba8d.js` is byte-identical
to the built asset and contains the layout-effect implementation.

The same release shell and pinned plan version75/hash above measured
**3112ms / 1500ms**, receipt `perfrun-1790274593311-ntni06`, log
`/tmp/p007-native-layout-20260924.log`. Phases: mounted429, request637,
response2276, content2294, data2295, renderer2948, preview3106. The user's
desktop preference digest remained unchanged. Preparation now begins before
the parent data-ready mark, but async renderer readiness still adds654ms.
The request interval was1639ms. This is a failed experiment for total latency,
not evidence of a speedup. A new `styles-ready` phase separates the CSS await
from the JS import; acceptance and the total timing endpoint remain unchanged.

#### Browser queue attribution — 18:39–18:43Z

These are Chromium diagnostics on staging `bd4a524d6e`, not native acceptance.
A fresh browser must open `/adv?opcv=plans&ws=papercusp-workspace`: visiting
`/?opcv=plans` first redirects and drops the sidebar parameter. That initial
attempt timed out without a profile; the corrected route opened the pinned plan.

The first CPU/trace capture measured3117ms. `request-started` preceded
`ResourceSendRequest` by1189.54ms; HTTP headers then arrived1215.43ms after
network request start. Files: `/tmp/p007-chromium-20260924.cpuprofile`,
`/tmp/p007-chromium-20260924.trace.json`, and the distilled
`/tmp/p007-chromium-profile-20260924.log`. Profiling startup itself took524ms
before the click; this run is diagnostic and does not establish a distribution.

The existing `installOriginSchedulerFetch` wraps plan GETs. A second diagnostic
wrapped its existing scheduler's `run` callback to timestamp queue admission
without changing the scheduler policy. Its before-click snapshot reported
browser-http, limit2, inFlight2, queued7 (six foreground, one background).
The plan GET waited307ms before its callback began and took26ms inside the
callback; total popup1025ms. Log `/tmp/p007-origin-queue-20260924.log` contains
the snapshot, per-request timestamps and phases. This directly measures a queue
contribution in the browser. It does not establish the native IPC profile or
justify changing concurrency limits. Next native diagnostics should include
the existing scheduler snapshot alongside the CSS/JS split.

#### Native scheduler counterevidence — 18:46–18:48Z

The existing WDIO spec now logs the public `window.__sync_metrics__.snapshot()`
scheduler before clicking and after rendering, plus phases/scheduler on an
unfinished attempt. No scheduler setting or timing budget changes. The first
native attempt timed out without a measure; `/tmp/p007-native-scheduler-20260924.log`
is **UNMEASURABLE**, with no timing receipt. Before-click limit24, queued0 and
inFlight2 were observed; that alone cannot attribute the later timeout.

The next run exercised the completed diagnostics and measured **2482ms / 1500ms**,
receipt `perfrun-1790275714275-dq4kyx`, log
`/tmp/p007-native-scheduler-timeout-20260924.log`. Before/after snapshots both
had limit24, queued0, inFlight0. Foreground `waitMsTotal` grew13852→13853ms
across ten admissions, so the origin scheduler's foreground queue cannot
account for the roughly1100ms request interval in this run. The snapshot's
`profile` string still says browser-http despite limit24; the numeric limit is
the actual configured cap, not an inference from that label.

Cumulative phases: mounted386, request568, response1667, content1684,
data1685, renderer2305, preview2475. Renderer readiness added621ms. Staging
still served `bd4a524d6e`, before the CSS phase diagnostic. Native IPC queueing,
server work, and webview readiness remain to be distinguished; browser queue
findings must not be generalized to these native runs.

The server ledger supplies a further boundary: invocation29449924 at
18:48:32.050Z is the matching `plans:get` for the pinned slug, modefull,
client`pc-admin-plans-ui`, serving build`bd4a524d6e`; duration850ms, statusok.
The 18:47 timeout attempt's matching invocation29449772 completed in1189ms.
`dispatch-stack.ts` creates `startedAt` before dispatch gates/handler and records
`Date.now()-startedAt` before awaiting the invocation sink. These are dispatch
durations, not database-only or handler-only timings. The850ms accounts for a
substantial part of the successful native attempt's1099ms request interval;
it does not yet identify the expensive server stage.

### P-007 continuation: fixture corrections and main-thread attribution

On 2026-09-24 at 19:31–19:33Z, the current native fixture finally emitted
the required request, response and styles phases. The unchanged release shell
is `e41628e003effa300146c646ad820b79fa0a0607d2412b2d460c0581cb50d5c0`;
the private packaged SPA was refreshed from staging and its index hashes to
`0827ecc7a9deb38bae87fd90a4c6f4a9c185e5785382315a24e6d658831ed3c5`.
The plan remains `goal-agent-behavior-feedback-2026-09-06`, version75,
content hash `b93fd310da29722b856fb4f7281e866af7fc0fbf94722ee0e74bca4c563cfbb0`.
Staging API `b8d4fc9b8b` was PID2562881.

Several intervening attempts were invalid setup evidence, not latency results.
The native client reads the private **default** `endpoint-ipc.json`; refreshing
only `endpoint-ipc.3170.json` left it pointed at a dead process. A maintained
WDIO preflight now checks the default record's live PID, matching port and Unix
socket. Five runner unit tests pass, including a real socket fixture with stale,
wrong-port and dead-PID counterexamples; runner typecheck passes. The initial
`.pc-opchat` diagnostic was also wrong: the actual selector is `.op-chat-sidebar`.
Finally, a copied packaged SPA has no HTTP bootstrap workspace injection. The
runner now accepts an explicit workspace before document mount and searches
for its pinned row through the existing `plq` control. The apparent seven-row
plans-list defect was retracted: explicit workspace requests return the pinned
plan. `EI-24172206815197035` is dropped; it is not cache-corruption evidence.

`/tmp/p007-native-styles-current-20260924.log` measured2720ms but lacked the
new phases because the packaged SPA was still the older snapshot. It does not
measure the CSS diagnostic. Expected phases can now be required before the
runner records or publishes a timing.

The valid scoped run measured **3220ms**, receipt
`perfrun-1790278279684-g52hre`, in
`/tmp/p007-native-styles-scoped-20260924.log`. Content-ready2461ms preceded
styles-ready3044ms; JS-ready followed at3045ms. A second, optional microtask
diagnostic distinguishes CSS transfer from synchronous main-thread delay:
content-ready1170ms, queued microtask1757ms, styles1758ms, renderer1759ms,
preview1936ms, total **1944ms**. Receipt `perfrun-1790278412546-bgcamk`, log
`/tmp/p007-native-styles-microtask-20260924.log`. The queued microtask itself
waited587ms, so calling this delay a CSS download would be wrong. It is main-thread
work after the layout effect starts; the expensive commit/layout operation is
still unidentified. Request-start561ms to response1150ms remains a separate589ms.
No 1500ms acceptance or shipment claim is supported.

The next native probe identifies the effect: the actual production React
`usePlanDocumentTheme` callback took **672ms** within a685ms content-to-microtask
interval. Its registration stack maps to `ct` in `src-5132942f.js`, line2,
column21154, which is that hook. Log
`/tmp/p007-native-react-effects-20260924.log`, receipt
`perfrun-1790278862635-q7hxdv` (2313ms total). The hook resolves computed root
styles in its initial state initializer, then calls `sync()` again from its
mount effect, forcing a second style read after the plan DOM is committed.
A separate Presence effect took143ms. A prior DOM-method probe found no
individual wrapped operation over10ms; it did not cover computed-style access.

The source fix preserves theme resolution and live-change listeners. It saves
the cheap theme attribute, inline-style and media inputs at the initial read,
then skips the second read only when those inputs remain unchanged after
subscriptions attach. The same duplicate-read pattern in MarkdownEditor is
fixed. A new project regression failed before the fix (two root computed-style
reads versus one expected) and passed after it. Another test changes the theme
between render and the subscription effect and still observes the new theme.
Shared reader16 tests, PlanEditor5 tests and MarkdownEditor17 tests pass, zero
skipped; shared-library typecheck passes. Logs:
`/tmp/p007-theme-control-tests-20260924.log`,
`/tmp/p007-theme-final-tests-20260924.log`, and
`/tmp/p007-markdown-theme-tests-20260924.log`.
After the owner lifted the pause, the private source build was verified as
SPA index `938a51916940a30806f1947fc96b4331bf005496d9d9099df67d77e28b6e8f9a`,
theme bundle `src-7b77f707.js`, with the same native shell and pinned plan.
API source had advanced to `0c6826c5e6`, PID2690831. The native run at20:36Z
completed: content-ready1804ms, queued microtask1814ms, styles1814ms,
renderer1815ms and preview1977ms. The former roughly600ms theme delay is
now10ms in this sample. Total **1983ms** still fails1500ms; request-start286ms
to response1783ms is now the largest measured interval (1497ms). This is
phase-level source-fix verification, not whole-P007 acceptance or a controlled
distributional comparison of total latency across API builds.
Log `/tmp/p007-native-theme-resume-20260924.log`. Its report upload returned
HTTP408 (`route exceeded 30s`), so there is no accepted publish receipt.
The local timing remains evidence; persistence requires separate reconciliation.

At20:43–20:45Z that reconciliation found the row: **`perfrun-1790282211518-bjovxk`**,
workspace `default`, status `fail`,16 measures, source
`0c6826c5e63cd3c1aad720c2da2b5d11da1e3307`. The stored1983ms total and phase
values match the local run. The runner does not send its UI workspace to this
publisher, so the earlier `papercusp-workspace` filter also missed known-positive
receipts; it could not establish absence. No upload retry was made. HTTP408
described the response failure, not absence of the durable write.

Server invocation **29459524**, `plans:get`, started20:36:49.446Z and took1446ms
inside the1497ms native request interval. Its arguments name the pinned plan,
`mode:full`, `includeRaw:true`, `includeHistory:false`, and the
`pc-admin-plans-ui` client. Dispatch duration includes middleware, handler and
result processing; it is not DB-only time. The foreground scheduler wait total
did not rise during this popup. This isolates substantial cost to the server
dispatch, without yet identifying a handler substage.

The current source extends existing invocation metadata with `plansGetRead`:
per-slug cache wait and wall times between source, issue-block, linked-feature,
coverage, liveness, lifecycle, rubric/audit, stale-path and shaping stages.
It snapshots each call outside the cached payload; a cache hit cannot inherit
an earlier build's measurements. Nine project tests passed in
`/tmp/p007-request-stage-tests-20260924.log`, including controlled75ms source
and125ms audit costs followed by a zero-build cache hit. That initial run was
unscoped; a final harness-scoped verification is still required after the last
source adjustment. The instrumentation is not yet runtime attribution.

Separately, upload regression test19345699 held the optional trend notification
after resolving the durable insert. The handler withheld its response:7 tests
passed and the new case failed as expected. The source now acknowledges the
committed row without awaiting that notification, using the existing polling
fallback. This proves and fixes the acknowledgement dependency; the historical
408's exact substage remains unknown. Final post-fix tests were refused before
execution while WI-10002932's separate in-tree mutation probe was active.
EI-24176734149355374 remains open pending verification; P-007 acceptance and
shipment remain open.

After that probe restored, run `21113ae7-964b-4d52-9750-2b8f9e158772`
passed17 tests with zero skips: ingest8 (`19348261`) and plan-read9
(`19348262`). Scoped typecheck caught a test-only `Response | Promise<Response>`
union; the test now normalizes it with `Promise.resolve`. The follow-up
typecheck reports zero errors in the four edited files, with23 other
import-graph diagnostics. The final ingest-test rerun after that typing
correction was fenced before execution by a newer, separate read-merge mutation
probe. Existing git-sync is active and reporting progress; neither those
source checks nor the acknowledgement fix establishes a native latency pass.
Current `PERF-P-007@1` requires ten valid native runs, each at most1500ms,
on the accepted build and frozen measurement profile.

The staging sync incident is separately fixed under `EI-24170757950252845`:
launcher stderr no longer contaminates its JSON receipt, and scheduled but
unobserved restarts enter the existing bounded wait, requiring a new PID and
exact source before success. The project Vitest suite passes65 tests, zero
skipped, including actual shell-fragment tests for mixed streams and pending
success/old-PID/wrong-source/refusal cases. Log
`/tmp/p007-staging-pending-final-tests-20260924.log`. Completion was recorded
as proposed pending commit identity settlement, not shipment.

### P-006 exact-clause audit follow-up

The old audit `EI-24158603642923031` reported a risk-floor replay disagreement
across evaluator builds. Current evaluator `6325d8e8b7` remeasured the unchanged
bindings11632/11630 and passed their exact-clause adequacy. New card
`EI-24166847672168490` received independent **PASS** via
`EI-24167243921891262`, auditor `role-7c9f52e2-d775-4696-a737-1b6d8723b182`,
at2026-09-24T18:07:59.863Z. Historical failed records remain intact. This is
exact `PERF-P-006@1` test adequacy; combined prose/budget/sustained acceptance
and whole-P-006 closure remain open.

### P-007 source and lifecycle timing boundaries — 2026-09-24 22:03Z

The native 21:46 run remains a failure at 1709ms. Its matching dispatch
29467611 measured source483.036ms and lifecycle288.304ms, but those totals
cannot distinguish pool setup from the query, parsing, or module loading.
The separate admin EXPLAIN is not evidence of the native app-role query time.

The existing `plansGetRead` invocation metadata now includes request-local
`detailMs`: source scope resolution, acquisition plus BEGIN/workspace setup,
query, transaction finalization, row conversion, and plan parsing; lifecycle
reader import, acquisition/setup, query, and finalization. These are wall
intervals, including event-loop scheduling; `query` is not PostgreSQL CPU time.
No query or RLS behavior changed. Cached responses carry no previous timing
sample, and timing data stays outside the plan payload.

Run `4fbb96db-8a8c-46c3-bb42-054be542dc9a` passed36 tests with zero skips:
read-timing19358076, lifecycle19358075, get-lifecycle-scope19358077, and
get-ship-readiness19358078. The clock-controlled attribution guard distinguishes
7ms from250ms queries while keeping100ms setup,3ms finalization, and11ms parse
separate. Scoped typecheck found zero diagnostics in the five changed source
and test files, with23 other import-graph diagnostics. Native measurement on
the activated diagnostic build is still required; these checks establish the
measurement boundaries, not an improved popup latency or acceptance pass.

The diagnostic source landed through5c78c636e3 andc1e041d09f (the latter
contains the former). Native run `/tmp/p007-native-detail-stages-20260924-2230.log`
used APIc1e041d09f/PID3465319 with the unchanged e41628 shell and938a5191 SPA.
It failed at1938ms and acknowledged16 measures as
`perfrun-1790289058794-3onqcz`. Matching invocation29474293 took1067ms,
including900.429ms in the plan handler. Source took312.950ms:42.793ms
acquisition/setup,82.922ms query,186.332ms finalization,0.102ms row conversion,
and0.733ms parsing. Lifecycle took425.918ms:413.049ms acquisition/setup,
10.395ms query and1.945ms finalization. This sample isolates the expensive
intervals; it does not establish a database-only cause for their wall time.

The next source change embeds the existing active-acceptance statement in the
plan's existing app-role SELECT, then uses lifecycle's existing pre-resolved
signal input. It preserves the shared SQL predicate and workspace filtering;
the separate admin rubric-summary reader has different failure/scope semantics
and is not substituted. Optional enrichment failure falls back to an ordinary
source read with an undefined signal, leaving the existing guarded lifecycle
lookup to distinguish unknown from measured absence.

Runf426c78e-9082-422f-a791-fe6419c5b231 passed the real PostgreSQL prefetch
suite and four existing unit files. The PG cases compare both workspace
results with the standalone reader, exclude inactive/archived/instance rubrics,
assert one source transaction, and exercise measured absence and failure
fallback. Final getter wiring test19358223 passed5 cases, zero skipped.
The scoped six-file typecheck is clean, with23 other import-graph diagnostics.
This optimization still requires commit, staging activation and native proof.

### Staging cutover safeguards discovered during P-007

EI-24180022773715880 now prepares the pinned target schema before stopping the
ready API, reusing `applyPendingMigrationsNow` and its backup rendezvous,
reservation, compatibility and snapshot guards (planD-003). Existing boot logic
can then handle a backup starting after preparation because the target has no
pending migration. Real-PG test19358159 passed, including that late-backup case;
final shell test19358229 passed71 cases, zero skipped. A real invocation logged
`target schema prepared: {"applied":0,"failed":[]}` before its restart request
at22:28:48Z. The stale engineering runbook was corrected through docs:author
and independently read back. This complements da314's migration-lint preflight.

EI-24183493174271355 arose when editing the long-running sync script shifted
the bytes Bash had not parsed yet. Both file versions passed `bash -n` while
the running process failed at a later offset. The existing script-snapshot
launcher now wraps the staging systemd entry and its mutable setup helper.
A deterministic FIFO regression rewrites the paused source: the raw launch
loses its original tail, while the snapshot preserves it. All9 launcher tests
passed (19358162). The tracked drop-in matches the installed file byte-for-byte,
systemd reports the wrapper in ExecStart, and the subsequent configured sync
completed successfully. These fixes and their source proof do not constitute
popup acceptance or final promotion.

### P-007 native prefetch result and independent enrichment reads

At23:32Z the unchanged native shell e41628 and SPA938a5191 against staging
19d7b93dda measured2013ms, failing the1500ms budget. Both private IPC
descriptors were refreshed against PID4048595 before the run. Log:
`/tmp/p007-native-prefetch-20260924-2332.log`; acknowledged16-measure result:
`perfrun-1790292738503-hir31n`. Cumulative request-start was343ms,
response1657ms, content1702ms, styles1716ms and preview1999ms.

Matching server invocation29485066 took1085ms, with1060.250ms in the plan
read. Source was76.741ms and lifecycle0.288ms, confirming the pre-resolved
lifecycle path was used. Issue blocks took319.679ms and test coverage553.648ms;
linked features19.047ms, rubric/audit46.231ms and stale paths44.243ms. These
are wall times. Earlier post-carry invocations29479951 and29480469 also had
source near25ms and lifecycle below1ms, with different slow enrichment stages.
This proves the extra lifecycle transaction is removed; it does not prove
native acceptance or a controlled distributional speedup.

The existing getter now overlaps the independent issue-block, linked-feature,
coverage and Now reads, joins their results before lifecycle, and overlaps
rubric/audit with stale-path inspection. Query predicates, cache identity,
selection and advisory failure behavior remain the same. Timing metadata says
`wall-time-per-stage-overlapping`: stage durations are no longer additive.
The new controlled rendezvous test holds issue blocks pending and requires
features/coverage to start before release, then checks returned badges and
lifecycle freshness. A second case verifies failed badge reads preserve the
plan and issue blocks. Final lifecycle suite19368600 passed7/0skipped; existing
shape, item, heading and ship-readiness suites19368590/91/93/94 passed43/0skipped.
An earlier new-test failure19368592 exposed a partial mock missing the real
timestamp normalizer; it was corrected before the final pass.

Both staging incidents are now closed with committed completion authority:
EI-24180022773715880 and EI-24183493174271355. After the initial snapshot
integration, setup required an adjacent `dependency-generation.sh`; the
existing snapshot launcher now copies adjacent shell helpers too. Final suite
19358689 passed10/0skipped, including mutation of that helper while paused.
Configured staging sync completed0 at23:28:11Z and `/api/health` returned
HTTP200/19d7b93dda at23:30:24Z. These are staging observations, not shipment.

### P-007 resumed native runs and response attribution — 2026-09-26

The owner explicitly resumed this lane. The frozen packaged GUI still has shell
SHA256 `e41628e003effa300146c646ad820b79fa0a0607d2412b2d460c0581cb50d5c0`
and SPA index SHA256 `938a51916940a30806f1947fc96b4331bf005496d9d9099df67d77e28b6e8f9a`.
The pinned scenario remains `goal-agent-behavior-feedback-2026-09-06` in
`papercusp-workspace`, with both private IPC descriptors refreshed from the
live staging process before valid attempts.

| Staging API | Native log | Popup | Receipt | Verdict |
| --- | --- | ---: | --- | --- |
| `e44f174741` | `/tmp/p007-native-parallel-20260925.log` | 1010ms | `perfrun-1790380359573-8qzzkp` | pass |
| `e44f174741` | `/tmp/p007-native-parallel-20260925-run2.log` | 3591ms | `perfrun-1790380454630-bikpyk` | fail |
| `4c847070f7` | `/tmp/p007-native-parallel-20260925-newapi.log` | 3068ms | `perfrun-1790380776510-7bygjw` | fail |

Each valid receipt contains 16 persisted measures. The 3591ms run's request
interval was 317–3404ms; matching `plans:get` invocation29618758 spent
1010ms in the server, including a 761ms plan read. The 3068ms run's request
interval was 823–2783ms; invocation29619811 spent1441ms, including a
1391ms plan read and an 833ms rubric/audit stage. The unmeasured difference
between browser request interval and handler duration must not be called
database time. The current UI code now marks response headers separately from
parsed body so the next activated SPA can distinguish transport from JSON
processing. Its result test passed17 cases and scoped typecheck was clean.

In the existing server getter, rubric/audit depended only on the plan row but
started after issue, feature and coverage enrichment. It now starts with those
reads on full/sections requests; meta, heading and decision-narrow requests
still skip it. The new rendezvous guard requires rubric and audit to begin
before held issue-block work can finish, and narrow-request cases assert the
reads are skipped. Project run `03ee341e-2833-47ff-9627-f2eba1b43fd9` passed
39 tests with zero skips across four getter suites; scoped two-file typecheck
and diff check passed. This is source proof only: the overlap edit was still
uncommitted and had no native result at this write.

The WDIO publisher used the UI scenario workspace for selection but omitted
it from the ingest payload. A same-instrument positive-control database read
found the three receipts under `workspace_id=default`, not
`papercusp-workspace`; the publisher also stamped checkout HEAD as `git_sha`,
which does not identify this frozen GUI or its staging API. The publisher now
passes the selected workspace through the ingest route's existing
`workspaceId` field. Its Node suite passed9 tests and typecheck passed; a
new published receipt must verify the fix after activation. The checkout SHA
remains only a checkout correlation; the shell, SPA and API identities above
are the measured build profile. A separate native WebDriver mount termination
produced no popup timing and is excluded from the valid-run set.

`PERF-P-007@1` still requires ten valid native runs on one accepted build,
every popup at most1500ms. These results falsify acceptance on the measured
builds. FCP/LCP, independent acceptance, D-003 semantic activation audit and
final shipment remain open.

### P-007 response-header run and acquisition split — 2026-09-26

The live Git worktree registry places branch `staging` in the primary
`papercusp` checkout; the similarly named
`papercusp-staging` checkout is detached. The live staging systemd unit's
`WorkingDirectory` is `apps/operator` in that primary checkout, so the
detached checkout is not evidence of which source the running API loaded.
The private packaged fixture was copied to
`$HOME/.papercusp/perf/p007-native-current` so manual file locks
could cover fixture edits. Its shell SHA256 remains `e41628e003effa300146c646ad820b79fa0a0607d2412b2d460c0581cb50d5c0`.
The refreshed SPA index SHA256 is
`e054e7cbac4e5eba6119adcc42d1f74ecbbeca00ca0c27519a61bce782327c41`;
its assets contain the new `response-headers` mark. Both private IPC descriptors
were copied from the PID/socket-verified live port3170 advertisement. The API
health endpoint reported build `64c532cb38` before the run.

The required-phase packaged WDIO run
`p007-64c532-e054-20260926-r01` measured **4817ms**, failing the1500ms budget.
Its click-to-phase readings were request-start336ms, response-headers4503ms,
response-ready4516ms, and preview-rendered4809ms. The browser request to
headers interval was4167ms; JSON parsing contributed13ms. The UI scheduler's
foreground-read queue-wait total rose only1ms across the popup, so its own
queue is not the observed multi-second interval. Log:
`$HOME/.papercusp/perf/p007-native-current/run-001.log`.
The publisher wrote16 measures as receipt `perfrun-1790383531556-u5sub5` with
`workspace_id=papercusp-workspace`, confirming the workspace payload fix at
runtime. Its `git_sha=5c56b715cb4ed6e0d5f0d702048d51267ae15f1d` identifies
the WDIO checkout, not the shell, SPA or staging API.

Matching `plans:get` invocation29625800 on API build64c532 took2801ms.
The plan-source read took1964ms, including1913ms before the source query;
the query itself took46ms. Rubric/audit took519ms and stale paths428ms,
with those enrichment stages overlapping. `source.acquireAndSetup` currently
combines pool wait, connection/BEGIN and transaction-local workspace setup;
this run does not identify which subphase caused the1913ms. Earlier valid
failures' matching invocations29618758 and29619811 spent9ms and7ms there,
respectively, so the cost is variable. The browser-to-server residual is also
unattributed; no database-only claim is supported by the4167ms interval.

A same-build second attempt, `p007-64c532-e054-20260926-r02`, lost its
WebDriver session while waiting for app mount. It produced no popup measure or
receipt and is excluded from acceptance. Log:
`$HOME/.papercusp/perf/p007-native-current/run-002.log`;
the existing mount-termination issue is EI-24280898105217857.

The existing `withWorkspace` options now offer a diagnostic `begin` / `ready`
callback, and the plan-source timing adds `source.waitForBegin` (pool wait,
connection and BEGIN combined) plus `source.workspaceSetup` while retaining
`source.acquireAndSetup`. The real wrapper ordering test passed10/10; the
plan-source attribution suite passed3/3. DB-org and operator-core package
typechecks and `git diff --check` passed. This instrumentation is source proof
only: it had not been committed, activated on :3170, or remeasured natively
at this write. P-007 remains open.

### P-007 packaged runner recovery and named receipt — 2026-09-26

The repeated mount failure was a fixture navigation race. In invalid run
`run-002.log`, WebDriver was still at `about:blank` when the popup spec read
`location.href`; changing its pathname and query yielded
`about:blank?ws=papercusp-workspace&opcv=plans`, which the spec navigated to.
The earlier valid run had produced
`papercusp://localhost/adv?ws=papercusp-workspace&opcv=plans` at the same site.
The spec now waits for a host-bearing packaged document URL before applying
the workspace query, and URL discovery plus app mount share the original mount
timeout. The runner's real Node suite passed10/10, including an `about:blank`
counterexample, and its typecheck passed. This fixes the test's invalid
navigation path; the WebKit page-crash message itself remains a downstream
symptom, not a proven WebKit defect.

The same existing publisher payload builder now sets `gitSha:null` for a
named `PAPERCUSP_PERF_RUN_ID`, because the checkout HEAD is not the frozen
shell/SPA/live API build. Unnamed runs retain checkout correlation. The
runner README describes the profile convention; its10-test suite and typecheck
passed. No new ingest field or table was added.

A new real packaged run used shell `e41628e0`, SPA index `e054e7cb`, and
staging API `e97031f294`; the private IPC files were refreshed to live PID
1570985. The log at
`$HOME/.papercusp/perf/p007-native-current/run-003.log`
shows navigation to `papercusp://localhost/adv?ws=papercusp-workspace&opcv=plans`
and a rendered pinned plan. Its **1825ms** popup still exceeded1500ms.
Request-start was329ms, response-headers1592ms, response-ready1604ms, and
preview-rendered1818ms. Receipt `perfrun-1790384860776-t03lf7` persisted16
real measures with `workspace_id=papercusp-workspace`, `git_sha=NULL`, and
`run_id=p007-e41628-e054e7-e97031-20260926-r03`. Matching `plans:get`
invocation29628521 took1218ms (source acquisition/setup273ms, query11ms,
rubric/audit356ms) on API build e97031f294.

This run verifies both harness fixes at runtime but falsifies P-007 latency
acceptance on this profile. The new source acquisition split was still dirty
and absent from the e97031f294 API at this write; the next valid run must
verify its deployed stage fields before attributing the variable wait.

### P-007 packaged Web Vitals smoke on the same frozen shell and SPA — 2026-09-26

The packaged `smoke.spec.ts` instrument reported `ready` with **FCP 2972ms**
and **LCP 4441ms** on shell SHA256 `e41628e0`, SPA index SHA256 `e054e7cb`,
and staging API `e97031f294`. FCP met its 3000ms budget; LCP exceeded its
4000ms budget. INP, CLS and TTFB retained their documented environmental
classifications. The native smoke spec passed its instrument assertions, and
publisher receipt `perfrun-1790385620425-7ttznj` stored ten measures under
`papercusp-workspace` with one over budget and status `fail`. The raw log is
`$HOME/.papercusp/perf/p007-native-current/run-004-smoke.log`.
This is one cold packaged sample on that build profile, not a distributional
latency or P-007 acceptance result. No cause is assigned to the LCP value.

### P-007 activated timing split and variable native popup — 2026-09-26

Git-sync commit `da16252fd3` contains the source acquisition split, the
`libs/papercusp` DB wrapper pin, and the packaged runner mount guard. The
isolated staging sync completed at 01:28:39Z; `/api/health` reported
`da16252fd3`, and both private IPC descriptors were refreshed to the live
PID 3923358 and its socket. Shell `e41628e0` and SPA index `e054e7cb`
remained frozen.

Named packaged run `p007-e41628-e054e7-da1625-20260926-r05` measured
**2919ms**, failing the 1500ms popup budget. Request-started was 662ms,
response-headers 2545ms, response-ready 2584ms, and preview-rendered
2911ms. The publisher stored 17 measures as
`perfrun-1790386201980-pii25e` with status `fail`. In the same short window,
the single recorded full `plans:get` for the pinned slug was invocation
29630889 on build `da16252fd3`; its 1316ms dispatch duration included a
1199.6ms cold read with `source.waitForBegin` 39.8ms,
`source.workspaceSetup` 571.5ms, `source.query` 66.1ms, and
`stalePaths` 385.5ms. These are overlapping wall intervals, not DB CPU.
The browser click's absolute timestamp was not logged, so temporal pairing
is a scoped correlation, not proof that the full browser request interval
equals this dispatch span.

Named run `p007-e41628-e054e7-da1625-20260926-r06` measured **918ms**
and published 17 passing measures as `perfrun-1790386294000-uc3l70`.
Its recorded `plans:get` invocation29631091 took 22ms, while
`plansGetRead.buildState=running` and `waitMs=0.216ms` show the cached read
returned as a background refresh ran. This warm result does not clear the
failed cold result. Raw logs are `run-005-popup.log` and `run-006-popup.log`
under `$HOME/.papercusp/perf/p007-native-current/`.

Correction to the initial analysis: `tool_invocations.invoked_at` is stamped
at dispatch settlement in `projected-tool-deps.ts`, not request start. A
browser-to-server residual derived by treating it as a start timestamp was
wrong and is retracted; this evidence assigns no number to that residual.
The server stage values and browser phase values above remain observed.

The shared workspace transaction wrapper currently awaits separate
transaction-local `search_path` and `app.workspace_id` setup statements on
pooled app connections. The canonical source now combines those independent
settings in one SQL round trip, with unit proof (11/11), real-Postgres
integration proof (8/8), DB package typecheck, and diff check passing. This
source change is still uncommitted/unactivated at this write. The measured
571.5ms was the prior **combined setup interval**; no per-statement cost or
native improvement is claimed yet.

### P-007 same-build repeats and hot-path attribution — 2026-09-26

Staging API build `bcf4dbf223` contains the combined transaction-local
workspace setup and the `stalePaths.resolveRoot` / `stalePaths.scan`
diagnostics. The frozen shell and SPA remain `e41628e0` / `e054e7cb`.
Packaged popup run r14 measured **1405ms** (receipt
`perfrun-1790388457077-4u4vzh`, pass). Its same-window full
`plans:get` invocation29635511 took624ms: cold read600.9ms,
`source.workspaceSetup`176.9ms, `stalePaths.resolveRoot`51.1ms and
`stalePaths.scan`0.14ms. This one sample cannot isolate the saved time
from the combined SQL statement because its predecessor ran under different
conditions. The r14 start-wall log was missing: the test had read the
`:start` mark AFTER `endInteraction` consumes that mark. The runner now
derives absolute start from the completed measure's `startTime` and fails
an unmeasurable sample if that value is absent.

Run r17 verified the corrected timestamp path in the real packaged suite:
absolute start `2026-09-26T02:13:15.028Z`, popup **1003ms**, receipt
`perfrun-1790388799207-u3pyzp` pass. Its request-start phase was372ms,
response headers715ms, preview997ms. Full `plans:get` invocation29636225
settled at02:13:15.730Z after104ms; the unique pinned slug, build and
timestamp establish this run's correlation. Its `buildState=running` and
`waitMs=0.278ms` mean the cached response returned while refresh ran, so
r17 is warm evidence.

With the existing page event-loop probe enabled, r18 measured **1713ms**
and failed the1500ms budget (receipt `perfrun-1790388911717-6qgo1i`).
Absolute start was02:15:07.681Z; request-start615ms, headers1499ms,
response-ready1510ms and preview1707ms. The matching
`plans:get` invocation29636459 took746ms, with a cold read729.3ms:
`source.workspaceSetup`40.4ms, `source.finishTransaction`354.5ms,
`stalePaths.resolveRoot`255.7ms and `stalePaths.scan`0.10ms. The
page probe observed event-loop gaps of255ms and370ms in this interval;
its DOM layout hook reported no >=10ms layout operation. The root lookup
was issuing `git rev-parse --show-toplevel` even when the caller supplied
the known worktree root. Current source now checks that root's `.git`
entry first and reserves Git for nested/unknown paths. A real throwaway
repo test removes Git from PATH and still resolves cited paths at the
explicit root; the focused suite passed30/30 and diff check passed.
This new source fix is uncommitted/unactivated at this write; no native
latency improvement is claimed.

Web Vitals remain variable on the same frozen shell/SPA: smoke r08 recorded
FCP10092/LCP11233 (fail), r09 2347/3428 (pass), r10 4291/5582 (fail),
r11 2697/3722 (pass), r12 2213/3311 (pass), and r15 2392/3363
(pass). All named receipts are in the corresponding `run-NNN-smoke.log`
files under the private fixture directory. The r10/r11 page traces showed
cumulative foreground scheduler wait of14855ms versus2323ms across69
requests, but that SUM is not a first-paint critical path. CPU PSI was
not higher in the slow sample (start 0.62% vs0.96%, end0% vs2.92%).
A corrected bounded query-ring probe now separates requests completed
before FCP from requests merely started before it. In r15, zero recorded
queries completed before FCP and eight started before FCP but completed
later; its FCP2392ms passed. An r12 snapshot showed 16 queued foreground
requests and several later 20s queue timeouts despite FCP2213ms passing.
This separate unconfirmed post-paint queue defect is tracked as
WI-10003191. These observations do not establish a cause for the FCP/LCP
variance or a ten-run P-007 acceptance result.

Smoke r19 used the same frozen shell and SPA with API build `ac0cb93e81`.
The packaged instrument reported FCP **2383ms** and LCP **3456ms**, both
within budget, and published ten measures as
`perfrun-1790390021053-v1gwnn` (pass). Its bounded query-ring probe found
zero queries completed before FCP; eight started before FCP and completed
later. This one passing sample does not identify the cause of the earlier
slow paints. Raw log:
`$HOME/.papercusp/perf/p007-native-current/run-019-smoke.log`.

### P-007 active enrichment timing and body-first follow-up — 2026-09-26

The known-root stale-path fix reached staging API `aa7c7a1e93`: native r21
still failed at **1870ms**, while its matching cold `plans:get` took697ms.
`stalePaths.resolveRoot` had fallen to0.03ms; the remaining long stages were
overlapping enrichment reads. On API `835b4d17a8`, smoke r24 measured
FCP2945/LCP4325 (LCP fail), while r25 measured FCP2406/LCP3502 (pass).
The r25 LCP entry was a text `DIV` with `loadMs=0`; no image-load cause is
inferred. Both profiles used the same frozen shell and SPA described above.

After the per-enrichment timing split committed, staging API `104948524e`
served two guarded native cold popups. r26 measured **2225ms** (receipt
`perfrun-1790394892683-vp338e`); r27 measured **1502ms** (receipt
`perfrun-1790395123191-yo6d58`). Both exceed the1500ms budget. Their
private IPC descriptors matched live PID3974231 at start and end, and their
foreground/interactive scheduler snapshots had queue0 and timeout0. Logs:
`$HOME/.papercusp/perf/p007-native-current/run-026-popup-enrichments.log`
and `run-027-popup-warm.log` beside it.

The matching `plans:get` invocations `29648251` and `29648585` measured
wait872ms and474ms. Source read was76ms and74ms. The first invocation's
overlapping optional reads included test coverage794ms, linked features794ms,
rubric/audit642ms and issue blocks354ms; the second's longest optional reads
were about399ms. Transaction-local workspace setup accounted for561ms and
376ms within the feature/test reads. The server also logged event-loop lag
in each native interval, so these measurements identify the **body's wait on
optional enrichments**, not the underlying cause of each stall.

Current source therefore returns the full plan body with
`includeEnrichments:false` on the popup's first REST read. A separate one-shot
read hydrates live badges, test coverage and issue status after the document
paints; edit/status actions stay disabled until it finishes. The lightweight
and full cache keys are separate. Five focused project test files passed
**75/75**, scoped formatting and diff checks passed, and operator-core
typecheck was baseline-clean. Operator UI typecheck reports no new error in
these paths; it remains red on three TS7006 diagnostics in the unrelated
`verify-identities-r4.test.ts`. This body-first change is **source-verified
only** at this write: its nine paths await git-sync and active staging native
remeasurement. Ten valid same-build popup runs, paint variance, independent
acceptance and shipment remain open. The separate restart-overlap/fixture
issue `WI-10003191` was completed with stable native runs and a changing
live-socket counterexample; no steady-state scheduler queue defect was
reproduced.

### P-007 body-first activated; host main-thread saturation — 2026-09-26 15:25Z

The body-first source (`get.ts` 450e7f2165, `plans-api.ts` /
`_plans-args.ts` 8d58bce7aa) is in staging API `65060e4abc`: blobs for all
three paths equal `staging`. The frozen fixture SPA `e054e7cb` did **not**
contain the client half (0 asset files match `includeEnrichments`, positive
control `response-headers` 1), so a run on it could never exercise the fix.
The fixture SPA was replaced by the canonical `apps/operator-vite/dist` built
15:18:54Z (index SHA256 `61b3e23247c8…`, 1 asset file with the new call);
the previous SPA is kept beside it as `sidecar/spa.e054e7cb`. Both private
IPC descriptors were refreshed to live PID 2214020 (started 15:08:48Z).

Named run `p007-e41628-61b3e2-65060e-20260926-r28` measured **2296ms**
(FAIL, receipt `perfrun-1790436350495-en13hp`, log
`$HOME/.papercusp/perf/p007-native-current/run-028-popup-bodyfirst.log`):
request-started 305, response-headers 2048, preview-rendered 2289. Its first
`plans:get` (invocation 29694809) carried `includeEnrichments:false` and
recorded **no** enrichment stages; dispatch took 544ms (`waitMs` 360,
`source.waitForBegin` 281). The later hydration read (29694820, 687ms)
carried the enrichments. So the fix works as designed, and the remaining
wait is outside the handler: dispatch began ≈1445ms after the click
(settle time minus duration; `invoked_at` is stamped at settlement), about
1140ms after the browser's request-started mark.

The staging host was CPU-bound on its main thread in that window: its lag
monitor logged p95 297ms / p99 518ms / max 944ms for the 10s ending
15:25:44.885Z, beside `plans.attentionCounts` 4222ms and `plans.list`
3519ms sync reads. Between 15:10 and 15:27Z the single :3170 process served
1,524 MCP-transport tool calls from ~18 agent sessions, versus ~800 across
:3070's six cluster workers. psu sessions launched from the staging desktop
inherit `PAPERCUSP_OPERATOR_URL`/`PAPERCUSP_API_BASE` = `:3170`
(`console-launcher.ts` / `spawn-config.ts` derive it from the launching
request), so their hook traffic lands on the process serving the UI;
`:3170` runs without `PAPERCUSP_CLUSTER_WORKERS`. The popup budget is
therefore currently measured against fleet load, not only plan-read code.

Loop-saturation profiles of that process
(`~/.papercusp/loop-profiles/loop-saturation-1790435495838-pid2214020-p95_160ms.cpuprofile`
and `…1790436378631-…p95_42ms`) attribute self time to `spawn` (14.2% /
11.9%), `fnv1a64` (10.1% / 6.1%) plus its registry/delta callers, and plan
parsing (`maskFences`, `parseItemLine`, `splitSections`, a `[a-z]\n[a-z]`
regex). `fnv1a64` did a BigInt XOR and multiply per code unit; WI-10003260
replaces both tooldef FNV loops with a bit-exact 16-bit-limb version
(102 tests pass, including a BigInt reference kept as control; same output,
11.5× faster on a 224,671-char body). Its effect on the staging main thread is
not yet measured. P-007 acceptance remains open.

### P-007 ten-run set after the fnv1a64 + agent-config fixes — 2026-09-26 16:32Z

Staging API `7d787f2c51` carries both fixes: agent-config route blob
`f09e3dfa13` (WI-10003266) and tooldef gitlink `43bb505` (WI-10003260).
staging-sync advanced to it from the local committed `staging`. All runs below
used one process (PID 2509156, started 16:14:39Z), frozen shell `e41628`,
fixture SPA `61b3e2`, and plan `goal-agent-behavior-feedback-2026-09-06`.
Runner: `~/.papercusp/perf/p007-native-current/run-native-popup-batch.sh`
(pins the PID and stops on a restart).

| run | popup ms | request-started | response-headers | preview-rendered | receipt |
| --- | ---: | ---: | ---: | ---: | --- |
| r31 | 856 | 321 | 520 | 847 | perfrun-1790439427667-tj3rz8 |
| r32 | 1212 | | | | perfrun-1790439529371-6bsk1i |
| r33 | **>8000** | 301 | 422 | (response-ready 28298) | none |
| r34 | 1378 | | | | perfrun-1790439610521-lvyl46 |
| r35 | 1179 | | | | perfrun-1790439632679-zco33k |
| r36 | **>8000** | 369 | none in 8s | — | none |
| r37 | 1083 | | | | perfrun-1790439701674-m7e207 |
| r38 | 1440 | | | | perfrun-1790439743838-0cqdc1 |
| r39 | 788 | | | | perfrun-1790439783997-fc3liu |
| r40 | **>8000** | 1947 | 8071 | — | none |

**Verdict: 7/10 within 1500ms, 3/10 over 8000ms. Ten-run acceptance FAILS on
tail latency.** The median improved sharply (r28 was 2296ms before the fixes).

**Instrument defect.** The harness reported r33/r36/r40 as `UNMEASURABLE: no
dashboard plan opened`. Each of those clicks did happen: the popup stayed on
`Loading goal-agent-behavior-feedback…` past the 8s `MEASURE_WAIT_MS`.
`plan-popup-open.perf.spec.ts` maps a post-click measure timeout (`.catch(() =>
"timeout")`) to "row not opened", so slow popups are dropped from the verdict
and no receipt is published. Left uncorrected, this biases every ten-run set
toward a pass.

**Tail cause (partial).** The three slow runs coincide with :3170 main-thread
stalls from its lag monitor: maxMs 5104 (16:20:49Z), 3737 (16:21:00Z),
**20669** (16:21:27Z), and 3565 (16:23:32Z). The saturation profile from that
window (`loop-saturation-1790439654103-pid2509156-p95_666ms`, 97.8% busy)
attributes about 13% of self time to the task-manager live scan's synchronous
`/proc/<pid>/exe` + `/proc/<pid>/environ` reads (`runLiveScan` →
`projectLiveProcess` → `readProcessMetadata`), filed as EI-24342043796392664.
GC takes 16% and tool-catalog projection about 7%. Profiles show the old BigInt
`fnv1a64` gone (the fast version is 2.3%) and `spawn` down from 12–14% to 1–4%.

## P-008 secondary-lead evidence — 2026-10-01

**P-008 remains open.** These receipts advance F11/F12 attribution; they do
not establish universal R-8 acceptance or final shipment. WI-10002830 owns
the remaining local investigation. Portal remains the separately owned
EI-24354725412855158, assigned to fleet leader su-0da9d55e; its failed
systemd-notify barrier is a measured precursor, with root cause unconfirmed.

| Lead | Evidence and disposition | Remaining limit |
|---|---|---|
| Gateway local admission 429 | An unmarked local 429 was classified as `upstream-429` despite zero upstream attempts. The existing `shed` bit now marks all-throttled, metered-never and admission-timeout exits. Actual HTTP regression cases distinguish local shedding from a real upstream 429. The saved 01:29Z canonical matrix passed 268 tests across three files, exit 0, with no skips. | Saved source snapshot at `244f7d127c` plus local tests; no live gateway adoption or current universal acceptance claim. Exact fingerprints and command remain on WI-10002830. |
| Proxy paired reset messages | `recordInboundClientError` calls `recordInboundSocketReset` and then logs the client error. One socket error therefore produces both categories; a WeakSet deduplicates the reset counter per socket. At source `2dc4a60da4`, the canonical `proxy.test.ts` case `records clientError/socket-reset` passed, exit 0: one client error and one reset, not two independent user failures. | One selected test passed; 322 other cases were excluded and provide no evidence in this run. Existing journal categories cannot identify every failed user action or distinguish every cancellation from an upstream fault. |
| Migration-readiness/ref-announcement failures | WI-10002822 records the one-shot boot gate as the origin: failure returned before substrate boot, while the once-per-process migration helper could not retry. Its maintained retry path uses `applyPendingMigrationsNow`, preserves the backup boundary, and alarms after prolonged withholding. Stored comment WI-10002822#comment:1143176 reports recovery within three seconds of migration application on September 24. | This reuses a dated, authoritative recovery receipt; no P2P operation or fresh induced outage was performed. Upstream migration-reservation failures and current loaded-build adoption are separate questions. |
| Ingestion scan/cost | `session-ingest.ts` increments `filesScanned` before the unchanged-byte-offset skip. It counts candidate visits, not files decoded or fully re-read. A fresh chronological sample below confirms useful incremental ingestion alongside long wall times. | The cost remains unresolved. Candidate-count semantics do not explain the long passes, and successful ingestion does not establish acceptable cost. |
| Historical account polling | A bounded September 23 ledger read identifies the high-volume caller as `pui-2057122`, `spawn_id=palette`, on staging builds, with the last retained high-volume group ending at 19:19:10Z. The separate saved current-hour read contains 60 calls from `loopback/pui-2221762`, also `palette`, on release build `29bf735091`. | This identifies the consumer class, not the exact polling component or a causal contribution to app latency. The historical and current windows differ; they are not a before/after performance comparison. |
| Broad forensic DO scan | The prior same-database/current-backend positive-control query found no matching active DO scan. The supported `dev:pg_query` surface bounds acquisition and statement execution and accepts a positive control for absence claims. | Absence of that active query does not measure all diagnostic demand or prove the historical scan caused app slowdown. |
| In-process embedding warning | `ensureEmbedSidecar` emits this warning once per process when no sidecar is configured; the source explicitly supports that configuration. The warning alone is not evidence of resource pressure. | Historical hosted-process configuration and request impact remain unverified. P-006/WI-10002828 retains its own strict memory evidence and contract blocker. |
| Loop lag / routine shedding | The audit counts remain retained warning-line categories, not independent incidents or a quantified app slowdown. | Current causal disposition still belongs in this investigation; no blanket non-defect claim. |

### Chronological ingestion observation

At 01:49:39Z, a bounded journal read of the actual
`papercusp-bg-host.service` covered 00:49:39Z onward, with a 200-record cap.
It returned 26 matching records and parsed 26 ingestion passes. The service
reported active, PID 697212, start time 01:20:09Z, and canonical working
directory `papercusp/apps/operator`. The pass records were sorted by timestamp
before selecting the latest observations. This supersedes the earlier
reverse-time sample selection in `/tmp/p008-ingest-evidence.json`.

| Pass completed (UTC) | New turns | Decoded files | Candidate visits | Wall ms | Reported errors |
|---|---:|---:|---:|---:|---:|
| 01:32:44 | 64 | 77 | 4742 | 11770 | 0 |
| 01:34:43 | 76 | 86 | 4753 | 4544 | 0 |
| 01:36:53 | 75 | 85 | 4760 | 13461 | 0 |
| 01:39:44 | 57 | 70 | 4766 | 69520 | 0 |
| 01:42:13 | 47 | 78 | 4768 | 76653 | 0 |
| 01:42:47 | 31 | 74 | 4773 | 8508 | 0 |
| 01:45:59 | 103 | 81 | 4777 | 84986 | 0 |
| 01:46:54 | 37 | 79 | 4781 | 14335 | 0 |

The 26 observed passes range from 2993 to 131882ms. These are retrospective
wall times on changing workloads. Loaded-source identity and a representative
workload were not frozen, so this is neither a p95 acceptance measurement nor
evidence for a CPU, memory or candidate-walk cause. Next, attribute discovery,
metadata reads, offset checks, decoding and database insertion in the existing
ingestion path before choosing a fix.

Evidence: `/tmp/p008-ingest-sorted-20261001.json`, completed task
`0muovmcndw26eg4wh5j`; `/tmp/p008-proxy-pair-20261001.log`, canonical test
receipt at 01:51:51Z; gateway receipts and fingerprints on WI-10002830.
`tool_invocations.output_size` is conservatively reported as serialized result
units: its dispatch fallback is `JSON.stringify(r.content).length`, not a
measured UTF-8 byte count. No resource-pressure cause is inferred from it.

### Ingestion phase attribution instrumentation — 02:19Z

The existing `runSessionIngestOnce` stats now carry exclusive monotonic wall-time
buckets for setup, historical backfills, discovery/stat, state loading, candidate
metadata, decoding, per-file writes, metadata repair, chats, and other bookkeeping.
These include awaited and scheduling time; they are not CPU or connection-acquisition
measurements. Failed async operations retain their elapsed time. The existing
periodic-workflow log includes the bounded phase object and reports completed
no-progress sweeps lasting at least five seconds, closing the prior detector gap
where slow unchanged-file work could be invisible. Skipped sweeps remain suppressed.

The canonical five-file run at local source HEAD `37bc2d4c32` plus these edits passed
57 tests, with no skips, exit 0. It covers phase partitioning with deterministic
filesystem/query costs, unchanged-byte skips with metadata repair, failed-write
timing without offset advancement, sweep-latch release, slow-empty logging,
faithful-parts-only logging, and the existing parser/metadata/walker/yield guards.
This is source correctness evidence, not a production latency result.

Command: `PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/search/session-ingest-phases.test.ts packages/operator-core/lib/search/session-ingest.test.ts packages/operator-core/lib/search/session-ingest-adv-metadata.test.ts packages/operator-core/lib/search/session-ingest-walker.test.ts packages/operator-core/lib/search/session-ingest-yield.test.ts`.
Receipt: `/tmp/p008-ingest-phase-matrix-20261001.log`, started 02:18:35.867Z.
Source SHA-256: `session-ingest.ts` =
`a63bb35bca2738b33f62084917b9c3fa3b522ca21d37946000ae8786449529a3`;
test = `37a5bedc387b77b6b201a076f8ffcb5e348eee7725ddbd0a3f9073af6694839d`;
`periodic-workflows.ts` = `832d8450193ba0b3c48576319091996f536747da8c5392dc5010b005abe69854`.
Scoped diff-check passed. The separate `npm run lint:tsc` failed on seven regressed
files outside these edited paths; its receipt is
`/tmp/p008-ingest-phase-typecheck-20261001.log`. No whole-tree typecheck pass is claimed.

The current-build route read names an isolated bg-host assertion via
`node scripts/with-test-pg.mjs --isolated-runtime -- <current-build background assertion>`:
disposable migrated DB, HOME/keychain/workspace/ports, stripped runtime credentials,
private-state-write and teardown proof. It still requires a concrete background
assertion. The same read reports bg-host build `244f7d127c` from runtime-vintage,
with `containsChange:false`; the observed PID remains 697212. The new phase data has
not been measured on a loaded runtime. No shared-host restart or live adoption is claimed.

A bounded 01:45:08–02:10:08Z preflight retained 67 matching journal records (cap 160)
from that service. Its 02:09:18Z pass ingested 57 turns and 655 parts from 84 decoded
files after 4846 candidate visits, taking 28810ms with zero reported errors.
The existing profile `loop-saturation-1790820554533-pid697212-p95_52ms.cpuprofile`
overlaps that pass: 301 samples cover 2984.296ms, with 30.316ms of sample weight
having a `runSessionIngestOnce` ancestor in the loaded `dist-host/hono-host.mjs`.
Async continuations and unsampled periods are not attributed by that ancestry test;
this is neither an upper bound on ingestion CPU nor an explanation of the full
pass duration. The retained window also contains acquire-plus-SELECT1 shed messages
and delayed-recorder-rotation messages. Those labels do not establish database,
memory, CPU, or ingestion causality.

Evidence: `/tmp/p008-ingest-phase-preflight-20261001.json` (task
`0muowcorpcbsv2fcmr0`, completed exit 0),
`/tmp/p008-ingest-profile-attribution-20261001.json`, and the profile path above.
**P-008 remains open and unaccepted.** Next: exercise the maintained isolated
background route with a pinned workload and explicit cleanup, then compare its
phase costs before choosing a performance fix.

### Isolated ingestion execution and phase receipt — 02:46Z

The new project integration fixture
`packages/operator-core/lib/search/session-ingest-runtime.integration.test.ts`
uses the maintained `with-test-pg.mjs --isolated-runtime` route. A fresh Node/tsx
child executes the real `runSessionIngestOnce`, adapters, filesystem, clock,
flags and database. Its preflight verifies private HOME/workspace, the wrapper's
loopback PG port, stripped agent credentials/IPC, background environment and
disabled global routines. Source SHA-256 is checked before and after execution.
The fixture invokes background ingestion directly; shared bg-host adoption and
the complete DBOS host lifecycle remain unmeasured by this fixture.

Workload `synthetic-offset-tail-v1` fixes 320 managed Codex homes with 15 rollouts
each: 4,800 candidate files and 80 changed tails per useful pass. Each useful pass
adds exactly 64 text turns and 640 faithful parts. A nonempty metadata prefix and
its saved offset model unchanged files; offsets on the 80 private files are reset
between three repetitions while their turn/part indices keep increasing. The
final unchanged pass must perform zero decoding/writes and insert no duplicates.
This deliberately small synthetic content matches the observed candidate/tail
scale; live transcript contents, backlog, concurrent requests and pool contention
are outside its measured scope. These repetitions are descriptive phase receipts,
not paired control/candidate windows or a production p95 acceptance result.

| Fixed pass | Total wall ms | Discovery ms | State ms | Metadata ms | Decode ms | Writes ms |
|---|---:|---:|---:|---:|---:|---:|
| Initial unchanged | 720 | 396.0 | 17.4 | 275.1 | 0 | 0 |
| New tail 1 | 2105 | 418.9 | 16.4 | 287.8 | 976.2 | 379.8 |
| New tail 2 | 2265 | 418.3 | 17.3 | 293.7 | 1071.0 | 435.6 |
| New tail 3 | 2042 | 372.9 | 12.3 | 265.4 | 961.0 | 408.4 |
| Final unchanged | 585 | 322.9 | 15.3 | 222.8 | 0 | 0 |

The other exclusive phase buckets remain in the full log receipt; the test checks
their sum against total wall time, finite nonnegative durations, no errors or
historical backfill, exact useful outputs, and byte offsets equal to file sizes.
It read back 192 private turns and 1,920 private parts. After the child exited,
the test confirmed removal of its HOME and PG data directory and an
`ECONNREFUSED` probe on the private database port. In this fixture, decode is the
largest useful-pass bucket; discovery and metadata dominate the unchanged pass.
Await/scheduling time is included, so these buckets do not establish CPU cost or
the mechanism behind the previously observed live 69–85-second passes.

Canonical command: `PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/search/session-ingest-runtime.integration.test.ts`.
One integration test passed, zero skipped, native command exit 0, at 02:46Z.
Receipt: `/tmp/p008-ingest-runtime-20261001-r4.log`; loaded child HEAD
`eef7edb49fe872a03813f14c40145604b88ed8d8` plus the local untracked test.
Source SHA-256: `a63bb35bca2738b33f62084917b9c3fa3b522ca21d37946000ae8786449529a3`;
test: `34ae4ca795bce991ef39a8b2570173303d200b4745b43b199674654fad4dea14`;
workload descriptor: `417b4388c355a7f415df05df56d3904a314be517ced4ec6bf61fe0c222249421`.
The source fingerprint matches the prior five-file 57-test regression receipt;
those proofs were reused without a reconstruction rerun.

The first three attempt logs remain separate. They failed respectively on nested
SQL template syntax, an overly specific loopback hostname assertion, and empty
seed files excluded by the real candidate filter. Before the successful attempt,
the harness gained a child syntax preflight, bound SQL parameters, accepted
loopback spellings with exact wrapper-port checks, nonempty prefix/offset seeds,
production-walker layout preflight, and cleanup assertions on failing children.
Their failed outcomes are not performance samples and were not replaced in an
acceptance matrix. No whole-tree typecheck, shared-runtime adoption, shipment,
live latency improvement, or R-8 acceptance is claimed. **P-008 remains open.**

### Frozen mixed-record tail measurement — 03:07Z

The maintained integration fixture now also accepts a local frozen Codex tail.
It checks the tail SHA-256 before and after execution, complete JSONL records,
the per-file byte bound and useful-turn budget. The guarded adapter preflight
determines expected outputs before private writes; the fixture still verifies
real database counts, file offsets, the final unchanged pass and teardown. Raw
transcript content stays outside the repository and is absent from receipts.
The default synthetic mode remains self-contained for CI.

This run selected the last 100 complete records from this worker's ended native
session `01a0f54a-98ea-7d61-8565-eff52bada864`, under managed home `session-32189`.
The immutable source rollout SHA-256 is
`daf3b19c556879679f73cc71e49822eda166ac5756cfffb19586787ffd16f4a7`;
the selected tail SHA-256 is
`aca19605813043b6c1ba7d82bd89344f50c90aee1bddf47bcd51aec0064eb37e`.
Each of 80 changed files receives the same 214,497-byte, 100-record tail among
4,800 candidates. Its mix includes messages, reasoning, tool calls/results,
completion events and token records. This produces 240 recall turns and 2,160
faithful parts per pass; three repetitions read back 720 turns and 6,480 parts.
Replaying one tail 80 times is a frozen local sample, not a census of live
transcripts, concurrent work, database state or the full background-host lifecycle.

| Frozen pass | Wall ms | Discovery ms | Metadata ms | Decode ms | Writes ms | Child process CPU ms |
|---|---:|---:|---:|---:|---:|---:|
| New tail 1 | 4699 | 1201.1 | 568.4 | 970.8 | 1834.8 | 2268.8 |
| New tail 2 | 4048 | 1075.7 | 433.5 | 1156.6 | 1280.3 | 1854.6 |
| New tail 3 | 3060 | 1051.2 | 381.9 | 708.6 | 864.0 | 1689.1 |
| Final unchanged | 913 | 603.9 | 272.9 | 0 | 0 | unmeasured |

CPU is `process.cpuUsage` user plus system microseconds divided by 1,000,
bracketing each entire ingestion pass in the child. It includes all threads in
that process, excludes the separate PostgreSQL process, and is not per-phase
CPU or a connection-acquisition measurement. Phase buckets remain exclusive
wall times including awaits and scheduling. These runs do not reproduce the
saved 69–85-second live sweeps and do not identify their cause. They are not a
paired performance comparison with the earlier synthetic runs.

The frozen mode passed one canonical integration test, zero skips, native exit 0;
receipt `/tmp/p008-ingest-frozen-runtime-20261001-r1.log`, test start 03:06:06Z.
The default synthetic regression also passed one integration test, zero skips,
native exit 0; `/tmp/p008-ingest-runtime-default-20261001-r5.log`, start 03:07:45Z.
Both confirm private HOME/data-directory removal and a refused database port.
Loaded child HEAD remains `eef7edb49fe872a03813f14c40145604b88ed8d8` plus the local
untracked fixture. Ingestion source SHA-256 remains `a63bb35bca2738b33f62084917b9c3fa3b522ca21d37946000ae8786449529a3`;
updated test SHA-256 is `94b732691b66c53566dde190c0c3b0eef91d5adb35f81468eb20a0d4c0e2b167`.
Frozen workload descriptor SHA-256 is
`58a9a2c9d81e0021819064c5fcedbe45140c21e27b285dbbae7a7d143b57b835`;
the default descriptor remains `417b4388c355a7f415df05df56d3904a314be517ced4ec6bf61fe0c222249421`.

Reproduce the frozen input by extracting the last 100 complete lines from the
named ended rollout and checking both hashes, then run the canonical test with
`TEST_INGEST_CORPUS_PATH` naming that local snapshot. Default command remains
`PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/search/session-ingest-runtime.integration.test.ts`.
The temporary raw snapshot was removed after receipt capture.

Performance-plan decision D-006 explicitly reserves shared federation-host
adoption for a separately coordinated runtime lane. This worker performed only
a `dev:restart` dry-run and did not restart the shared host. The current runtime
report still names bg-host `244f7d127c`, `containsChange:false`; live adoption,
causal attribution, latency acceptance and final shipment remain open.

### PUI account-request attribution — 03:33Z

The account-call label `palette` is shared dispatch plumbing, not a component
name. `apps/tui/src/client.rs:1453` implements `accounts_status()` by invoking
`accounts:status`; `run_tool_body` stamps `callerSid=pui-<process id>` at line
3553. `packages/operator-core/lib/capabilities/invoke.ts:216` retains
`spawnId=palette` while carrying that id in `uiClientId`. The principal identity
writer namespaces it as `loopback/pui-<pid>` in the current ledger. These are
caller-supplied attribution fields, not authenticated PUI binary provenance.

The current PUI has two direct consumers in `apps/tui/src/main.rs`: session
setup at line 2932 and the general workbench `refetch_all` at line 7770. The
latter runs after the initial load, a 60-second safety tick, and debounced SSE
invalidations. `invalidation_loop` forwards every `invalidate`/`update` frame;
the current signal gates plan reads, while account reads remain unconditional
in a full hydration pass. This is a source mechanism that can amplify account
reads on unrelated updates. No replay in this investigation has yet measured
its effect or linked a specific historical request to its triggering frame.
The same account-method/caller-id/safety-tick paths exist in Git source
`29bf735091` and historical server source `e5b3a2cb54`; server SHA does not
establish which PUI binary was loaded.

The exact retained sample is workspace `papercusp-workspace`, tool
`accounts:status`, caller `loopback/pui-2221762`, spawn `palette`, host
`port-3070`, build `29bf735091`, settlement interval
`[2026-10-01T00:19:00Z,2026-10-01T01:19:00Z)`. A bounded read with a positive
control returned:

| Quantity | Observation |
|---|---:|
| Calls | 60 |
| Summed dispatch wall time | 3127 ms |
| Dispatch p50 / p95 / maximum | 34 / 153.9 / 505 ms |
| Serialized result units | 2435534 |
| Adjacent settlement spacing, minimum / maximum | 31.272 / 98.551 seconds |

First settlement: `00:19:30.220Z`; last: `01:18:31.453Z`. An exhaustive
status/metadata partition returned one cell: `status=ok`, dispatch-stage
metadata absent, 60 calls with 60 duration and 60 size values. Thus this sample
has no dispatcher-error rows and cannot attribute wall time to individual
dispatch phases. `duration_ms` comes from `Date.now()-startedAt` in
`libs/generic/tooldef/src/dispatch-stack.ts:1732`; it includes waits and
scheduling but excludes the telemetry sink. `invoked_at` is stamped at
settlement in `projected-tool-deps.ts`. `output_size` falls back to
`JSON.stringify(r.content).length`, so these are serialized units, not measured
UTF-8 network bytes. Neither the sum nor the percentile establishes CPU cost,
overlap with ingestion, or a causal effect on app latency.

A separate bounded September 23 day read for `pui-2057122` and
`loopback/pui-2057122` retained the ten largest build/host groups. One group
contains 1488 calls on `port-3170`, build `e5b3a2cb54`, from
`03:00:54.263Z` to `04:15:04.197Z`: 110276 ms summed dispatch wall and
44395557 serialized units. This is positive evidence of historical frequent
PUI-shaped calls; ten selected groups are not a complete daily census. It is
not comparable to the October 1 sample as an improvement measurement.

Read-only reproduction uses `dev:pg_query` over `harness_shared.tool_invocations`
with the exact scalar predicates above. Compute adjacent spacing with
`lag(invoked_at) OVER (ORDER BY invoked_at,id)` inside that sample; group by
`status` and a three-way metadata case (`NULL`, `dispatchStages` present,
absent) to retain unknown values. The positive control was id `30385108`.
The historical query uses `[2026-09-23T00:00:00Z,2026-09-24T00:00:00Z)`,
groups by host/build/caller/spawn, orders by count descending, and limits 10;
its positive control was id `29288084`. Both reads completed with no child
failure. The second CLI invocation yielded native session 17280 and was drained
to exit 0; it was not retried as an empty result.

Source snapshot for these references: HEAD
`0325bcf20a1c2144215f775e1744399abd24e1cb` plus the shared working tree.
SHA-256: `main.rs` =
`613113a5b96cffe5ea1baad3f5838a2ac430c5603a3e36123eafffbcee60cc44`;
`client.rs` =
`96471030a05791427337feb37133ff5d00ef3eb3e10f29d05e8245c2e2d53e18`;
`capabilities/invoke.ts` =
`c8e58e77d31d398c7946dea4e6a91d0a7f78b753c1d16c108fa38877180d31f9`;
`dispatch-stack.ts` =
`d7486b7ca68ccf6f051d2bcbd7cc7b646a6b8dfe320b490bcc8e1cb648b44295`.
No production request replay, service restart, or account-refresh code change
was performed. P-008 remains open; the next independent step is a maintained
test of unrelated SSE invalidation versus account-specific invalidation before
changing refresh behavior.

### PUI account-refresh reproduction and source fix — 04:02Z

The maintained Cargo test
`tests::account_refetch_reads_only_for_account_updates_and_full_refresh`
reproduced an unconditional account read in the full PUI refetch path. It
drives the real `refetch_all` and `OperatorClient` over a private Unix socket,
counts actual `accounts:status` run-tool requests, and checks `AccountRows`
events. Before the fix, startup produced one request, then an
`activity.recent` invalidation produced a second: expected 1, observed 2.
That one selected test failed with exit 101; 1281 other tests were filtered
out. `/tmp/p008-pui-account-red-20261001.log` preserves the assertion.

Root cause: `RefetchSignal` scoped only plan reads; `refetch_all` always called
`accounts_status()` even for a non-account invalidation. An account-only
trigger would have left the request counter at 1, so the wire-level counter
distinguishes the two explanations. Existing plan-filter tests did not cover
account requests, which is why they missed this class.

The fix extends that existing signal with an independent account-read bit.
Debounce merges both bits with OR. Account query names and the raw pool/override
table invalidations retain account reads. Unrelated activity, inbox, plan and
tool-ledger invalidations skip them. Startup, malformed/nameless frames, and
the existing 60-second safety refresh still request full hydration; the
separate session-setup account fetch remains unchanged. No new timer, service,
configuration key or refresh system was added.

Verification:

- `cargo test --manifest-path apps/tui/Cargo.toml --bin pui refetch -- --nocapture`
  passed 4 tests, no failures or ignored tests, 1279 filtered out. The new
  wire test checks 13 sequential refreshes, including unrelated events after
  an account update; the new merge test preserves account and plan reads in
  mixed bursts. Log: `/tmp/p008-pui-account-green-20261001.log`.
- The final default `cargo test --manifest-path apps/tui/Cargo.toml` exited 0:
  PUI 1266 passed/17 ignored; audio helper 11 passed/3 ignored; CLI help 3,
  install contract 6, network read-model 3 and testing contract 4 passed.
  Total: 1293 passed, 20 ignored, no failures. The ignored live/hardware
  smokes were not exercised. Log: `/tmp/p008-pui-crate-final-20261001.log`.
- `rustfmt --check --edition 2021 --config skip_children=true
  apps/tui/src/main.rs` and the scoped `git diff --check` passed. Formatting
  edits were applied only to the changed main-file regions.

Final checkout identity: `2a027eae5c14556dde0c44aba1eeecdfa662c88b` plus
the shared working tree. SHA-256: `main.rs` =
`6825987e72d0e8ef2f9463e222dca8f86ca18c14c46336ea75c7ecfdfda801b5`;
`client.rs` = `96471030a05791427337feb37133ff5d00ef3eb3e10f29d05e8245c2e2d53e18`;
`Cargo.lock` = `1e05518fe723b494efacf5b6079ff244ca931904d21cef4ee44b9616a70ed3c2`.
Final Cargo-log SHA-256:
`7c4ad644817434ad68ffcc8153737793bf9819763f86d8c45caef80e36b3d25f`.

This confirms and removes source-level unrelated-event amplification. It
does not identify the trigger for every historical request or prove a
historical latency cause, current installed-PUI adoption, CPU savings or
final R-8 acceptance. Account-pool updates themselves may still be frequent.
The generic heavy-command wrapper initially queued this focused Rust test;
only that owned queued wrapper was terminated, then the documented Cargo
runner was used. Native MCP transport failure was handled by the sanctioned
attributed CLI; no write outcome was left unknown. No service restart,
production request replay, install, live-gate, Portal or federation action
was performed. P-008 remains open under the existing scope and D-006.

### Embedding fallback warning guard — 04:07Z

The current writer is `memory/embed-sidecar-spawn.ts:ensureEmbedSidecar`.
Its disabled branch returns null and logs the no-config fallback once per
process; under Vitest it logs only when the owning suite explicitly opts in.
`embedSidecarEnabled` requires `PAPERCUSP_EMBED_SIDECAR=1` and forbids recursive
spawning from a sidecar process. The existing canonical command
`PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file --
packages/operator-core/lib/memory/embed-sidecar-spawn.test.ts` passed 6/6,
no skips, exit 0, at checkout `2a027eae5c`. It checks enable/recursion
classification, null fallback, the actionable warning, once-per-process
logging, and reset behavior. Log:
`/tmp/p008-embedding-fallback-20261001.log`.

SHA-256: source `28d01d6798cb21c8b008715403ed6d9661358b439a63a40cee7920cafe3f04f7`;
test `8f28972fbd27350f5cac98cdb3594406d64e8dd4842e31ff4dc8500c8e2ca107`;
log `e90f3fb8d44ecb7eac5880542a3aa310df44e83681e6f033c83e906de46adc17`.
This verifies the intended disabled-path warning contract. It does not run
an embedding model, prove historical process configuration, quantify memory
or CPU cost, or settle the historical app-latency lead. No embedding source
change or shared-host operation was made; the historical impact remains open.

### Loop-lag and routine-shed evidence — 04:38Z

The frozen F11 audit's 148 loop-lag and 61 routine-shed entries are retained
warning-line categories from a capped tail. They do not count independent
incidents, CPU saturation, exhausted connections, or delayed user actions.

Current writers distinguish these measurements:

- `event-loop-lag-monitor.ts` uses the native delay histogram at 20ms
  resolution, with a default 10,000ms read/reset interval. Warnings start at
  p95 >=100ms and include elapsed window, observation count and maturity.
  Pressure defaults to 120/600ms; maturity requires 20 observations or an
  entire elapsed window. A timer on the observed loop cannot report during
  a synchronous block, and its delayed callback can lengthen the window.
- `routines-workflow.ts` schedules every 30 seconds by default. Its root
  scheduler currently never sheds on loop pressure; heavy ticks use the
  separate `tick-load-shed.ts` policy. The root also has an overlap skip.
- `pool-pressure.ts` times acquire plus SELECT1 across an await, subtracts
  a live-window p99 heuristic, then applies the timeout admission floor.
  Default classification thresholds are 250/2000ms. Neither the raw nor
  adjusted value isolates acquisition, query execution or scheduling.
  `pool-shed #N` counts critical-probe ticks during this process's lifetime,
  rather than a rate or distinct outages. Critical fires and loop-rebase
  survive that shed; non-critical fires and heavy sweeps are withheld.

The scheduler warning previously asserted `PG pool starvation` while printing
only the final adjusted/admission value as `acquire+SELECT1 probe`. A maintained
test invokes the real registered scheduler with private probe and DBOS effects.
Its pre-fix run failed on the actual warning: expected `slow pool probe`, received
`PG pool starvation ... probe 2500ms ... pool-shed #1` (exit 1). The first fixture
attempt stopped on an incomplete workspace mock; it supplied no product proof.

The existing warning now emits `slow pool probe`, raw wall milliseconds,
raw-minus-p99 milliseconds, the classified admission value, p99 discount,
critical threshold and process-local shed count. This extends existing probe
getters and the warning; it adds no table, timer, config key or admission policy.
The regression covers both a slow completed probe and timeout-floor admission
(raw 1000ms, discount 500ms, net 500ms, admission 2000ms). The wider run exposed
an old lag-test expectation that contradicted the full-window maturity rule;
the assertion now accepts maturity for its elapsed 475ms/100ms window.

Canonical verification:
`PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file --
packages/operator-core/lib/dbos/routines-workflow.test.ts
packages/operator-core/lib/dbos/pool-pressure.test.ts
packages/operator-core/lib/dbos/tick-load-shed.test.ts
packages/operator-core/lib/event-loop-lag-monitor.test.ts`.
Final result: 134/134 passed across four files, no skips, exit 0; checkout
`0f943d68e5` plus local source/test edits. Logs:
`/tmp/p008-routine-probe-red-20261001-r2.log` and
`/tmp/p008-loop-shed-matrix-20261001-r2.log`.

SHA-256 at verification:

| File | SHA-256 |
|---|---|
| `event-loop-lag-monitor.ts` | `dd31ac5495ed4b4fc0d0dbd3555130e2e84ffcac9eb26cdd4a1fb725016b6bd1` |
| `event-loop-lag-monitor.test.ts` | `d046b59141827a2c2e029037b81daef9cb6ac4d70c0ff44fda61f466578a0162` |
| `dbos/pool-pressure.ts` | `182d4c755b657f6cf578aa0fb7062c9da9be4c47f8750959d372789b13fdfe1b` |
| `dbos/pool-pressure.test.ts` | `6622ed044ec5fcbbfacdbe4931ade802ebdba594be804ef77393b3308bb9b5f1` |
| `dbos/tick-load-shed.ts` | `28b9c9cbd162cf19666c97710bc4f09e4feee842cac7b6d411bc9762315d94b8` |
| `dbos/tick-load-shed.test.ts` | `da172e2f00b01c83c496981e6afc19165636d0871777a1d05d3c1fbea6480d5a` |
| `dbos/routines-workflow.ts` | `f8de17f0032b18b9be163227e56977f2e395584e5151d8f9e6a0e781b5015a49` |
| `dbos/routines-workflow.test.ts` | `54057bcfc00a6fc9eb5f7bb31b11b89cb6078ab5dd90f21de0103c5c035d8adc` |
| Final matrix log | `2b21259ac5ebad205623e7d0dceb26f322afa5b2f9877ab5e5c033339d43ae96` |
| Pre-fix warning log | `f047b1c7fda8a88bf21f8ef7aef3f606d27cf67d47b97043762354ae625de61a` |

These checks fix causal overstatement at the diagnostic writer and preserve
the existing scheduling policy. They do not establish live adoption or the
cause, frequency, or app-latency effect of historical shedding. No shared
service, live-gate, Portal or federation operation occurred. P-008 remains open.
### Migration reservation accounting and backup safety — 2026-10-01 05:12Z

**P-008 remains open.** This unit corrects a source diagnostic and verifies
the existing backup boundary; it does not establish historical backup progress,
loaded-host adoption, application latency improvement, or R-8 acceptance.

The frozen F11 audit observed a backup advisory-lock holder and an idle SQL
connection. The external producer's progress was not measured, so those facts
cannot classify the historical wait as a stalled backup. Current boot source
retries the rendezvous every five seconds, checks the pending files against
backup-locked relations, and checks again before applying an unlocked pending
file. The existing guard includes partition ancestors and indexes, and rejects
unprovable SQL footprints. WI-10002822's stored recovery receipt covers the
separate migration-readiness latch; no federation restart or induced outage
was performed here.

Root cause of the accounting defect: `reconcileMigrationReservations` logged
and returned the number of planned rows after `ON CONFLICT (num) DO NOTHING`.
A peer reservation committed after its SELECT makes that number differ from
the rows this invocation inserted. The canonical integration regression
commits such a peer row immediately before the real INSERT. The valid pre-fix
run failed with **expected 0, received 1**. The existing INSERT now uses
`RETURNING num`; the result and diagnostic use only those returned rows and
remain silent when none were inserted. Peer reservations remain intact.
No migration, table, timer, tool, or admission policy was added.

The regression also exposed an order-dependent fixture: reconciliation cases
relied on earlier runner cases to create `schema_migrations`. The canonical
`beforeAll` now creates the ledger using the migration runner's table layout,
so a name-filtered reconciliation case is independently runnable.

Verification used the maintained `startDedicatedNativePg` helper and its
documented `PAPERCUSP_TEST_PG_ADMIN_URL` override, with a fresh private cluster
and the canonical test router. The final command was:

```sh
PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- \
  packages/operator-core/lib/db-boot-migrate-reservations.test.ts \
  packages/operator-core/lib/backup-lock-migration-proof.test.ts \
  packages/operator-core/lib/db-boot-migrate.integration.test.ts
```

The helper supplied the private admin URL to the child, then `stop()` ran in
`finally`; explicit assertions checked directory removal and connection refusal
on the private port. Final result: **52/52 passed, zero skipped, exit 0**
(24 unit cases and 28 integration cases), at HEAD `36e3f8e6e7` plus local edits.
The tests cover conflicting-backup wait/resume with the advisory lock still
held, unrelated relations, no-pending boot, snapshot admission, cooldown,
ordinary reconciliation, historical-conflict filtering, and the peer race.
Scoped `lint:tsc` for the two changed TypeScript files was clean, exit 0.
Scoped `git diff --check` passed. Neither a typecheck nor an excluded case is
counted as test evidence.

Attempt audit: the initial tool foreground cutoff recovered a passing detached
seven-case run (20 excluded). A later shared-Docker attempt never ran assertions:
startup lock acquisition exhausted 180 seconds, then `beforeAll` expired at
90 seconds. The first private attempt exposed the missing fixture ledger.
Those attempts are not product counterexamples. The private rerun below is
the actual expected-0/received-1 counterexample. No shared startup lock, holder,
database, or service was altered to obtain it.

Evidence files and SHA-256:

- `/tmp/p008-reconcile-race-private-red-20261001-r2.log`:
  `2cef757f828a757d3de518ca80e0612f570677be29f333339606eb13cf924f56`
- `/tmp/p008-migration-private-matrix-20261001.log`:
  `ddc6c4f30cae7e259c9a409d5210e2f64ad254d57d6eba7cebb1c8d358a4c1ae`
- `/tmp/p008-migration-tsc-final-20261001.log`:
  `ae86de4f16b5091448f3a678fd382bab03f63dc019312ca40ccb50f7bd5c2544`

The six measured source/test fingerprints were unchanged across the final run:

| Path under `packages/operator-core/lib/` | SHA-256 |
|---|---|
| `db-boot-migrate.ts` | `00e0444a5f0c879eafcdcce8894cdb64afd8e99653907040dd5236d21c172ca7` |
| `migration-reservation.ts` | `5d4a0b678746db0d4a9066d6a19a9f049f4343236dcf3c032271ce82df5c41d5` |
| `db-boot-migrate-reservations.test.ts` | `bc848fd25f8135ccce260b7af0c94fbba8c58c514748bcab059f4bbc75f5c3fe` |
| `db-boot-migrate.integration.test.ts` | `dd37aca3f860e911c7e232cc4c644538f1c1e5f4d07dbceeb064ca5eb6bee478` |
| `backup-lock-migration-proof.ts` | `40041543b475c38b4cf83d0096617213b063a64b9c1eb825e7f5dce85bfc9c13` |
| `backup-lock-migration-proof.test.ts` | `4e7cde86f34ab9856ce64e1bfafadec13cc6e2d43fd0f8999ed93faf4e378c78` |

### Diagnostic deadline continuation — 2026-10-01 05:40Z

**P-008 remains open.** This verifies a current source defect and its guard,
not the origin or performance impact of the historical 3,500-second `psql`
DO scan. The frozen audit identifies that separate scan as diagnostic work;
its contribution to application latency and the current loaded hosts remain
unverified. No shared host, database, backup holder, Portal or gate was changed.

Root cause: the whole-call timer settled the caller while the postgres-js
transaction promise kept running. A connection acquired later still started
SQL; a positive control completing later still started the target scan. The
maintained unit regression reproduced three failures before the fix: delayed
read and EXPLAIN each issued four statements after expiry, and a delayed
positive control issued the target scan. An intermediate five-case run passed
the three repaired read cases and independently reproduced the same late-start
defect in mutation and dependency-traversal transactions (three and four SQL
calls respectively). These discriminate abandoned driver continuation from
an already-running database statement ignoring its server timeout.

The existing `withCallDeadline` now also accepts a work factory with an active
deadline assertion. It records expiry before rejecting and uses a monotonic
clock to reject overdue continuation even before a delayed timer runs. Existing
read, EXPLAIN, mutation and dependency-query callers check at statement
boundaries. A mutation resuming after DML or audit completion throws inside
the transaction and rolls back. Existing SQL budgets, READ ONLY, row caps,
positive-control scope, mutation guards and audit atomicity are retained.
No timeout policy, timer service, table, tool or config surface was added.
This does not cancel an already-running PostgreSQL statement or prove the
timing of COMMIT; server-side statement timeouts remain necessary.

The eight pure lifecycle regressions live in the canonical
`packages/operator-core/lib/pg-query-deadline.test.ts`. Separating them from
the existing filesystem-census tests lets the maintained mutation-probe fence
prove their import scope; two earlier broad-file attempts were refused before
any test process started during a peer's public-listings probe. No probe or
lock was bypassed. The original `pg-read-query.test.ts` content was restored.

Verification receipts:

- Baseline: 347/347 unit tests passed, zero skipped, exit 0, at HEAD
  `6563e1ea76`; `/tmp/p008-diagnostic-baseline-20261001.log` SHA-256
  `8da2b02535259a72e0603d11bfdb087a3851e2dc2865dca16868f69946cf5ddb`.
- Initial red: `testing:run` `35dc3925-e02b-4194-9d20-a78645bf145b`,
  test-run `20355686`: three failed, 347 excluded.
- Sibling red: `36eebcc0-345d-412d-b298-b2ae59245d0a`, test-run `20355752`:
  three passed, two failed, zero skipped.
- Final five-file matrix: `039071d8-f936-4473-bc6a-dc423582e2c4`,
  test-runs `20356048`–`20356052`: **466 passed, zero failed or skipped**.
  Files: `pg-read-query.test.ts`, `pg-mutate-query.test.ts`,
  `dependency-traversal.test.ts`, `agent-tools/dev/pg_query.test.ts`,
  `pg-query-deadline.test.ts`, all under `packages/operator-core/lib/`.
- Real private PostgreSQL: canonical `pg-read-query.integration.test.ts`
  **33/33 passed, zero skipped, exit 0**. Its new case executes a real UPDATE,
  withholds the driver result beyond the 4,000 ms caller deadline, then
  releases it and reads back the original value after rollback (4,017 ms).
  `/tmp/p008-diagnostic-private-matrix-20261001.log` SHA-256
  `71c3db33d6b66ea30bcceb45a113b7b5855e6ebc3cb2f19d29e98b86e71ac9c2`.
  The maintained `startDedicatedNativePg` helper supplied only a fresh private
  admin URL via `PAPERCUSP_TEST_PG_ADMIN_URL`; `stop()` ran in `finally`.
  Directory removal and private-port connection refusal both passed.
- Scoped `lint:tsc` baseline gate passed, exit 0, for the five changed code/test
  files and its selected importers. It reported one baseline-covered type
  error, so this is not a zero-diagnostic claim. Log SHA-256
  `a691d0e105e49be3b20670f902e3132c410fd8c7dd5643b99477c94d2c057262`.
  Scoped `git diff --check` passed.

Re-run the five-file matrix with `testing:run { files, harness:'papercusp' }`
or the canonical `npm run test:file -- <five paths>` router after relevant
fingerprints change. Re-run the integration file through that router with
the maintained private native-PG override; assert cleanup again. The private
orchestration is fixture setup, not a separate test implementation.

Final fingerprints at HEAD `6563e1ea76` plus local edits:

| Path under `packages/operator-core/lib/` | SHA-256 |
|---|---|
| `pg-read-query.ts` | `94dc38fce2be3121edf16d0737f22ef2d2506817a2fe98a5e97b6e759a273dc8` |
| `pg-mutate-query.ts` | `246ce21df810d8a665d382a62c7a17f37f4fd43e8fad43c5db31786ba739e26a` |
| `dependency-traversal.ts` | `c5e22a8d84d60cb95f8307501d4a315cf5edc23091b46715ee86bc8f83d57fc6` |
| `pg-query-deadline.test.ts` | `54b7a0a791ee87257961e0e1016a3e717526c2c24277af0d3981e1e025053eec` |
| `pg-read-query.integration.test.ts` | `4c73018ff2a1f4eaf7bc82e07a8e9e63941e46054d854b9191eaa87c5a195993` |
| `pg-read-query.test.ts` | `e4a7512a038cce5f6d267de5f6adc852ca6751349b51e740c2ddae01a3073153` |
| `pg-mutate-query.test.ts` | `75024df2b6003c972a5173d0878ece93d676d76ca1e03ef524a721a9ef66830d` |
| `dependency-traversal.test.ts` | `39d00d539ba4dc099f72b8f8da9edcaa6e8ad71e72f2a28d9c741e751b5fa6a2` |
| `agent-tools/dev/pg_query.test.ts` | `b5f6dedb061b72fe98a164f786e8d67997a9676a8cc8264b7c6db41762946357` |
| `agent-tools/dev/pg_query.ts` | `1dab98320657298c05300b02415498d81c5eb857354f859d65f0fd8853524c52` |

### Account-pool no-op invalidation — 2026-10-01 06:02Z

P-008 remains open. This is a verified source defect and private-runtime fix;
the historical frequency of this producer, loaded-host adoption, and its
contribution to application latency remain unverified.

The existing `updateAccountPool` normalizes the locked document before calling
its mutator. Some legitimate mutators produce an equivalent document: for
example, `recordAccountPenalty` for an account already removed from the pool.
`updateOperatorState` nevertheless performed an unconditional upsert, advanced
`updated_at`, and emitted `accounts.pool`. The database row trigger also saw
that unnecessary UPDATE. PUI's prior account-only refresh fix correctly treats
this event as an account refresh, so fixing the consumer alone cannot remove
this producer-side amplification.

The maintained account concurrency integration suite now measures PostgreSQL
`xmin` and `updated_at`, and captures the application's sync invalidations.
Before the fix, the unknown-account no-op changed row version `3965` to `3966`
and timestamp `1790834266923` to `1790834266930`. The separate key-reordering
case changed version `3968` to `3969`. Both cases failed, exit 1; six excluded
cases were not evidence. Private directory removal and port refusal passed.

The existing plaintext upsert now uses `IS DISTINCT FROM` on PostgreSQL JSONB
for `operator_account_pool` only, and `RETURNING workspace_id` determines
whether to publish a refresh. Both the direct state-write and transactional
mutation seams use this guard. The existing transaction and row-lock path
remains intact; local cache invalidation still ensures the caller does not
retain a stale pre-transaction value. Other state tables retain their write
semantics, including writes of identical payloads. No table, migration, flag,
timer, service, tool, or alternate account-pool writer was added.

Final verification at HEAD `6563e1ea76` plus local edits:

- Five canonical unit suites: **77 passed, zero skipped, exit 0**.
- Canonical real-PG concurrency suite: **10 passed, zero skipped, exit 0**.
  It covers equivalent/key-reordered documents, in-place rate changes, direct
  no-op writes, unchanged non-pool writes, row-lock waiting, parallel
  registrations, and registration/rate-write races. The old lost-update shape
  remains a failing-behavior positive control. The maintained
  `startDedicatedNativePg` helper supplied only a fresh private admin URL via
  `PAPERCUSP_TEST_PG_ADMIN_URL`; `stop()` ran in `finally`, followed by explicit
  directory-removal and refused-port assertions. Native sessions 34747 (red),
  37500 (first green), 9263 (final green), and 36785 (typecheck) were drained.
- Scoped `lint:tsc` baseline gate passed, exit 0. It reported three diagnostics
  across two files within their existing baselines; this is not a claim of
  zero type errors. Scoped `git diff --check` passed.

Canonical commands (supply the private helper's admin URL for the integration):

```sh
PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- \
  packages/operator-core/lib/operator-state-pg.test.ts \
  packages/operator-core/lib/operator-state-cache.test.ts \
  packages/operator-core/lib/deployment/account-pool-store.test.ts \
  packages/operator-core/lib/deployment/account-pool-write-path.test.ts \
  packages/operator-core/lib/deployment/account-pool-store.override.test.ts
PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- \
  packages/operator-core/lib/deployment/account-pool-concurrency.integration.test.ts
```

| Source/test path under `packages/operator-core/lib/` | SHA-256 |
|---|---|
| `operator-state-pg.ts` | `43522584b5a4ba3089e0ad4f505c1b6c3ab3c3d48212e3428fc0ce26a9e34734` |
| `operator-state-pg.test.ts` | `b55911055dafa9ff3455ed222490d5908a98c2f73100ba725c971b037267e517` |
| `operator-state-cache.test.ts` | `57eff6952bce9418f583fb387a3e99c7460a5185371f2c289a2916283430e2d4` |
| `deployment/account-pool-concurrency.integration.test.ts` | `600e1c1fc45c0ff730483696a965b7e0e11f2c48a4d879c48654f4d3a292ca5b` |
| `deployment/account-pool-store.ts` (unchanged writer wrapper) | `bd1bff0ca9c7e1fb1a90c876e9c7e5f5d41258b964bd64c675e25382d1b7138a` |

| Evidence log | SHA-256 |
|---|---|
| `/tmp/p008-account-noop-private-red-20261001.log` | `37aae1b91ef37e852c47408746e03287bd3d997b235ea8aca9d4938093dca89e` |
| `/tmp/p008-account-noop-private-matrix-final-20261001.log` | `c0ae6b69bed2a5fd61a0778d4a72116e8f4deeb41d7710a0e8b204ba9978e816` |
| `/tmp/p008-account-noop-unit-matrix-20261001.log` | `df41b304e0f0e8c768c4d585ff6fc27d000f43f7e4fb8a9423622bcad8ad5db6` |
| `/tmp/p008-account-noop-tsc-20261001.log` | `068212cf1530e029f6084cee586b3a85489b544ffb313e0dd05746b7afa41778` |

The gateway projector's current throttle key includes account, rate-limit
bucket, and model, with a 30-second floor and meaningful-window-change check.
That source is not evidence of the historical emitter mix. No shared database,
service, federation host, Portal, or live release gate was operated here.

### Historical account-trigger evidence limit — 2026-10-01 06:25Z

P-008 remains open under `AUTO-BAR-R-8-P-008@2`. The fresh continuation
`01a0f617-7c4e-7403-accf-c5789c400c5c` recovered the newer 06:08Z work-item
checkpoint and 06:10Z loop checkpoint, which supersede the incoming 05:45Z
carry note. The account-pool no-op fix was already verified; its five saved
source/test fingerprints still match, so that matrix was not repeated.

The exact retained high-volume account-call population was re-read with
workspace, tool, caller, spawn, host, build and timestamp predicates:
`papercusp-workspace`, `accounts:status`, `pui-2057122`, `palette`, `port-3170`,
`e5b3a2cb54`, `[2026-09-23T03:00:00Z,2026-09-23T04:16:00Z)`. A scalar inventory
and a separate exhaustive null/empty partition agree on **1,488 calls**,
from `03:00:54.263Z` through `04:15:04.197Z`. Every retained call in this
population has `{}` arguments; its metadata contains only `kernel` and
`uiClientId`. Both reads used same-scope row `28953729` as a positive control;
the final partition completed in 63ms, with one returned cell and no truncation.
This is a coverage statement about that exact call population, not a census
of all September 23 traffic. It establishes that these retained rows cannot
identify the triggering SSE frame; it does not establish which producer ran.
The saved current-window control `30385108` likewise contains only those two
metadata keys.

Source distinguishes the available evidence surfaces:

- The pool trigger emits a raw table-change event. The existing membership
  audit returns without inserting when the account-id set is unchanged, so
  that audit cannot distinguish rate-window updates from equivalent writes.
- The sync bus keeps a process-local 60-second replay ring. Its `onMessage`
  sends each raw event, then separately coalesces the logical bridge target.
  The 90-second logical dedupe therefore does not bound raw table-event
  delivery. Current PUI correctly recognizes both `accounts.pool` and the
  raw pool-table event as account refreshes. A source-side throttle or logical
  dedupe alone cannot establish the historical PUI request cadence.
- The gateway projector uses account, bucket and model in its throttle key,
  a 30-second floor, and a meaningful utilization/reset-change check. This
  source policy does not identify the historical producer mix or loaded PUI.

The maintained canonical invalidation-bus test `bridged full-bust targets
dedupe within the window, like an explicit notifyInvalidate` verifies three
raw deliveries versus one logical delivery inside its scaled window. It
passed **1 selected test**, exit 0; **30 excluded tests provide no evidence**
in this run. Log `/tmp/p008-account-raw-bridge-20261001.log`, SHA-256
`e0f8c01944c79418c3e4b0bcdfd7c7eaf34b7db678a3859181e82406c5f326a6`.

PUI's source fingerprint changed since the saved 04:02Z proof, so its focused
canonical Cargo regressions were rerun: **4 passed, 0 failed, 0 ignored,
1,281 filtered out**, exit 0. This preserves the account/unrelated-event
distinction on the current source; the prior full-crate result remains dated
evidence. Log `/tmp/p008-pui-refetch-current-20261001.log`, SHA-256
`9706ae6a96e877072e644b3de87de9a03fb61e17ce967fcd16281b7daa65e024`.
Current fingerprints: PUI `main.rs`
`27a6a7c4f5e8c52cdfa375801207658eb3f67ed2bee9a9782ecf4424b989a932`;
sync bus source `622353a18b8bbe5adbec9bd3a75e3657bf381883d44caf5ae7bcc7f351c10221`;
sync bus test `5bc78ac6a36c20c4429c56c1993f2dda9a63faeb15ac55349c9e58f3c8e4cd1b`.

The leader's current reply explicitly retains loaded-fix adoption as unknown
(`coord-send-006aed5f0b53c4522e20e5dbf28d19061125f0004c8c559678e8a2d97f026d9c`).
Historical triggering frames, actual producer mix, installed-PUI adoption and
application latency impact remain unresolved. No source behavior, shared
service, account credential, federation, Portal or live-gate action changed.

### Historical diagnostic DO snapshot recovered — 2026-10-01 06:52Z

**P-008 remains open.** The original F11 observation is now recoverable from
the permanent archive of audit session
`01a0cf17-6a94-7bf1-a42b-bef1c9d8a9a3`, rather than an inferred current
activity scan. The maintained archive reader returned one 6,809,735-byte
transcript, verified against SHA-256
`4f36c216c7a52f572c3c0f95a7eb83fe2842d6554da6b4da89e889941fb0938e`.
No transcript was restored and no live activity census was performed.

At archive line 351, timestamp `2026-09-23T22:12:21.302Z`, call
`call_ETbQ2bxDMYRv7gJPeCo5SYK4` requested a bounded `dev:pg_query` read of
active queries older than 30 seconds in the current database, ordered by
query start, with `maxRows:12` and `timeoutMs:4000`. Its age expression is
`round(extract(epoch from now()-query_start))`; its SQL deliberately returns
only `left(query,320)`. Line 354, completed at `22:12:23.068Z`, retains this
row:

| Field | Observed value |
|---|---|
| Backend PID | `3962125` |
| Application label | `psql` |
| State | `active` |
| Statement age, rounded seconds | `3527` |
| Wait type / event | `null` / `null` |
| Blocking PIDs | `[]` |

The retained prefix begins `DO $$`, declares a record and bigint, visits
`information_schema.columns` where the schema is `harness_shared` and the
type is `text`, excludes table names matching `bak_%`, then constructs
dynamic `SELECT count(*) ... WHERE ... LIKE ...` statements. The original
pattern, remainder of the block, launch command, timeout configuration and
agent identity are absent from this 320-character observation. An active
backend with no sampled wait is not proof of CPU consumption or its effect
on application latency.

The observation command read the pre-existing backend; it did not launch
that DO block. Both the audit source snapshot `509f7b0b56` and current
`assertSingleReadStatement` accept only leading SELECT/WITH, while the
current read seam installs READ ONLY and a bounded statement timeout. Thus
this DO shape is outside that maintained read contract. The `psql` label
suggests a native SQL caller, but neither the label nor source validation
identifies its original launch route or proves what the historical serving
process loaded. The prior query-deadline fix is a separate confirmed defect.

Receipt: completed task `0mup6bvr9150ptqk1j6`, exit 0, reduced log
`.papercusp/scratch/bash-676d045f-949.log`, SHA-256
`a3f7c38e4b60c357df1bd59ebf3fccbdc18c3aa0c1c0ee8a9adbdc0b839acfc7`.
Current read source/test hashes still match the 05:40Z five-file proof, so
that test matrix was not repeated. The source and archived-call readback
verify this investigation; no runtime performance or shipment claim follows.

The 13 legacy EIs inspected this turn are all `change/open/unassigned` with
`lane:observation`, `origin:checkpoint-harvest`, and
`harvestSource:loop-checkpoint`. They were harvested from proof notes. The
fleet leader acknowledged ownership of their routing in
`mup656x1-0000-619b1db28fbd460c977cc3910f91759e`; no member-side claim or
terminal disposition was made. Their full inventory remains on WI-10002830.

### Native diagnostic launch and independent SQL lifetime — 2026-10-01 07:45Z

**P-008 remains open; no live R-8 acceptance is claimed.** This entry supersedes
the preceding investigation's unknown original launch, full SQL and shell timeout.
It does not establish exact historical backend linkage or application impact.

The maintained archive reader recovered the exact Claude transcript
`6208927d-9f3a-4a92-8ea8-74eaaca026ea`: 1,505,615 bytes, SHA-256
`3cbd6efa447616f6c6b52ecea2a04830726955968fc08b7431abce9f20aa600d`.
Line 88 at `2026-09-23T21:13:35.274Z`, tool-use
`toolu_011ffskoLo3VhEFWRgfqGc4K`, launches the scan through
`capability:bash`, `sudo -n -u postgres psql -d papercusp -At` and a quoted
SQL heredoc. Dispatch receipt `29268988` identifies caller
`su-cecee8ca-952a-463c-bd06-ef584b4d0acd`. The DO block visits every
`harness_shared` text column except `bak_%`, dynamically counts matches for
`%WORKSPACE STAND-DOWN DRAINED THE BOX%`, and catches ordinary SQL errors.
The command contains no statement timeout. Full SQL SHA-256:
`31f8063862a1dad37779aaf0e71d239cf8ca7ab0257cf5857c8ebb0863099f8a`.
Its first 320 characters exactly match the frozen PID `3962125` query prefix.

The paired result at `21:14:20.661Z` retains task
`0muelod7g1hap2451co`, bash ID `6822e638-1ae`, response window 45,000 ms,
execution timeout 120,000 ms and deadline `21:15:35.479Z`. Its original log
records terminal `failed/timed_out`, exit 143, at `21:15:35.517Z` /
`21:15:35.549Z`, SHA-256
`4b655b6b14118ab93a2a2ecd39fc37c956512993e91b3207bcf354f788a573d1`.
Reduced archive receipt: `.papercusp/scratch/bash-d7a46e42-d52.log`, SHA-256
`189c4237d008fa1322bea1a0dab7afbedfe6e3c64f4edca319cc5338f61bc758`.
The dispatch writer timestamps settlement, not launch; its 45,071 ms duration
places handler entry at approximately `21:13:35.382Z`, consistent with the
native transcript. Prefix and chronology support a match, but no retained
receipt links that shell task to backend PID `3962125`. A duplicate launch
outside the retained window is not excluded.

Historical source `509f7b0b56` signals the shell process group and, when present,
its systemd service. Those boundaries do not contain the independently owned
PostgreSQL backend. PostgreSQL documents that disabled connection checks detect
a disconnected client at the next socket interaction; a server statement timeout
separately bounds query execution. These are documented mechanisms, not measured
historical configuration: [connection checks](https://www.postgresql.org/docs/18/runtime-config-connection.html#GUC-CLIENT-CONNECTION-CHECK-INTERVAL),
[statement timeout](https://www.postgresql.org/docs/18/runtime-config-client.html#GUC-STATEMENT-TIMEOUT).

The new conventional integration suite
`packages/operator-core/lib/pg-client-disconnect.integration.test.ts` uses
the maintained `startDedicatedNativePg` fixture, a real psql frontend and the
existing `runForeground` shell path. It records the backend PID and settings,
then observes that exact PID executing a uniquely tagged `pg_sleep` before
accepting any termination evidence. With connection checks and statement timeout
explicitly zero, the 5-second shell deadline kills the frontend while that exact
backend remains active. With the same workload and a 1-second server statement
timeout, psql reports statement cancellation and the identified query stops.
This distinguishes frontend termination from SQL cancellation. It does not
reproduce the old database contents, sudo route, shell signal sequence or app
latency, and does not measure shared-host adoption.

Canonical `npm run test:file -- packages/operator-core/lib/pg-client-disconnect.integration.test.ts`
passed **2/2, zero skipped**, exit 0 at `9f9ff57142` plus the local new test.
Both test-cluster teardown and the outer maintained native-PG override verified
directory removal and private-port refusal. Log
`/tmp/p008-client-disconnect-20261001.log`, SHA-256
`3f087bb1f03c540042ec315347f8fe31ce6d17cf8085e18d9ff92525f61f9253`.
Test SHA-256: `65bf0c18a207e00af6db5e4f93163877239399546ba55582c8911c5ab245be6d`;
shell implementation SHA-256: `a95b5ca361eebbc2b2b59160f19bf303f1328876680755826f9672c72003c3d6`.

The existing shell tool's timeout argument now explains this external-server
boundary and directs diagnostic reads to `dev:pg_query`, or native SQL to an
explicit verified server deadline. No new tool, policy or global PostgreSQL
setting was introduced. Guidance regression suite passed **4/4, zero skipped**;
scoped typecheck passed with **zero diagnostics**, including direct importers.
Logs `/tmp/p008-bash-guidance-20261001.log` SHA-256
`7cc6ebe865f0ad42c110a42d1eca03dafb5689dcf3245c4688dccd27ab509ceb` and
`/tmp/p008-client-disconnect-tsc-20261001.log` SHA-256
`a1c4da60a2f575229e08bea69bba96d4a2a95f785126764d4bae6b18b36753de`.
Tool source SHA-256: `413e1d217d9d28bda601c5358c0be85b031cd4e52e6020f869227a4f1a7d5642`.
The twelve existing checkpoint checks are preserved at their cap; this additional
proof is retained here and in fact `p008-native-sql-lifetime-20261001`.

### Historical task retention and current-host phase receipt — 2026-10-01 08:14Z

**P-008 remains open; this is additional live measurement, not R-8 acceptance.**
The cold wake's 07:25 carry-note was superseded by the work-item and loop notes
written after the 07:45 integration proof. That proof was recovered rather than
repeated: the test, shell guidance and retained integration log hashes still match.

An exact read of `harness_shared.task_ledger` for workspace
`papercusp-workspace` and task `0muelod7g1hap2451co` returned zero rows,
untruncated, with a same-table/scope bash-job positive control
`0mup90r6eq60uuo4gys` passing. This establishes absence from the current ledger,
not the absence of the historical launch. The source writer
`task-manager/store.ts:gcTerminalTasks` removes non-release terminal rows older
than its retention horizon; `harness/routines/task-reconcile-action.ts` passes
168 hours. The historical task is older than that horizon, but this read does
not distinguish deletion from an original missing registration. The archive and
original shell log retain the launch and timeout. No retained task receipt links
that launch to PostgreSQL PID `3962125`; historical server settings and app impact
remain unknown. The initial `tasks:get` miss was from the separate harness task
surface and is not used as process-ledger evidence.

The maintained `dev:pipeline_position` route for the actual changed path,
`packages/operator-core/lib/search/session-ingest.ts`, still requires the
disposable background assertion specified in D-006. Its recovered read reports
bg-host build `9f9ff57142`, with matching source blob; it does not measure workload
performance. A bounded, read-only journal measurement independently confirms
natural phase logging on the running host. All seven phase rows identify PID
`1650535` and systemd invocation `c126a26dc6dc4d52813bd11014a21fe3`, matching the
current unit identity. Its recorded start is `2026-10-01 03:31:31 EDT` (07:31:31Z).
No worker restart was performed.

| Completed sweep, UTC | Total wall ms | Largest exclusive wall bucket | Bucket ms |
|---|---:|---|---:|
| 07:56:50.109 | 11691 | writes | 9103.5 |
| 07:58:57.083 | 25306 | writes | 14435.2 |
| 08:00:51.959 | 12387 | writes | 3462.6 |
| 08:02:52.191 | 12255 | writes | 3170.3 |
| 08:04:52.523 | 13878 | history | 4112.8 |
| 08:07:04.915 | 32618 | discovery | 13997.9 |
| 08:08:54.636 | 15528 | writes | 8144.1 |

The source writer uses exclusive `performance.now()` wall-time buckets, including
await and scheduling time. These values identify where elapsed time accumulated;
they do not establish CPU, acquisition latency, or a shared-resource cause. The
changing workload and largest bucket also preclude treating these sweeps as a
controlled before/after comparison. Every retained sweep reports zero errors.
The bounded window is 07:56–08:09Z; the maintained `logs:read` result returned seven
rows with no journal error, unknown unit or truncation. A second bounded read
recovered the PID and invocation fields that `logs:read` omits.

Attribution receipt: task `0mup9bfumiwatefin87`, exit 0,
`.papercusp/scratch/bash-bb688f39-2f2.log`, SHA-256
`3a88b899cb84dfa2258de3914bba398bd0930399e3d9fbc8946fead440029739`.
It retains the exact window, identity, timestamps and every phase bucket.
Source SHA-256 remains
`a63bb35bca2738b33f62084917b9c3fa3b522ca21d37946000ae8786449529a3`;
the maintained integration fixture remains
`94b732691b66c53566dde190c0c3b0eef91d5adb35f81468eb20a0d4c0e2b167`.
Unchanged proofs were not rerun. The earlier statement that live phase adoption
was unmeasured is superseded for this identified incarnation and bounded window.
The mechanism behind the variable waits, historical account emitter mix, backup
producer progress, shared-host adoption of other fixes and app impact remain open.
The next distinguishing measurement must separate waiting from active work in
one identified phase, with an alternative and a bounded workload; it must not
attribute these wall-time buckets to CPU or close R-8 from phase logging alone.

### Matched isolated discovery waits — October 1, 09:09Z

WI-10002830/P-008 extended the existing maintained runtime assertion rather
than introducing a production observer. `listCandidateFiles` awaits the
`jsonlAtDepth` walk and then each candidate's `stat` sequentially. The fixture
now alternates observation off/on/on/off across four equal-size useful-tail
passes, each followed by an unchanged pass over the same 4,800 candidates.
The private child wraps real `fs/promises.readdir` and `stat`, synchronizes
their ESM bindings, and restores both after every sweep. Only its managed
fixture root is observed; neither filesystem results nor the clock is mocked.

Each observed sweep verified 1,601 directory reads, 4,800 stats, and at most
one outstanding observed operation. The first attempt failed because this
author expected 1,281 directory reads: the exact five-level layout includes
the final day-directory enumeration. That expectation was corrected from
the walker source and the observed 1,601; the production implementation
was unchanged. The passing canonical run was:

`PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/search/session-ingest-runtime.integration.test.ts`

It passed 1/1, zero skipped, exit 0 at HEAD
`f8610a668bf7625d1c4394e58d3a8a74018c7406` plus the local fixture edit.
The router retained that HEAD throughout the passing run. Source SHA-256
remained `a63bb35bca2738b33f62084917b9c3fa3b522ca21d37946000ae8786449529a3`;
fixture SHA-256 is
`cb3449ec08166aaed7ebbd0ac7e5d769bbc582fe116986db3ed405a9c4c6b865`.
Child PID 2660140 used Node v25.9.0 and background workers enabled, DBOS
routines disabled, a disposable migrated database and private HOME/workspace
with runtime credentials stripped. It read back 256 turns and 2,560 parts,
verified offsets, removed HOME/datadir, and observed the DB port refuse a
connection. Workload hash:
`6fda56724fe55c56706e4c99460603d83685d6e3debceca2f24a3210b6140ad4`.

| Observed sweep | Wall ms | Discovery ms | Directory/stat await spans ms | Main-loop idle within those spans ms | Decode ms | Writes ms |
|---|---:|---:|---:|---:|---:|---:|
| Useful tail 2 | 1577 | 292.2 | 272.4 | 174.8 | 809.0 | 210.4 |
| Matched unchanged 2 | 557 | 293.5 | 273.0 | 169.9 | 0 | 0 |
| Useful tail 3 | 1460 | 305.3 | 285.8 | 181.1 | 723.7 | 168.4 |
| Matched unchanged 3 | 529 | 294.5 | 273.2 | 167.9 | 0 | 0 |

Await spans include queueing, kernel work, callback scheduling and promise
continuation; they are **not kernel IO duration**. Main-loop active/idle is
the difference from `performance.eventLoopUtilization` across each real
await. Its active time is not a CPU sample. Whole useful sweeps 2/3 recorded
main-loop active 1251.5/1158.5 ms and child process CPU 1553.6/1520.4 ms;
their unchanged partners recorded active 380.8/354.5 ms and process CPU
593.3/570.6 ms. CPU sums `process.cpuUsage` user/system across all child
threads, excludes the separate PG process, and is not per-phase CPU.

The distinguishing observation is main-loop idle during the awaited
discovery operations; fully active main-thread work throughout those spans
would instead produce near-zero idle. This establishes an async waiting
component for this fixture, while matched unchanged sweeps independently
verify zero decode/write work. The equal-scale unobserved useful sweeps
took 1714/1676 ms; unchanged sweeps took 609/1042 ms. This small alternating
series does not isolate observer overhead from time/order variation and
does not satisfy a profiler-overhead or live causal acceptance contract.
It still does not reproduce the dated long live sweeps or identify their
wait mechanism, per-phase CPU, or app impact. **P-008/R-8 remains open.**

Passing log `/tmp/p008-ingest-discovery-runtime-20261001-r2.log` SHA-256:
`055c41d3a750d6f98e021057d8080d8234e5a4f774b7b54933e6d1a88aea84e2`.
Failed expectation log `r1.log` SHA-256:
`052215d198b68b377cf580d8f2a9d1d9db049d0f980a4cc7f4d207e42c476a60`.
The dated live receipt `0mup9bfumiwatefin87` and historical task-retention
limits above remain separate evidence. D-006 still forbids a worker
shared-host restart. A :3271 MCP transport send failure during the later
lock acquisition was handled through sanctioned `ptool --url=:9071` under
the same session: the path was first read as unheld, then claimed and
released with native edit proof. No incidental DRAIN item was filed.

### Matched isolated CPU samples — October 1, 09:25Z

WI-10002830 extended the same canonical runtime test with two cases: the
existing discovery comparison and a CPU-sampling comparison. The latter
keeps real filesystem observation enabled throughout and alternates the
inspector profiler off/on/on/off. Both cases retain the identical synthetic
workload hash `6fda56724fe55c56706e4c99460603d83685d6e3debceca2f24a3210b6140ad4`.
This reuses Node's inspector and the maintained disposable background route;
it adds no serving-host observer or production configuration.

The sampler uses 10,000-microsecond intervals. Each sampled leaf is joined
to its real ancestor frames; the receipt retains every sampled stack's count,
preceding sample intervals, and a SHA-256 of the original profile. Assertions
require actual samples with ingestion-source ancestry, rather than merely
finding a function name in the profiler's node dictionary. Start/stop costs
are measured separately from the sweep's wall, loop and process-CPU counters.
The inspector disconnects before private database teardown.

The canonical command remains:

`PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/search/session-ingest-runtime.integration.test.ts`

Run `r1` passed **2/2, zero skipped, exit 0**. The router started at
`2026-10-01T09:24:21.190Z` on `b190bcc76b` with the local fixture edit; automatic
git-sync moved HEAD during the run. Both child receipts report
`532f72579866b96c503d963ed6dc7b73615313ff`, and post-run path provenance reports
that HEAD with the fixture clean. The ingestion source hash was asserted
unchanged before and after both child workloads:
`a63bb35bca2738b33f62084917b9c3fa3b522ca21d37946000ae8786449529a3`.
Fixture SHA-256:
`a43b41bccf88a35b14434dc57efe6829fbac3204c28ecc188c215420e2887dd2`.

Child PIDs 3663053 and 3682630 used Node v25.9.0 with background workers
enabled and DBOS routines disabled. Each read back 256 turns and 2,560 parts,
verified offsets, removed its private HOME/datadir, and verified its DB port
refused a connection. The sampling child produced these distinguishing rows:

| Sampled sweep | Wall ms | Decode ms | Writes ms | Samples | Samples with ingestion ancestry | Samples with parseCodexParts ancestry |
|---|---:|---:|---:|---:|---:|---:|
| Useful tail 2 | 1343 | 677.8 | 148.3 | 135 | 90 | 59 |
| Matched unchanged 2 | 466 | 0 | 0 | 48 | 22 | 0 |
| Useful tail 3 | 1441 | 739.7 | 180.6 | 143 | 89 | 71 |
| Matched unchanged 3 | 526 | 0 | 0 | 54 | 21 | 0 |

Useful sampled stacks locate active work in `parseCodexParts` below
`readNewLines`; unchanged stacks include synchronous `readFileSync` below
`codexTranscriptMeta` and `codexAdvSessionMetadata`. This distinguishes active
decoding from unchanged metadata work on this exact private fixture. It does
not distinguish JSON parsing, redaction, allocation and other operations
inlined into `parseCodexParts`, nor prove redundant metadata reads caused the
dated live slow sweeps.

Profiler starts took 83.94–115.86 ms and stops 6.90–7.81 ms. Equal-scale
unprofiled useful passes took 1665/1468 ms and unchanged passes 581/540 ms.
The four alternating observations expose startup cost and retain controls;
they do not establish a stable sampling-overhead percentage or an acceptable
overhead bound. Raw profile intervals include inspector startup frames, and
preceding-interval allocation is not exact per-function/per-phase CPU time.
Counts are sampling observations, not CPU utilization. Process CPU still
includes all child threads and excludes the separate PostgreSQL process.

Full stack summaries, profile hashes and both cleanup receipts are retained
in `/tmp/p008-ingest-cpu-runtime-20261001-r1.log`, SHA-256
`8612e1ff2bbbefcc7ea6acc54c58912b5f0c80fe7487ed0e5b0ed1193b62c6ef`.
The dated live phase receipt and historical attribution/retention limits stay
separate. **P-008/R-8 remains open: no live causal closure, acceptance binding,
performance improvement or shipment is claimed.** Next distinguish the
decoder's cleaning/redaction cost from its parsing work using a bounded
canonical regression before changing that correctness/security surface.

### Decoder redaction distinguishing regression — October 1

WI-10002830 traced the sampled `parseCodexParts` work to its existing
`cleanPartText`/`sensitive-text` seam. The key-directed regex optionally
consumed an arbitrary identifier prefix before trying a credential suffix.
On a non-secret identifier, that greedy prefix was retried from successive
characters. The pre-fix canonical regression separates JSON parsing, the
self-identifying token pass, and the key-directed pass on identical input
sizes, with an equal-length punctuation-delimited control.

The selected regression failed at HEAD `87e9f9ee9b` plus the local test:
the 32,768-character identifier's key-directed scan used **1,305.492 ms
process CPU**, against its 200 ms ceiling. At 8,192 characters it used
101.851 ms. For the 32,768-character input, JSON parsing used 0.020 ms,
the self-identifying pass 0.054 ms, and the punctuation-delimited
key-directed control 0.353 ms. The receipts measure `process.cpuUsage`
user plus system microseconds divided by 1,000, separately from wall time;
they are bounded process measurements, not per-function native CPU samples.
This distinguishes the key-directed retry path from parsing, the other
redaction pass and an equal-byte control.

The fix removes only that optional prefix from the existing shared matcher.
Credential suffixes still match inside prefixed names, while their prefixes
remain unchanged outside the match. Both redaction passes still precede
part capping. No new redactor, flag, observer or production configuration
was introduced. Tests cover empty, AWS, deployment and 32 KiB prefixes
for access-key IDs, secret-access keys and database URLs. The Codex parts
guard verifies a prefixed opaque value crossing the tool cap is scrubbed
before truncation. Its first fixture mistakenly placed the replacement
marker across the cap; moving the fixture prefix back and adding diagnostic
context corrected the assertion without changing product behavior.

Commands:

```bash
PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/sensitive-text.test.ts -t 'bounds key-directed scans'
PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/sensitive-text.test.ts packages/operator-core/lib/search/session-turn-parts.test.ts packages/operator-core/lib/search/session-ingest.test.ts
PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/search/session-ingest-runtime.integration.test.ts
```

Final unit run `r3`, started `2026-10-01T09:47:14.825Z`, passed **74/74,
zero skipped, exit 0** on HEAD `87e9f9ee9b` with local source/test edits.
Its 32 KiB key-directed identifier scan used 0.010 ms process CPU;
the same-size delimited control used 0.007 ms. These single observations
establish the regression's failure/pass distinction, not a stable speedup
percentage or a universal linear-time guarantee for arbitrary input.

The maintained private runtime run, started `2026-10-01T09:49:53.975Z`,
passed **2/2, zero skipped, exit 0** on the same HEAD plus the local redactor
edit. Its fixture and ingestion source were unchanged. Children 1281362
and 1299196 used Node v25.9.0 with background workers enabled. Each
read back 256 turns and 2,560 parts, verified offsets, removed its HOME
and datadir, and verified its DB port refused a connection. The workload
hash remained `6fda56724fe55c56706e4c99460603d83685d6e3debceca2f24a3210b6140ad4`.
All eight matched unchanged passes again recorded zero decoding/writes.
The sampled useful passes recorded decode wall intervals 26.2/38.3 ms,
versus the dated pre-fix 677.8/739.7 ms receipts above. These are separate
runs with awaited/scheduling effects; do not convert them to a production
performance improvement or an observer-overhead percentage.

Fingerprints:

| File | SHA-256 |
|---|---|
| `sensitive-text.ts` pre-fix at `87e9f9ee9b` | `45f8c9ff7b6c944f0fc2905261ab33ca21b0c2deea16af688bd90cb4c7d6eb88` |
| `sensitive-text.ts` fixed, unchanged before/after runtime | `16bd299e52efe4f4a83a6dcf9f3ff3ea84d957231af9f6deaa67870b559d7c89` |
| `sensitive-text.test.ts` | `f422ddf2480d27cf094b0aadbb91ae1bd8d1c54f2c88684b57ed32bf330369d5` |
| `session-turn-parts.test.ts` | `b3659f68f4c5367656ae5945ef08fd79825e8a8d215007ef388fb123c5ca0c07` |
| `session-ingest.test.ts` | `902be4ae79ac87e09ce418ac8a1c8b41e587515e849ac98d089a9bb73a663d94` |
| `session-ingest.ts` | `a63bb35bca2738b33f62084917b9c3fa3b522ca21d37946000ae8786449529a3` |
| runtime fixture | `a43b41bccf88a35b14434dc57efe6829fbac3204c28ecc188c215420e2887dd2` |

Logs: `/tmp/p008-redaction-scan-red-20261001.log`
SHA `84234801be181b40dfc0176ba923b3b1a618c684a72702bd876e74a5230868fd`;
final unit `/tmp/p008-redaction-scan-green-20261001-r3.log`
SHA `e1461c0b988513771d3e968242003e6627574effd9617e8bdf195c34078d16a2`;
private runtime `/tmp/p008-redaction-runtime-green-20261001.log`
SHA `31c702067bbb81d73d4746d76cbbb7042907303445069eafa917a703a68d1445`.
Scoped `git diff --check` passed.

The source defect and recurrence guard are verified. The retained live
slow-sweep cause, app impact and shared-runtime adoption remain separate
open questions under D-006. **P-008/R-8 remains open; no acceptance binding,
shared-host restart or shipment is claimed.**

### Matched metadata read controls — October 1, 10:44Z

WI-10002830 extended the maintained private-runtime fixture with real
synchronous filesystem call/byte counters. Every managed home now has a
38-byte synthetic diagnostics stamp and a 55-byte config. The incremental
workload remains 4,800 rollouts across 320 homes, 80 useful tails per pass,
and the existing four repeats. Its workload hash remains
`6fda56724fe55c56706e4c99460603d83685d6e3debceca2f24a3210b6140ad4`;
the added metadata fixture hash is
`d664293d6c33eceee43b15c3ff8807edb84f0a969e3885201d50ad8e1556e1e7`.

The distinguishing control calls `codexTranscriptMeta` followed by
`codexAdvSessionMetadata`, alternately omitting/passing the already resolved
native id. Its four profiler-off observations use duplicate/reuse/reuse/duplicate
order. The wrapper always invokes the original filesystem reader and records
successes, errors, bytes and wall spans; it supplies no cached values. All four
owner/native-id/model/effort output hashes are identical:
`e55b702411dac67a678e9f756ef8c1cd7caff011c4109f2e551b26e7eca315d4`.

| Mode, same 4,800 paths | Diagnostics calls | Diagnostics bytes | Config calls | Config bytes |
|---|---:|---:|---:|---:|
| Resolve identity twice | 9,600 | 364,800 | 4,800 | 264,000 |
| Pass the resolved identity | 4,800 | 182,400 | 4,800 | 264,000 |

The source cause is the second `codexTranscriptMeta` call inside
`codexAdvSessionMetadata` when no id override is supplied. The pre-fix
canonical runtime regression failed with actual 9,600 versus expected 4,800
diagnostics reads. The fix passes the existing `meta.sessionId` from both the
sweep and `ingestFileNow`; an explicit single-file override still wins. Config
continues to be read freshly. The unit regression rewrites model/effort between
metadata-only calls and checks the explicit identity and new settings.

Both useful and matched unchanged sweeps now assert 4,800 successful diagnostics
reads and 4,800 config reads, with exact byte totals and zero read errors.
Single-file metadata-only repairs, with and without an explicit id, assert one
read of each file and zero inserted turns. Each child retains 256 turns and
2,560 parts, verifies offsets, removes its private HOME/datadir, and verifies
the database port refuses connections. The existing profiler off/on/on/off
comparison remains, with filesystem counters held fixed.

Canonical verification:

```bash
PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/search/session-ingest-runtime.integration.test.ts packages/operator-core/lib/search/session-ingest-adv-metadata.test.ts packages/operator-core/lib/search/session-ingest-walker.test.ts packages/operator-core/lib/search/session-ingest-phases.test.ts packages/operator-core/lib/search/session-ingest.test.ts
```

Runs `r2` and `r3` each passed 58 tests in five files, zero skipped, exit 0.
`r2` started 10:40:09Z on `28db2e820b`; its children were 4179054 and 17582.
`r3` started 10:43:23Z on `3331de7812`. Automatic commits moved HEAD during
both matrices, so the router explicitly marks broader dependency provenance
**unknown**. The named files and ingestion source fingerprints stayed fixed;
this is scoped fixture evidence, not a settled-HEAD acceptance result. A bounded
git-sync resource-lock attempt was refused `held_exclusive`; no lock was taken
or bypassed. Do not repeat these unchanged matrices merely to recover receipts.

| Current file | SHA-256 |
|---|---|
| `session-ingest.ts` | `c7bb38ff15c421571116361362da12e8020b929c385894b424461297a7665af7` |
| runtime fixture | `df457c62ac8e9fc2999972eaba57aceffb3892c9376dc3cc66295afdecdf8ee7` |
| adv metadata test | `75554e5b06f9c45ef4178924407ac67e6cb771b951b7c0832967c65143e9dd06` |

Red receipt: `/tmp/p008-metadata-red-20261001-r1.log`, SHA
`e1080ab950bfa1b508d3d5b24ba892a3424387a1ce1755f7349078ebd6a4c712`.
Final matrices: `/tmp/p008-metadata-matrix-20261001-r2.log`, SHA
`f130592d89fb7058a0268d5c1c581f3578df11e79b5bfdb20ac6cc0da2a4e249`;
`/tmp/p008-metadata-matrix-20261001-r3.log`, SHA
`52ea8e02575b9ce576ad190f8a1f55a620dece106932fd02ba9611b4d377dbb4`.
Scoped diff validation passed.

The matched control proves a redundant-read mechanism and preserves metadata
output. Its short process-CPU/wall observations include the observer and other
child threads; they establish no stable overhead percentage or production
speedup. Config's repeated per-rollout reads and their freshness/selection
contract remain a separate possible optimization. The long shared-host sweep
cause, app impact, adoption and sustained profiler overhead remain unproved.
**P-008/R-8 stays open; no live acceptance binding or shipment is claimed.**

### Selected-home config reads — October 1, 11:13Z

WI-10002830 confirmed another redundant-read mechanism in the existing Codex
metadata sweep. `codexMetadataBackfill` retained only the first valid rollout
per managed home, but `codexAdvSessionMetadata` read config before checking
whether that row had already been selected. The canonical private-runtime
regression failed with 4,800 config calls versus the expected 320. Moving the
read behind the existing map's selection check removes discarded work. No
process cache, new flag, config key, service or metadata surface was added.

The maintained fixture now gives all 4,800 rollouts distinct native IDs and
explicit mtimes. It inserts 320 real private `adv_sessions` rows and checks
that the newest valid rollout in each home supplies the original native ID,
model and effort. These baseline assertions passed before the pre-fix read-count
failure and also in both post-fix children. The selected-row hash after the fix
is `8d449dacf45c2cd93b203b01df5b07f956ab9b8a9417c71a23f433cedf968295`.

| Same 4,800-candidate sweep | Config calls | Config bytes | Diagnostics calls |
|---|---:|---:|---:|
| Pre-fix regression | 4,800 | 264,000 | 4,800 |
| Selected-home reads | 320 | 17,600 | 4,800 |

Every useful and matched unchanged sweep in both children checks these exact
counts, successful reads and zero read errors. The real filesystem wrapper
continues to call the original reader. Further private sweeps check that a newer
malformed native ID does not occupy the home, a missing config permits native-ID
repair with one failed config read, a recreated config's model/effort are seen
on the next sweep, and explicit launch settings remain intact. Single-file
metadata-only repair still reads config freshly and inserts no duplicate turns.
Each child retains 256 turns and 2,560 parts, removes its private HOME/datadir,
and verifies the database port refuses connections.

Verification used the five-file command in **Matched metadata read controls**.
The 11:08Z run passed both private-runtime cases and 55 of 56 unit cases. The
sole unit failure was the phase fixture's old expected cost of two config reads
for two rollouts in one home (6 instead of 3 injected wall-time units). After
correcting that expectation, the exact phase file passed all three tests at
11:11Z, zero skipped, exit 0. This supplies passing evidence for 58 distinct
tests across those runs; the five-file invocation itself exited 1. The unchanged
integration cases were not rerun merely to reconstruct their evidence.

Both children used source `6934df03…`, Node `v25.9.0`, PIDs 2082455 and 2101864,
and HEAD `50b2351ce345c810db05b6b363928596781ce81f`. The router's start/end HEAD
stayed fixed, with local fixture edits. This verifies the named source and
fixture contract; it does not inventory or freeze the entire import graph.
Final scoped `lint:tsc` covered the source and both edited test files after the
last test edit: zero type errors, exit 0. Scoped diff validation passed.

| File | SHA-256 |
|---|---|
| `session-ingest.ts` | `6934df03e7d3da888bbf30fc63d1493f275bbf5a860edcd69ce965af6fb09871` |
| runtime fixture | `6b5e1b460479ff96fffb878bf04d1fd2ead0c68e685933dd4c24a155384d54ce` |
| phase test | `9e8db0391d189b5c404adf4d13ff6c977db7a78e321f18917b7d44a8309b563c` |

Receipts:

- `/tmp/p008-config-red-20261001-r1.log`: SHA
  `21847bf051d8b46acec85bdd03c3f12926a9d3c378f7b9a72c85b4231a623959`;
  selected case failed as intended, the other case was excluded.
- `/tmp/p008-config-matrix-20261001-r1.log`: SHA
  `49e67c653c10b8713743dc7a65a5c420a60d8aa34509c21183c7da2e6ac205e8`;
  both runtime cases and 55 unit cases passed, old phase-cost assertion failed.
- `/tmp/p008-config-phases-20261001-r2.log`: SHA
  `13e3cdabac209f54d8cf6bdcdc2696ac1e95add675fb824b827ac08ccaf8f5c1`;
  corrected phase file passed 3/3.
- `/tmp/p008-config-types-20261001-r1.log`: SHA
  `8d894dc2db15e6d56ad1ec73ad5f8d5c4efc322d90e66cbdd61e6bfc71220f54`;
  final scoped typecheck passed with zero diagnostics.

The root cause and recurrence guard are verified for discarded config reads.
The detector gap was that the earlier fixture checked per-rollout metadata but
did not exercise real backfill selection over distinct native IDs in one home;
the maintained private-PG fixture now checks that behavior and sweep freshness.
This is no measurement of production latency, long shared-host sweep cause,
shared adoption, or sustained profiler overhead. D-006 remains binding, and
**P-008/R-8 remains open**.

### Current frozen mixed-record replay — October 1, 11:34Z

WI-10002830 refreshed the frozen-tail measurement after the redaction,
metadata-identity reuse and selected-home config changes. The original ended
Codex rollout in managed `session-32189` still hashes to
`daf3b19c556879679f73cc71e49822eda166ac5756cfffb19586787ffd16f4a7`.
Its last 100 complete JSONL records remain 214,497 bytes, SHA-256
`aca19605813043b6c1ba7d82bd89344f50c90aee1bddf47bcd51aec0064eb37e`.
The temporary snapshot had mode 0600, stayed outside the repository, and was
removed after verification. No transcript text is included in this evidence.

The maintained canonical command was:

```sh
PAPERCUSP_TEST_RUN_HARNESS=papercusp TEST_INGEST_CORPUS_PATH=/tmp/p008-frozen-tail-fire68.jsonl npm run test:file -- packages/operator-core/lib/search/session-ingest-runtime.integration.test.ts
```

It passed **2/2 tests, zero skipped, exit 0**. Both children exercised the
existing `--isolated-runtime` route with a private migrated PostgreSQL database,
HOME and workspace, stripped live credentials, and background workers enabled.
PIDs were 3496815 and 3524061, Node `v25.9.0`; both recorded HEAD
`9800a28622a15e6d9b0e86ba582f2087b3947e9f`. Router start and end HEAD agreed;
the named test file was clean. Source and fixture hashes remained
`6934df03e7d3da888bbf30fc63d1493f275bbf5a860edcd69ce965af6fb09871`
and `6b5e1b460479ff96fffb878bf04d1fd2ead0c68e685933dd4c24a155384d54ce`.
This is named-source provenance, not a frozen inventory of the entire import
graph.

The current preflight derives 240 turns and 2,160 parts per useful sweep from
the frozen parser input. Four repeats over 80 changed tails among 4,800
candidates produce **960 turns and 8,640 parts per child**, verified by private
database readback. Workload descriptor SHA-256 is
`4608adf5589cf5b4c494d69b704a60b1c64401e6446fcc09a654f9501f396d58`.
Matched unchanged sweeps insert zero turns/parts. Every useful and matched
unchanged sweep reads config 320 times/17,600 bytes and diagnostics 4,800
times/182,400 bytes. The same fixture also verifies malformed-newer-ID
selection, missing config, next-sweep config freshness and explicit launch
settings. Both children verified removal of the private HOME/datadir and
connection refusal on their database ports, 34285 and 39395.

| Child / useful pass | CPU profiler | Sweep wall ms | Decode wall ms | Write wall ms | Process CPU user + system ms |
|---|---|---:|---:|---:|---:|
| 3496815 / 1 | off | 5,083 | 319.7 | 4,359.7 | 1,096.226 |
| 3496815 / 2 | off | 2,179 | 274.3 | 1,493.9 | 920.218 |
| 3496815 / 3 | off | 2,423 | 312.3 | 1,692.0 | 907.170 |
| 3496815 / 4 | off | 6,031 | 295.4 | 5,344.0 | 816.323 |
| 3524061 / 1 | off | 1,768 | 297.3 | 1,014.1 | 1,108.584 |
| 3524061 / 2 | on | 6,870 | 299.4 | 6,130.6 | 1,127.614 |
| 3524061 / 3 | on | 1,711 | 309.8 | 909.0 | 1,001.596 |
| 3524061 / 4 | off | 3,944 | 357.4 | 2,994.7 | 1,052.447 |

These phase spans include awaited operations; they are not phase CPU
measurements. Process CPU covers all child threads. Useful-pass sampling
startup cost was 84.681/97.936 ms, with 47/683 and 44/170 ingestion-source
samples. The large write-wall variation in both profiler modes does not
establish a sustained profiler-overhead ratio or its cause. This private
workload does not reproduce the dated long shared-host sweep, nor identify
its wait mechanism or application impact.

Receipts:

- `/tmp/p008-frozen-runtime-20261001-fire68.log`, SHA-256
  `cb278381b518d5ef0a0222fab51187955ffe9f96c76bab00265c18fa15f8b257`.
- `/tmp/p008-frozen-runtime-20261001-fire68-summary.json`, SHA-256
  `6658dafbc6dcd44824ae59597157b800b2c4af012ca850c34a240efcd5cc5900`;
  derived counts, phase costs, private identities and named dependency hashes.

This supersedes the 03:07Z proof's applicability to current ingestion source;
the dated receipt remains historical evidence. D-006 still forbids a worker
restart of the shared background host. R-8 revision 4 requires live/operational
causal closure or an evidenced non-defect disposition for each named lead.
**P-008/R-8 remains open; no acceptance binding or shipment is claimed.**

### Committed cancellation proof and natural ingestion window — October 1, 14:06Z

Fire 79 compared the four final cancellation source/test fingerprints in
the "Codex cancellation parity" section
with committed HEAD `8cfe6fd85b042b7f97c6f5a2cedaa495d1cfbf40`.
All four match. Gateway and stage-test blobs landed in
`d499db39862610c9c7f3748293612cc8bf83092a` at 13:43:52Z; OAuth adapter
and adapter-test blobs landed in
`49f6d06dcfa53e7c822abebacf342ffe358f9ff9` at 13:43:45Z.
The existing 351-test matrix, final 31-test stage run and scoped typecheck
remain the verification receipts; unchanged tests were not rerun.
The gateway peer received the exact refs in `muplnt57-0000-faf70cd5f92f424b90be3b5edaa58817`.
No further gateway source edits are planned during the requested quiet
window through 14:23:52Z.

The fresh path-scoped runtime read reports gateway owner build
`6563e1ea76`, `containsChange:false`, method `start-after-mtime`.
The serving-runtime writer compares process start with file mtime when the
canonical-tree host has no matching boot-commit blob; this result is not a
deployment verdict. The staging operator at `8cfe6fd85b` contains the
gateway path by blob comparison. The ingestion path's later read reports
bg-host build `8cfe6fd85b` containing that path by blob comparison, while
the staging operator's health is unknown in that later receipt. No shared
host was restarted. Gateway adoption was requested from the fleet leader;
the first required wake missed, and a subsequent wake queued. Neither
receipt proves pickup or completed adoption.

One bounded natural-ingestion journal query covered October 1
13:30:00–14:02:00 UTC, selected `session-ingest.*phases=`, and kept at most
12 collapsed rows. It returned 10 matches without truncation, journal error
or unknown-unit diagnostics. Numeric evidence was recovered from the
unshaped result rather than the nested, shortened inline view:

| Receipt UTC | Scanned | Total wall ms | Discovery ms | Decode ms | Writes ms |
|---|---:|---:|---:|---:|---:|
| 13:38:08.666 | 7306 | 115556 | 32031.6 | 25705.9 | 44513.9 |
| 13:38:34.539 | 7309 | 3472 | 1097.9 | 299.4 | 489.7 |
| 13:41:12.650 | 7319 | 36410 | 32322.2 | 757.2 | 958 |
| 13:43:23.383 | 7353 | 52589 | 24522.6 | 4452.9 | 11223.9 |
| 13:46:55.676 | 7364 | 136844 | 111637.7 | 1085.8 | 3541.6 |
| 13:50:54.457 | 7384 | 14445 | 3328.4 | 1313.4 | 7687.3 |
| 13:53:23.975 | 7405 | 42799 | 27852.9 | 2570.7 | 6091.7 |
| 13:55:20.252 | 7418 | 41381 | 14794.3 | 3262 | 17437.3 |
| 13:59:16.295 | 7430 | 165296 | 141881.6 | 6195.8 | 13612.3 |
| 14:01:43.979 | 7517 | 73473 | 12479.9 | 19982.9 | 35304.2 |

Each retained row reports zero errors. `runSessionIngestOnce` measures
discovery around `listCandidateFiles`, which awaits directory enumeration
and then serial file stats; these are exclusive wall buckets, including
scheduling and I/O waits. This does not identify which operation caused
the delay or establish CPU pressure, shared-pool pressure or app impact.
The log-read surface omits process/invocation identifiers. A separate
service-health read recognizes current `papercusp-bg-host.service`, and
marks the queried `papercup-bg-host.service` name unknown; the journal
reader's historical-name support means its successful old-name query
cannot by itself bind these rows to the current service incarnation.

A follow-up native journal read resolved that gap for the exact same ten
timestamps. The first five rows (through 13:46:55.676Z) carry PID `3236420`
and invocation `31884442bef849a180bfa2c133b6c0a5`. The last five carry
PID `4099092`, invocation `ceec6e03ddd841b28c50ddd48a6223f2` and unit
`papercusp-bg-host.service`. Targeted systemd reads resolve both old and
new unit names to that current PID/invocation, started at 13:48:20Z.
Thus service-health's old-name unknown is not evidence of an absent alias.
The exact journal task is `0mupm2dp9tzatt8127v`, exit 0; its distilled
identifiers partition all ten receipt timestamps into those two incarnations.

An already-published profile for current PID `4099092`,
`loop-saturation-1790863645955-pid4099092-p95_617ms.cpuprofile`, SHA-256
`81927da9db2054243330cfc048d9109d5ce8a3eba9d8380dfb47ec0c0edf3708`,
contains 134 samples over a 3.341397-second monotonic interval. Four
distinct `spawn` leaves contribute 24, 20, 14 and 11 self samples; their
ancestry passes through `streamGitFields` and
`completionBlobHistoryContains`/`completionHistoryLocation`, including
`residualPathsForCommit`. This is source-attribution evidence for that
profile, not an explanation of the earlier ten sweeps: its artifact time
is later than their window, and neither CPU samples nor wall buckets
alone establish the causal connection or user latency. The exact bundled
caller and same-window overlap still need a distinguishing measurement.

Portal and the two additional checkpoint-harvest observations
`EI-24784971427298446` / `EI-24784699543275632` remain in the leader's
routing lane. R-8 still requires causal operational evidence or an
evidenced non-defect disposition for each named lead. No acceptance
binding, final shipment or causal closure is claimed here.

### Published-profile window and neighboring ingestion receipts — October 1, 14:46Z

The cold continuation recovered the post-checkpoint native transcript
`01a0f7d4-fdf7-7e13-b4ec-26f3b1e99f2d`: the previous turn read the
completion-history source, but did not complete this journal correlation.
The current claim remains WI-10002830 / P-008. The refreshed lock-mode
receipt selects automatic verified hooks, generation `1790863925000`.

The previously inspected profile
`loop-saturation-1790863645955-pid4099092-p95_617ms.cpuprofile` is now
absent at its recorded path. Task `0mupn6p1k1aksn6q1ow` returned
`FileNotFoundError`, exit 1, before reading the journal. This does not
invalidate its saved SHA-256 and sample attribution, or establish why the
file disappeared. The profile writer retains a bounded number of files,
but no deletion receipt was obtained.

The completed bounded native journal task `0mupnaa0i1obhcsrk6z`, exit 0,
reads October 1 14:01–14:20 UTC and filters PID `4099092`, invocation
`ceec6e03ddd841b28c50ddd48a6223f2`. It binds the exact profile filename
to its capture log at **14:07:27.649930Z**, journal monotonic timestamp
`153326790047` microseconds. Separately journaled detail fields report
requested duration 3,000 ms, sampling interval 10,000 microseconds,
profiler start-call cost 0.151393 ms and stop-call cost 7.159455 ms.
These last two fields measure observer-call costs, not absolute sampling
timestamps: `LoopCpuRecorder.record` writes differences of
`performance.now()`. `captureCpuProfile` stamps the filename with
`Date.now()` after `Profiler.stop`, before writing the file. Subtracting
the requested duration from the filename cannot recover an exact start.

The same journal window contains these neighboring ingestion receipts:

| Receipt UTC | Scanned | Total wall ms | Discovery ms | Decode ms | Writes ms | Metadata backfill ms |
|---|---:|---:|---:|---:|---:|---:|
| 14:01:43.979112 | 7517 | 73473 | 12479.9 | 19982.9 | 35304.2 | 1033.1 |
| 14:12:49.441406 | 179 | 488749 | 33733.1 | 58132.6 | 107510.3 | 284423 |

Both report zero errors. Subtracting the latter rounded duration from its
journal receipt gives **14:04:40.692406Z**. The profile publication falls
inside that receipt-derived sweep envelope. This is a timing correlation,
not exact sampling-to-phase overlap: the journal timestamps are log
receipts, and the retained buckets do not carry per-operation start/end
times. The narrow 14:04–14:11 UTC query, task
`0mupn8zr9bibgik1ob7`, exit 0, contains the capture and completion-
settlement markers but no completed ingestion phase receipt. It cannot
establish that ingestion was inactive. An intermediate reducer failed on
a null journal `MESSAGE` (task `0mupn8844esw7bo1voc`, exit 1); the final
reducer handles null messages and returns only identifiers and numeric
fields, without raw forensic output.

Source inspection resolves the sampled ancestry:
`residualPathsForCommit` calls `completionBlobHistoryContains` for a
mismatched path; that resolves each endpoint with
`completionHistoryLocation`, then performs a bounded Git history read
through `streamGitFields`. The shared helper uses `child_process.spawn`
and asynchronous stdout/close handlers. Its sampled `spawn` leaves do
not establish a synchronous Git execution or prove that process launch
caused this ingestion delay. Separately, ingestion's metadata-backfill
bucket awaits `backfillSessionOwners` and, for Codex,
`backfillCodexAdvSessions`; its 284,423 ms is wall time across those
operations, including scheduling and database waits. A distinguishing
measurement still needs the exact operation, wait/CPU mechanism and app
impact. No shared-host restart, new source fix, unchanged test rerun,
acceptance binding or shipment occurred in this continuation. P-008 / R-8
remain open.

### Gateway cancellation loaded-build receipt — October 1, 15:04Z

The existing gateway runtime owner, su-839dcda5 / WI-10004644, supplied
`coord-send-b626b8412ed5cbd248892b69ed959df68399926d5744954dba5521b4aec9eb85`.
That 14:59:08Z receipt reports the gateway restarted at 14:29Z, loaded
build `a6ab88c04e`, and health process-start stamp `1790864960064`.
The owner reports no further gateway restart planned. The fleet leader
separately confirmed this existing adoption route. No P-008 restart was
performed.

This continuation compared `git show` bytes at that reported loaded build
with verified commit `8cfe6fd85b042b7f97c6f5a2cedaa495d1cfbf40`.
All four SHA-256 fingerprints match the final source verification above:
gateway `a6bcb149`, stage test `e119c153`, OAuth adapter `f4275b9b`,
and OAuth adapter test `b055eca0`. The loaded build thus contains the
exact verified cancellation sources, with the two tests as provenance;
this does not assert that the test files execute inside the gateway.
The process binding comes from the runtime owner's dated health receipt,
not a fresh product-request trace. Existing 351-test and final 31-test
receipts were retained without rerunning unchanged tests.

The previously unknown gateway cancellation-source adoption is now
established for that recorded incarnation. Historical downstream-close
trigger, account proxy configuration, app impact, and R-8 acceptance
remain open. This is not a final-shipment claim.

### Archived owner-backfill SQL attribution — October 1, 15:14Z

The bounded PostgreSQL stderr reducer, task `0mupo95ttkn7xqzu852`,
exit 0, read only `/var/log/postgresql/postgresql-18-main.log` for
14:04–14:14 UTC. It classified 317 timestamped records in that file and
returned one owner-backfill UPDATE duration record, with no omitted
matches: **14:12:49.381Z**, backend PID **1030409**, application name
**`pcusp:org-admin:p4099092`**, duration **284,354.979 ms**.
The unreturned full record's SHA-256 is
`541d2daf238e5cb1322e35888d3726e38a2b9d6c1f10cf7c10237c62383728a8`.
`pgAppName` in `libs/papercusp/libs/db/src/connection.ts` writes
`pcusp:<pool-label>:p<process.pid>`, so the application name binds this
statement to the same bg-host PID as the ingestion receipt above.

The exact-backend follow-up, task `0mupod94xkrz7qw17e2`, exit 0,
retained two records in the same file/window: that completed UPDATE and
its parameter-detail record. The third parameter is **`claude`**.
Thus the slow statement is `backfillSessionOwners` for Claude, rather
than the Codex `adv_sessions` metadata UPDATE. The first two parameter
values each retain 1,027 characters without a complete closing array;
their exact array cardinalities were not recovered. Parameters and SQL
text were processed inside the reducer and not returned. The parameter
record SHA-256 is
`fe1d288af14506631281975a637aca5b4c10eeb1c9253ec3ed642034af035d9d`.

This directly locates almost all of the reported 284,423 ms backfill
bucket in one PostgreSQL statement. It does not decompose that statement
into execution, lock or I/O time. No target-backend lock/cancellation
record was retained in this one-file window; that is not proof of no
wait. A current settings read shows `log_lock_waits=off` and a 7,000 ms
slow-statement floor, but no historical settings receipt was obtained.
The current `session_turns` catalogue includes its composite primary
index `(workspace_id, source_kind, session_id, turn_idx)` and a
`session_id` index. Index existence does not establish the historical
plan or its efficiency. The process-local completed-query ring retains
32 results and cannot recover evicted historical query/wait linkage.

Next, distinguish the bulk UPDATE's access plan and wait mechanism using
the existing query/runtime route. The matched PostgreSQL and ingestion
receipts narrow the investigation; historical app impact, R-8 acceptance
and final shipment remain open. No production SQL mutation or shared
restart was performed.

### Current owner-backfill access and wait evidence — October 1, 16:00Z

The current relation read returned the composite
`session_turns_pkey(workspace_id, source_kind, session_id, turn_idx)`.
EXPLAIN-only SELECT mirrors of the guarded owner UPDATE, using 1, 16 and
179 currently indexed Claude session IDs, all selected a Nested Loop,
Function Scan and `session_turns_pkey` Index Scan. Their index conditions
include workspace, source kind and the resolved session ID; owner
inequality remains a heap filter. These are current SELECT access plans,
not the executed UPDATE plan or recovered historical parameters. The
same current catalogue reports no non-internal row triggers. No missing
index or trigger-induced delay is established by these reads.

A separate natural recurrence was observed on backend **2451198**,
application **`pcusp:org-admin:p1649158`**, query ID
**`-9170796359460262385`**, query start
**2026-10-01 15:47:59.513131 UTC**. The statement fingerprint checks
confirmed the UNNEST join and workspace/source/session/owner guards.
Two active snapshots showed **IO / DataFileRead**, with no blocking
PIDs; another active snapshot had a null wait event. This directly
observes data-file waiting at those instants, not a continuous wait
classification, backend CPU consumption, or the earlier query's cause.

The completed PostgreSQL log record is **15:55:40.233 UTC**,
duration **460,720.337 ms**, SHA-256
`90447858bbe79de268e639d1080dea4a97f2cc1806ca27ca2507513e82c6f193`.
Its paired parameter record identifies **Claude**, SHA-256
`335a4541f3d6cf3dcc0c4df367f01c584960427597dc87cf3771050393ebac40`.
Task `0muppzaku195iei01nu`, exit 0, normalized the log's EDT timestamps
to UTC and retained both matches without omission or parse errors.
The first two reducers returned no selected-window matches because
their timestamp handling was wrong; those results do not establish
record absence. Parameter values were not returned.

The fixed-window journal reducer, task `0mupq0tdj1kffa81cpd`, exit 0,
retained one corresponding ingestion receipt at timestamp
`1790870227025482`, PID **1649158**, invocation
**`a90f90e3e3c5413380b9d59d0905dbd8`**, unit
`papercusp-bg-host.service`. Its metadataBackfill wall bucket is
**464,505.2 ms**, while its discovery/decode/writes buckets are
56,729.8 / 23,065.4 / 77,367.4 ms. Receipt SHA-256:
`23a80cd88fc760e0b0c64809e5c0dd513b8cd6b3ad04a7f2edd76f8f37b729d9`.
It has no per-operation `metadataBackfills` field.

The three-second `/proc` assay, task `0muppubgp1abmty84ml`, is deliberately
**not** used as per-query CPU/I/O evidence: it started at 15:55:40.009496
UTC and straddled the measured query completion. Its after-query
identity read did not match the original statement. Process-incarnation
continuity alone does not make that whole interval attributable.

Thus a current slow Claude owner repair and momentary data-file waits
are directly observed. The executed UPDATE access path, sustained
wait mechanism, historical attribution and app impact remain open.
No shared mutation, host restart, unchanged test rerun, source fix,
acceptance binding or final-shipment claim was made.

### Private executed owner-UPDATE control — October 1, 16:30Z

Extended the existing `session-ingest-runtime.integration.test.ts` route;
no production query, index or repair cadence was changed. The private
postgres.js debug callback captures the actual production owner UPDATE
and its bound parameters in memory. The fixture adds 179 synthetic
Claude transcripts in the adapter's managed-home layout, ingests them,
damages all 179 stored owners, then repairs them with no new file bytes.
That sweep reports zero ingested files/turns/parts and 179 owner updates.

The captured statement is replayed with `EXPLAIN (ANALYZE, BUFFERS,
FORMAT JSON)` inside a private rollback transaction, first repairing
179 owners and then updating zero already-correct owners. Both plans
are real ModifyTable/Update plans with a Hash Join, Function Scan and
`session_turns_pkey` Index Scan. Root Actual Rows is zero for UPDATE
without RETURNING; the fixture checks private state and the join output
instead. The two final child runs measured repair/no-op execution of
7.154/0.552 ms and 11.434/0.669 ms. Root shared-read blocks were zero
in all four replays. The no-op still visited 179 indexed rows. Rollback
preserved the exact before/after owner and xmin rows.

Canonical command: `PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file
-- packages/operator-core/lib/search/session-ingest-runtime.integration.test.ts`.
Final result: **2 passed, 0 skipped, exit 0**, log
`/tmp/p008-owner-update-private-full-20261001.log`, SHA-256
`0077a938ee88216231b712a9365a82f0a9f4f3634b75fa344fa5ea112b23e7af`.
Both children verify home/datadir removal and refused database ports.
Source SHA-256:
`81276d349520ea93952d19232ede4a677c75a23783984d3b12215177f4395789`;
fixture SHA-256:
`abf3109f41160a6b560a7666a023da2dddefec9c8c9364c3e2849f685b5232d7`.
Captured SQL SHA-256:
`c33700f42ffa35ce2682fc96000aa49d0d8824cd23d605e682d77c585282df42`.
Recorded child HEAD was `1219248f0a67a79795d4bd7572034f650986c022`;
the fixture change was local during verification.

This proves current-build no-new-tail owner repair and private executed
UPDATE behavior. The small private relation and its cache state do not
reproduce the live 460,720 ms statement, establish its access plan or
sustained wait mechanism, or prove historical app impact. R-8 and P-008
remain open. Avi's system-wide pause arrived during final verification;
the worker finished that atomic test and saved state before pausing.

### Current plan-only owner-UPDATE controls — October 1, 17:22Z

Recovered the later resume checkpoint before continuing: Avi's explicit
16:46:56Z resume superseded the earlier pause. WI-10002830 remained assigned
to this worker; the source and private-fixture fingerprints above were
unchanged, so their existing two-test receipt was retained without a rerun.

The current `dev:pg_query` contract accepts EXPLAIN over SELECT only.
`dev:pg_mutate` dry-run actually executes DML before rollback, so it cannot
provide a plan-only control. This read instead reused the existing
`createDedicatedOrgPg` native client through `code:run` / `capability:bash`.
The native-SQL route explicitly requires server-side timeout verification.
Task **0mupsli9p1owfl23rpa**, exit 0, extracted the production UPDATE from
`backfillSessionOwners`; its SQL SHA-256 exactly matches the private captured
statement `c33700f4…` above. It used EXPLAIN FORMAT JSON without ANALYZE.
Backend **3564381**, database `papercusp`, reported PostgreSQL **180004**,
transaction read-only **on**, statement timeout **5s**, lock timeout **1s**,
and plan-cache mode **auto**. The dedicated client was closed before exit.

The parameter-bound controls selected current non-null stored Claude owners,
ordered by session ID and owner, then deduplicated by session ID. These are
constructed current inputs, not recovered parameters from the slow statement.
All four plans contain ModifyTable/Update, Nested Loop, Function Scan and
`session_turns_pkey` Index Scan:

| Current planning control | Function Scan estimated rows | Join estimated rows | Driver await time |
|---|---:|---:|---:|
| Bound arrays, 1 session | 1 | 10 | 67 ms |
| Bound arrays, 16 sessions | 16 | 164 | 1 ms |
| Bound arrays, 179 sessions | 179 | 1,839 | 2 ms |
| GENERIC_PLAN TRUE, unknown parameters | 10 | 77 | 1 ms |

These are planner estimates and command round trips, not UPDATE execution
measurements. The full sanitized receipt is
`/tmp/p008-owner-update-live-planonly-20261001.json`, SHA-256
`956071317fcb7a50d01902ca1bf25f1e8770f129b8e14abfcb85459cf9b66aab`.
It preserves input/plan hashes and node metadata without transcript contents
or parameter values. The whole native read reported 168 ms.

A separate bounded `dev:pg_query` density read repeated that current selection
and counted its matching rows: **179 sessions / 4,099 turns**, minimum **1**,
median **13**, maximum **156** turns per session, and **0** owners differing
from the constructed stored-owner map. The read reported **128 ms**. It is
an ordered sample, not the Claude population or the historical sweep. The
zero difference follows this stored-owner control; it does not validate the
adapter's owner map. It exposes one fixture limitation: the private executed
control above has one stored turn per synthetic Claude session.

The bounded natural-query assay, task **0mupsr9gu1s6wplbw9d**, exit 0,
observed no matching active owner UPDATE in its 17:17:20–17:17:25Z read.
Its separate backend **4082668** verified the same read-only/5s/1s preflight.
No process CPU/I/O interval was taken, so there is no new per-query mechanism
evidence. Receipt `/tmp/p008-owner-update-natural-assay-20261001.json`,
SHA-256 `6173f37013f188bf61975ab4c5b2d83913bc351b83f9b11bf4feb4d844ddc4da`.
This bounded miss does not establish that ingestion or owner repair stopped.

The current UPDATE planning controls narrow the earlier SELECT-only access
evidence; they do not recover the executed slow UPDATE plan, sustained waits,
historical cause or app impact. No shared mutation, runtime restart, index,
repair-cadence change, acceptance binding or shipment was performed. Next,
extend the existing private control's turn-density fidelity while preserving
EOF repair and exact source capture; keep live operational attribution open.

### Private owner-UPDATE turn-density control — October 1, 17:35Z

Extended the same canonical runtime integration fixture with a synthetic
179-session / 4,099-turn distribution matching the ordered live sample's
minimum 1, median 13 and maximum 156. It matches those aggregate observations,
not the original session distribution, heap layout or cache state. The
production ingestion source and UPDATE statement remained unchanged.

The first two-child run failed `4007 !== 4099`: the fixture incorrectly
expected one sweep to consume the full corpus. Source
`MAX_TURNS_PER_TICK=4000` and the per-file budget decrement explain that
partial sweep. The fixture now verifies a positive continuation completes
the remaining turns, rather than changing the production budget or reducing
the final expected population. Both final children ingested **4,007 + 92**
turns, then repaired **all 4,099 owners at EOF** with no new file bytes.
The captured parameter arrays still contain **179** sessions and owners;
affected rows and rollback snapshots are counted by turn, with deterministic
`session_id, turn_idx` ordering.

The canonical runtime integration passed **2/2, zero skips, exit 0** on
child HEAD `7575534bcf0076b625f59db41fc8a344e3baaf3e` plus the local fixture
edit. Child PIDs were **2107259 / 2150508**, Node **v25.9.0**. Each checks
the exact source fingerprint, real source SQL capture, repair/no-op replay,
owner/xmin rollback preservation and home/datadir/port teardown. Both
homes were also absent in the final receipt read. This is source/fixture
provenance, not an immutable whole-import-graph claim.

Private executed repair/no-op times were **251.246 / 10.261 ms** and
**1,505.021 / 7.863 ms**. Each replay used ModifyTable/Update, Hash Join,
Function Scan and `session_turns_pkey` Index Scan; its index scan visited
4,099 rows even for the no-op. Root shared-read blocks remained **zero**.
These measurements do not explain the variation between private runs or
reproduce the live 460,720 ms UPDATE. No resource-pressure cause is inferred.

Command remains the canonical `PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run
test:file -- packages/operator-core/lib/search/session-ingest-runtime.integration.test.ts`.
Final log `/tmp/p008-owner-update-density-20261001-r2.log`, SHA-256
`8bf2bd9c4ff2ef3f1c8d871a6899f45bb90dca88f052c2b856c865d55065eae8`;
reduced receipts `/tmp/p008-owner-update-density-summary-20261001.json`,
SHA-256 `0173dad9598281b5f18480dad919575001e6788d56a06628608e8075fe2a79cd`.
Fixture SHA-256 is
`9f477fd79049d95749d27d868e8f84166236ae718629ae857b3d2c76fbe4729b`;
source remains `81276d34…`, captured SQL remains `c33700f4…`.
Scoped diff checking passed. The larger fixture strengthens current private
repair coverage; executed live-plan attribution, sustained wait mechanism,
historical app impact, R-8 acceptance and shipment remain open.

### Natural owner-UPDATE completion and exact input count — October 1, 18:40Z

Recovered the fire-99 work after the stale 17:40Z carry. Its saved
[same-query receipt](p008-owner-update-same-query-2026-10-01-fire99.json)
checks backend **3565425**, query start **17:48:12.265015Z**, hash
`30af7b390b49a1d85cdb105be9582eb2` before and after the
18:06:46.461–18:06:49.462Z process interval. The interval recorded
**180 ms CPU**, **21,954,560 read bytes**, **24,576 written bytes** and
zero major faults; both PG endpoints report DataFileRead and no blockers.
Task `0mupuixby128r2up8co` exited 0. The initial unprivileged read
failed before collecting counters; the authorized read-only retry succeeded.

The bounded completion reducer, task `0mupvijir1678503b4d`, exit 0,
assembled multiline PG log records and normalized SQL whitespace. It
verified the UPDATE/UNNEST and all workspace/source/session/owner guards.
The statement completed **18:06:55.893Z** in **1,123,628.046 ms**.
Full statement-record SHA-256 is
`55b90249e5549c87323aea49a897fe61748fa457f6a123df8a31319b369315bf`;
the paired parameter record is `de2f1f2ff7f963d61f6601a15031d9132e97448c01981eb0ebef76b0f856cd23`.
It names Claude. Both array values stop at 1,027 characters without a
closing array; their complete values remain unrecovered. The earlier
line-only reducer's false guard flags were formatting artifacts, not
evidence of another query.

The fixed 18:06:50–18:21:00Z journal reducer, task
`0mupvnhf91aigkttkil`, exit 0, retained one ingestion receipt from
PID **3240705**, invocation **916091e2a71d4170bf73a5bad0e4e6c3**,
at timestamp `1790878462064784`. The DB application-name writer binds
`pcusp:org-admin:p3240705` to that process. Its Claude sessionOwners
operation requested **2,985 sessions**, updated **3,873 turns**, began
at `1790876892252` and lasted **1,123,667.8 ms**. The current
`measureMetadataBackfill` writer defines requested as map size and
updated as the returned UPDATE count; these are different populations.
The aggregate metadataBackfill wall bucket is **1,126,606.3 ms**.
The whole sweep reports 340 inserted turns, 3,118 parts, 8,221 scanned
files and 1,615,397 ms. Receipt SHA-256 is
`07f7979eb51279af9a5523114ac6f6b2232c68e2628d304e72f0508027aa1515`.

The [completion receipt](p008-owner-update-completion-2026-10-01-fire100.json)
preserves sanitized records and exact task references. A current catalogue
read reports only pg_stat_statements among plan/stat extensions, a
7,000 ms slow-log floor and 1,024-character parameter logging limit;
it does not recover historical settings or an executed plan. Live
metadataBackfills fields are now observed, without an immutable loaded-source
claim. Source `81276d34…` and fixture `9f477fd7…` remain unchanged, so
the saved private two-test pass was retained.

This binds a long natural UPDATE, its input count and one valid I/O interval.
The complete input map, matching-turn distribution, executed access plan,
whole-query wait decomposition and app impact remain unresolved. The private
179-session control does not reproduce the observed 2,985-session input scope.
P-008/R-8 and shipment remain open. Next use a bounded current plan-only
control at the newly observed cardinality, preserving D-006's runtime route.

### Observed-cardinality plan-only control — October 1, 18:51Z

Task `0mupw1hkv1btozjgydd`, exit 0, reused the source UPDATE with a
constructed current stored-owner map of **2,985 distinct Claude sessions**.
The dedicated client verified read-only on, statement timeout 5s and lock
timeout 1s, then closed. The exact source/SQL hashes remain
`81276d34…` / `c33700f4…`. Both current-bound and generic EXPLAIN-only
plans contain ModifyTable/Update, Nested Loop, Function Scan and the
composite primary Index Scan. Bound Function/Join estimates are
**2,985 / 29,677**; generic estimates are **10 / 76**. Planning round trips
were 8 / 2 ms; the full native receipt spans 168 ms. These are estimates
and planning reads, not UPDATE execution measurements.

The first input selection, task `0mupvwwn044bxoj3rkp`, exited 1 with
server timeout 57014 before producing a plan. Both attempts used the same
5s/1s server bounds; the deadline was not widened. EXPLAIN-only selector
controls show Incremental Sort for `ORDER BY session_id, owner` and no
sort for primary-key order `session_id, turn_idx`. The successful attempt
uses the latter. Changed time/cache state prevents attributing the first
timeout to the sort. Both receipts are preserved in
[p008-owner-update-planonly-2985-2026-10-01-fire100.json](p008-owner-update-planonly-2985-2026-10-01-fire100.json).

This extends the current planning control to the observed input cardinality.
It does not recover the original values, matching-turn distribution or
executed live access plan. Existing private tests remain dated and passing;
P-008/R-8 and whole-query/app-impact attribution remain open.

### Current constructed owner-map density — October 1, 19:10Z

Task `0mupwst3q1u0w835ck3`, exit 0, executed a bounded read through the
existing `createDedicatedOrgPg` seam. The repeatable-read transaction
verified read-only on, statement timeout 5s and lock timeout 1s; its
owned client closed. Source SHA-256 remains `81276d34…`.

A freshly constructed PK-ordered map of **2,985 distinct Claude sessions**
matched **71,345 turns**. The per-session distribution was minimum **1**,
median **17**, p90 **54** and maximum **406**. The snapshot had **zero
owner mismatches**, **zero null owners** and **zero unmatched sessions**
for that constructed map. Selection took 57 ms, the aggregate density
query 87 ms, and the native receipt spans 181 ms. The aggregate explicitly
counts joined turn indices and applies `owner IS DISTINCT FROM` the
constructed owner; sessions and turns are separate populations.

The [canonical receipt](p008-current-owner-density-2026-10-01-fire102.json)
preserves the executed script, source/selection/density/input hashes,
identity, results and cleanup. Its durable task log SHA-256 is
`2e150fd849cfe93f9a745a3540a96b656e2fa729fad5454d548e538d17bee2aa`.
The direct MCP dry-run was shed before launch with
`loop_pressure_critical`; the sanctioned same-session `ptool` route
previewed and launched this one task. No duplicate task was launched.

This current stored-owner map is ordered by session ID and differs from
the unrecovered natural input values. Zero mismatches are scoped to this
snapshot, and the 87 ms SELECT does not establish the earlier UPDATE's
execution cost, cache state or whole-query mechanism. It also does not
recover its executed plan. The private 179-session/4,099-turn control is
smaller than this current read; its saved pass remains dated. Existing
production source/fixture fingerprints are unchanged, so no unchanged
test matrix was repeated. P-008/R-8, app impact, adoption and shipment
remain open.

### Exact owner-input fingerprint guard — October 1, 20:39Z

The adapter inspection confirmed that `ownerBackfill` collects path-derived
metadata before the unchanged-byte short circuit, in newest-file order. The
actual sweep can stop at its file/turn budgets, and duplicate session IDs use
the existing Map's overwrite behavior. A map constructed from stored first-turn
owners is therefore a different population from the adapter's actual input.

The existing `metadataBackfills` receipt now adds `inputSha256` for owner repair:
SHA-256 of `JSON.stringify([sessionIds, owners])` in the exact UNNEST parameter
order. The repair computes it from the same arrays passed to postgres.js, before
executing the query, so a failed repair retains its input fingerprint too. The
existing completion logger carries that field without raw session or owner IDs.
This extends the existing receipt; it adds no scanner, cache, table, timer,
service or SQL round trip. A fingerprint cannot reconstruct the input values,
and different fingerprints can reflect only changed traversal order.

The canonical phase regression was red with **3 failures / 2 passes**, exit 1,
because the old source omitted the fingerprint. After the source change, the
five-file focused command passed **28 tests, zero skips, exit 0**. It compares
the receipt with captured bound inputs, distinguishes different owners at equal
cardinality, retains an unchanged fingerprint across failure/retry, checks one
owner UPDATE and asserts that raw IDs stay out of the log.

The maintained private background integration passed **2/2, zero skips, exit 0**
at 20:38Z. Both children compare Codex and Claude receipt hashes with actual
driver-bound arrays, preserve the hash across a Codex EOF owner repair, repair
4,099 Claude turn owners from 179 sessions at EOF, retain rollback proof and
verify private HOME/datadir removal and database-port closure. Their loaded
source SHA-256 is `958f9bdc47721b971bf2f0d0494828ba40bee453ac20cf5f93cf2bb7771539e9`;
child HEAD is `8a33b9bffc263a1b7185104448942cbe60bad350` plus the local edits.
The source UPDATE SQL remains `c33700f4…`. Scoped `lint:tsc` for the source and
both tests reported zero type errors, exit 0; scoped diff checking passed.

The [canonical fingerprint evidence](p008-owner-input-fingerprint-2026-10-01-fire105.json)
retains commands, exit codes, exact source/test/log hashes, native provenance,
selected private receipts and limitations. Evidence-file SHA-256 is
`43e06c5f86bed59b211c4657b241532cc8d7932b4765ace15e6a3d670cbc7f21`.
This is a detector improvement and current private-source proof. It does not
recover the original natural input arrays, certify shared bg-host adoption,
explain the slow UPDATE's whole-query wait mechanism or establish app impact.
The earlier frozen mixed-record replay remains dated evidence for its older
source. **WI-10002830/P-008/R-8 and shipment remain open.**

### Current adapter discovery owner population — October 1, 20:43Z

Task `0muq03wyl11u2f1k1v0` reused the actual exported Claude adapter and
`jsonlAtDepth` walker, then applied the source's 45-day/nonempty-file filter,
newest-mtime ordering and Map overwrite behavior. It read metadata from paths;
it did not read transcript payloads or launch ingestion. Source SHA-256 was
`958f9bdc…` before and after the read. The dedicated PostgreSQL transaction
verified repeatable-read, read-only on, statement timeout 5s and lock timeout
1s; its client closed, task exit 0.

The complete current discovery set contains **5,187 candidate files**:
**332 unowned files**, **1,691 duplicate session-ID occurrences**, and a final
map of **3,164 distinct sessions / 240 distinct owner strings**. Discovery
took 868 ms. The current state read found **494 candidates with pending bytes**,
including **449 without a saved state row**. Therefore this complete discovery
map is **not** an observed natural sweep input: the source's file/turn budgets,
actual insert counts and errors can select a shorter prefix.

The map's ordered input fingerprint is
`1455ca2aec361df717a98188e65320f1ec518ca0db6ade08454c91e527375726`.
Its read-only density query matched **82,423 turns**, with minimum **0**,
median **25**, p90 **46**, maximum **434**, **8,201 owner differences**, zero
null turn owners and **13 sessions without indexed turns**. These are values
at this DB snapshot relative to this path-derived map, not confirmed wrong-owner
defects or changes to the original natural UPDATE population. The query took
3,042 ms; the complete diagnostic receipt spans 4,152 ms. No UPDATE timing,
execution plan, whole-query wait mechanism or app impact is inferred.

The [current adapter evidence](p008-current-adapter-owner-read-2026-10-01-fire105.json)
retains the exact script, source/discovery/input/SQL/log hashes, task identity,
bounds, cleanup and limitations. The filesystem walk is not an atomic snapshot;
active writers/deletions can race it. This replaces neither the historical
2,985-session natural input nor the earlier 2,985-session database-constructed
sample. Shared bg-host adoption remains on D-006's runtime-owner route;
**P-008/R-8 and shipment remain open.**

### R-8 revision-4 remaining evidence census — October 1, 11:41Z

This census follows the six lead groups named in live BAR `R-8`, hash
`8b105b4e0b7f664e97ebe433bb15543131b061365f3a004ab97cc6dbf13e83c7`.
It records the remaining acceptance work; it is not a terminal disposition.
Existing dated evidence below is retained without rerunning unchanged tests.

| Named lead | Verified evidence retained | Still needed for live/operational disposition |
|---|---|---|
| Gateway/proxy failures | Local-shed HTTP regressions distinguish zero upstream attempts from an upstream 429; saved three-file matrix passed 268 tests. The selected paired-reset guard shows that one socket error produces both log categories. | Correlate the named operational failures with request/cancellation IDs and loaded gateway/proxy source. Category counts alone do not establish independent failures or explain app latency. |
| Portal watchdog timeouts | The failed systemd-notify barrier is a measured precursor in EI-24354725412855158; a nonblocking-watchdog mitigation is not a confirmed root-cause fix. | Re-establish the legitimate Portal driver and its provider/runtime/notifier evidence. The 11:41Z authoritative item read is open with no assignee; earlier leader-held receipts are dated. Portal remains outside this worker's execution route. |
| Repeated background work / ingestion | WI-10002822 is done with the one-shot boot-gate cause and maintained retry fix; its saved recovery receipt remains dated. Ingestion source guards and the current frozen private replay verify redaction, metadata/config selection, incremental writes and cleanup. | The long shared ingestion sweep still lacks a distinguishing live wait/CPU mechanism and app-impact trace. Private replay did not reproduce it. Shared adoption requires the D-006 coordinated runtime-owner route. Embedding fallback and scheduler warning guards do not establish historical latency causes. |
| Migration rendezvous waits | Existing backup watchdog tests distinguish growing, stalled and ceiling-limited producers using scaled deadlines. Private-PG migration tests distinguish attempted from inserted reservations while preserving a peer reservation and backup guards. | Retain exact original backup-producer progress and rendezvous correlation, verify any live extension past the production 2,700-second stall floor, and establish relevant loaded-source adoption. A held backup lock alone is not a wedge. |
| Historical account polling | The exact frozen 1,488-call population lacks a triggering-frame field. Maintained IPC and private-PG tests reproduce unrelated account refreshes and no-op write amplification, and verify their source fixes. | Historical producer mix and its app-latency contribution remain unknown; consumer identity is not emitter attribution. Current PUI and producer adoption require operational evidence. |
| Expensive diagnostic scans | The native DO launch, full query and shell timeout are archived. Private psql tests distinguish frontend termination from continued backend execution; caller-deadline guards verify rollback of expired continuation. | The original task-to-backend-PID linkage, server bounds and app impact remain unproved. A current ledger miss plus retention policy cannot distinguish deletion from absent registration; active/null-wait labels do not prove CPU consumption or launcher identity. |

The 11:30Z current-build route read reported shared bg-host build
`50b2351ce3` with `containsChange:false` for the ingestion path, using the
`start-after-mtime` method. That receipt is scoped to that path and time;
it does not certify the adoption of other components. The worker sent the
fleet leader one request to route coordinated shared-host adoption and a
bounded operational trace, establish Portal's driver, and handle newly
harvested observation EI-24775735048259377. No shared-host restart, Portal
edit, live-gate operation or parallel monitor was performed.

The remaining claims require those specific operational inputs or a
distinguishing measurement, not another unchanged private-fixture run.
**WI-10002830 and R-8 remain open.**

### Gateway/proxy operational marker discrimination — October 1, 12:14Z

The maintained `RESTART_TARGET_UNITS` map names
`papercup-inference-gateway.service` and `papercup-mcp-proxy.service`.
The previous read used `papercusp-…` names and returned `unitsUnknown`;
its empty result did not establish an absence of failures. The corrected
read kept the same October 1 **11:25–11:45 UTC** interval. Both units were
recognized, the journal was available, and no journal error was reported.

The combined read reached its 30-row bound: `matched:31` is a lower bound
from the reader's `limit + 1` probe, not a failure count. The proxy tail
contains paired `clientError`/`ECONNRESET` socket-reset categories at
11:44:56.591Z, 11:44:52.769Z and 11:44:52.698Z. The current writer emits
both categories for the same socket error; timestamps alone do not prove
request identity, upstream failure or an independently failed user action.

A gateway-only read of the same interval completed without truncation.
The classifier retained the writer distinctions:

- The six collapsed routing rows at 11:35:00.465Z through 11:36:32.371Z
  matched the loose `429` search because their **client port numbers**
  contained that substring. They are `gw-route` records, not evidence of
  HTTP 429 responses. The writer uses `req.socket.remotePort` for `client`.
- Resource-governor rows at 11:44:56.899Z, 11:44:48.736Z and
  11:44:41.591Z report database **lock timeouts**. A colocated service log
  does not make these inference-request timeout or cancellation evidence.
- The 11:25:46.743Z error is a distinct upstream `STALLED`/aborted marker.
  The current writer uses that category for both `ttfb-timeout` and
  `cancelled` errors. The retained marker has no request ID, so it does
  not distinguish those mechanisms or establish application impact.

Receipts retain distilled diagnostics and identifiers, without raw logs:
`/tmp/p008-fire69-gateway-trace.json`
(`6ba2f37c98c8b020da420ae61efb37a6ca720eb979fa3ef53aa15fb72d17ce67`),
gateway-only `/tmp/p008-fire69-gateway-only.json`
(`7dfde0e11d986305b5d961fb862e343249e670731916f9af0da7acc6a5921a50`),
and writer classification `/tmp/p008-fire69-gateway-classified.json`
(`b7cf72fbca24f9debffda2f50cd0ad6e382ce239e974a88e2289e6f7935a25f5`).
The classification receipt has no summary truncation or child failure.

The live plan-acceptance resolver now returns an available verdict rather
than the earlier unknown state: `satisfied:false`,
`acceptance_bar_contract_not_ready`, plan revision 60/rubric revision 4.
R-8 remains blocked by inadequate/stale proof, its unmet live evidence
plane, and missing grading. No new binding, terminal disposition,
shared-host restart or shipment is claimed. The next useful correlation
is the exact 11:25:46.743Z upstream marker with its loaded runtime and
existing request-stage/cancellation evidence.

### Downstream cancellation misattribution — October 1, 12:52Z

The exact October 1 11:25:46.743Z marker was read independently in its
one-second journal window. The reader returned one matching entry, without
clipping, journal error or truncation. Its extracted reason is
`claude downstream response closed`, on account `aviynw6`, with no request ID.
This resolves the earlier marker ambiguity to a downstream-close signal; it
does not establish why the client closed, its application impact, or the
account's historical proxy configuration. Receipt
`/tmp/p008-fire73-marker-reason.json` has SHA-256
`b2bebff0894ca198376d3ac36d3d49432f556964a2ff49b2d3593b1e0c89d950`.

The current Claude attempt observer treated the kernel's typed `cancelled`
error as an upstream failure: it incremented `upstreamErrors`, logged
`STALLED`, and entered the egress failure/cooldown path when a proxy was
configured. The existing request-stage timeline already classified it as
cancellation, so that detector did not prevent the contradictory accounting
and proxy penalty. The fix branches on the typed cancellation before either
counter or penalty. Cancellation is logged at info level; both cancellation
and genuine transport-failure markers carry the existing process instance,
request ID and error code. No new service, tool, timer or telemetry store was
introduced.

The canonical HTTP regression compares a downstream disconnect with a real
upstream first-byte timeout against the same proxy-configured fixture.
Before the fix, cancellation produced `upstreamErrors:1` instead of zero;
the timeout control also failed its missing-correlation assertion. After the
fix, cancellation leaves both failure counters and the proxy cooldown quiet,
retains the cancelled timeline, and allows a subsequent request to succeed.
The genuine timeout still increments failures, cools the proxy and emits a
correlated `ttfb-timeout` marker. Selected run: two passes with 26 tests
excluded, exit 0. Full current matrix: **321 passes, zero skips, exit 0**:

```sh
PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- \
  packages/operator-core/lib/inference-gateway/gateway.test.ts \
  packages/operator-core/lib/inference-gateway/request-kernel.test.ts \
  packages/operator-core/lib/inference-gateway/gateway-stage-telemetry.test.ts
```

The full run began at 12:50:24.365Z on HEAD `783d3c0860` plus local test
changes. Gateway and stage-test fingerprints remained unchanged across the
run: `3d38a31c2dcfec4ec5685226f3b2433289e802484db94851dc9ebe5572511451`
and `9fdfef97378fd9886d7ddd92ab21336efee71ba9c2878644cb94e8e16ff5a986`.
Kernel source/test fingerprints were
`833afabb7c48d111725271f90e4800631fa1137b23f298fabaf41f0ef5e691eb` /
`56ced5c321269944549a6d3334cf293d0e47610223e3ad40c95acd40b1d5aa1c`;
gateway-test fingerprint was
`bfca80745f4162f28da8189056b5aa9e26363083ae5ad3bfa27b494d2a9e7614`.
This does not certify an immutable whole import graph. Red, selected green
and full-matrix logs are `/tmp/p008-fire73-abort-red.log`,
`/tmp/p008-fire73-abort-green.log`, and `/tmp/p008-fire73-gateway-matrix.log`,
with hashes `7ee84893f86b05198dc1a776cbb663c36ee4e6728b200b0db85d03c1874940f5`,
`c687810a68bca7462107e5eb8bbbc81cab5b69c908207d402c9e5e8f15164d66`, and
`9b5afd91e5784bf1f7fb2763ee0f3cb99526441554ff66b107212fd47f24552d`.
Focused diff validation passed.

Other Codex attempt observers still count cancellation through their error
branches; their distinguishing tests remain the next source step. Loaded
gateway adoption, the historical client-close cause and application impact
remain unverified. The shared-runtime, Portal and live-gate exclusions are
unchanged. **P-008/R-8 remains open; no terminal disposition or shipment is
claimed.**

### Codex cancellation parity — October 1, final source verification

The three Codex attempt observers (CLI, OAuth and bearer) also counted a
downstream cancellation as an upstream error. Canonical HTTP regressions
reproduced `codex.errors:1` rather than zero on each path. The observers now
branch on the existing typed `cancelled` error before failure accounting,
owner-ledger updates or credential-failure handling. Their cancellation and
transport-error logs use the existing process instance/request ID and error
code. No new telemetry surface was introduced.

A separate OAuth transport regression distinguished a native fetch
`AbortError` caused by downstream cancellation from a genuine TTFB timeout.
The adapter previously cooled `chatgpt-a:default` for 30 seconds on either
cause. It now reads the kernel's typed abort reason before attributing an
egress failure: cancellation leaves both the failure callback and cooldown
quiet; a real timeout preserves both. The direct adapter harness reproduced
the cancellation failure while its timeout control passed, then its full
suite passed **27/27**, zero skips, exit 0. It imports the adapter and kernel
directly; the contemporaneous mutation probe named `gateway.ts`, which this
harness does not exercise. This is not an immutable whole-import-graph claim.

The four-file current matrix passed **351 tests**, zero skips, exit 0 on
HEAD `0fa8a6e36d` plus local edits:

```sh
PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- \
  packages/operator-core/lib/inference-gateway/gateway.test.ts \
  packages/operator-core/lib/inference-gateway/request-kernel.test.ts \
  packages/operator-core/lib/inference-gateway/gateway-stage-telemetry.test.ts \
  packages/operator-core/lib/inference-gateway/codex-oauth-kernel-adapter.test.ts
```

All seven recorded source/test fingerprints stayed fixed during that run
(`/tmp/p008-fire76-fingerprints-before.txt` and `-after.txt`). A first selected
green run exposed a fixture mistake: buffered CLI request-ceiling expiry is
`gateway-error`, whereas HTTP TTFB expiry is `upstream-error`. The assertion
now preserves that existing distinction and verifies positive failure counts
for both deadline controls.

Scoped typechecking then caught three optional stats-map accesses in the
stage tests (including the prior Claude assertions). After correcting those
test accesses, the final stage suite passed **31/31**, zero skips, exit 0;
the four-file scoped typecheck passed with zero new errors and two existing
baseline diagnostics. The final production sources were unchanged by this
test-only correction. Final fingerprints:

- `gateway.ts`: `a6bcb14981baefc5b69498870635be76a5655b951911068016d294d89fbaaf99`
- stage test: `e119c153fd76e6a847f001bb3998248e8b6380aa04affc5e1b844a7997794950`
- OAuth adapter: `f4275b9bd8f1ce720a4ce68ef36e6c4e2f3c16ccf41dd955df9edcbef32e9a4f`
- OAuth adapter test: `b055eca041d06c72b46886bd50c5cc33ea980310827340abaf64e17ff04b1cbc`

Logs: `/tmp/p008-fire76-codex-red.log`, `-codex-green.log` (the fixture
correction), `-oauth-red.log`, `-oauth-green.log`, `-gateway-matrix.log`,
`-stage-final.log`, and `-tsc-final.log`. Final stage/typecheck log SHA-256:
`2bec5e66818942b0bca2a5bee75554d1a5ac20e2f10f8538b1d528a24a53fa07` /
`edb7092e14c6ec05878aa786d22984ffc9f14bf449a6f89d77c43a6e2a4e7ce9`.

The gateway edit was initially refused on a peer's mutation-probe lock.
After coordination and the durable lock grant, it was applied without
discarding peer changes; the peer confirmed their probe was stopped. Live
adoption, historical client-close cause/application impact and the remaining
R-8 operational inputs are still unverified. Portal and harvested-item
routing are now held by the fleet leader, as delivered in coordination.
**P-008/R-8 remains open; no acceptance binding or shipment is claimed.**

### Claude fork-seed owner attribution — October 2, current build

The earlier duplicate-path hypothesis is now narrowed by identity evidence.
The Claude adapter sorts candidate files newest first and takes the final
`ownerBackfill` value for each native session ID. A managed fork can leave a
same-ID seed copy under the fork's own owner directory. The launcher's
first-write-wins `psu-session-owners` entry records the born owner and its
resume path already uses that index when copies conflict. The ingest path did
not read it, so a later seed in traversal order could overwrite the indexed
turn owner.

A read-only scan at 16:25:46Z applied the actual Claude adapter's 45-day,
nonempty, newest-mtime candidate rules. It found 4,422 candidates, 519
duplicate native IDs, 485 duplicates with a born-owner index, and five where
the adapter's final path owner differed from that index; the indexed owner
had a candidate file in all five. Source hash before and after was
`83884d3931d290006a861c572296d43a4361469d043ab7188fc5059fa19a5f86`.
A separate repeatable-read, read-only PG snapshot at 16:27:19Z used a five-ID
sample with 5-second statement and 1-second lock timeouts and a closed
dedicated client. All five had indexed turns attributed to the traversal
winner; three also had `adv_sessions` rows naming the born owner. The sample
contains 5, 16, 31, 28 and 22 stored turns respectively. Session IDs and
owner IDs were hashed or reduced to role labels in the output. This confirms
the attribution defect in that snapshot; neither scan is the actual historic
natural sweep, and neither explains its slow UPDATE or application impact.

The companion `session_turn_parts` snapshot showed canonical owners for four
sample IDs but 196 parts attributed to the fork winner for the fifth. The
parts index was therefore a separate repair target, not just a render concern.

`session-ingest.ts` now reads the existing immutable birth index for managed
Claude candidates, with a bounded 20,000-entry module-pinned cache and
60-second negative expiry. The selected owner is used for ordinary sweeps,
EOF-only turn and parts owner repair, single-file freshness ingest and
historical parts backfill; sessions without an index keep their path-derived
fallback. This extends the existing index and ingest paths without a new
table, service or scheduled job. The private current-build regression makes
a fork seed older than the born file, a case that previously let the Map's
final write select the fork. It verifies initial insertion, EOF-only turn
and parts repair, single-file tail and a final sweep after the born file is
removed, including private database, HOME and port teardown.

The final isolated integration file passed **2/2, zero skips, exit 0** at
16:48:15Z on HEAD `a9d3048a08` plus local edits. The test route is
`PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file --
packages/operator-core/lib/search/session-ingest-runtime.integration.test.ts`;
its maintained child calls `scripts/with-test-pg.mjs --isolated-runtime`.
The phase receipt unit file passed **5/5, zero skips, exit 0** at 16:48:50Z.
Scoped `npm run lint:tsc -- --files=packages/operator-core/lib/search/session-ingest.ts,packages/operator-core/lib/search/session-ingest-runtime.integration.test.ts`
reported zero errors, exit 0 at 16:48:36Z; scoped `git diff --check` passed.
The source/test SHA-256s after verification were
`b1dc08570e06561ec05147f8f43775b87526b116e89641e8876ca2fe26e1f18f` /
`26ea067ae323670211d02c8d09f473faa0907ea9537d55ab6ad486131cfa0704`.
These are local-current-build observations, not a shared bg-host adoption
receipt. D-006 still reserves shared-host changes to the runtime owner's
coordinated route. Historical wait cause, app impact, live adoption and
R-8 acceptance remain open.

### Bounded natural owner-backfill receipts — October 2, 16:48–16:53Z

The shared bg-host's existing `session-ingest` logger recorded two ordinary
Claude sweeps. At 16:48:55.601Z it reported `requested=3589`,
`inputSha256=da79f531d93b783554b4403a59859dc7dac10f2896a1b1bd624581bd2b68a498`,
`durationMs=1050.8`, `updated=0`; at 16:53:22.132Z it reported
`requested=3604`,
`inputSha256=545e231a1c8f6c6e8cd4164eba64f550faf890b8d209a1fe3a29648eb9845b8c`,
`durationMs=1011.9`, `updated=0`. Both receipts say `status=completed` and
zero sweep errors. The bounded source was `logs:read` on
`papercusp-bg-host.service`, filtered to `[session-ingest] +` in the last
90 minutes; only these two matching sweep lines were returned. In
`session-ingest.ts`, `requested` is the per-sweep owner map size,
`inputSha256` hashes the exact ordered UNNEST arrays, and `updated` is the
PostgreSQL UPDATE row count. The input hashes differ, but neither sweep
changed a turn owner.

This is a two-sweep, zero-update observation on the loaded shared runtime,
not a reproduction or explanation of the earlier 1,123,628 ms UPDATE that
changed 3,873 turns. `dev:pipeline_position` for `session-ingest.ts` with
`testClass=background-federation` reported bg-host build `c194aeb678` and
`containsChange=false` by `start-after-mtime`, so these receipts do not prove
adoption of the October 2 fork-owner fix. D-006 still governs shared-host
adoption; the loaded-source identity and historical wait/app-impact evidence
remain open for R-8.

### Partial Claude owner-map repair guard — October 2, 17:19Z

A bounded `logs:read` of `papercusp-bg-host.service` selected natural
`sessionOwners` receipts with nonzero updates over the preceding three hours.
It returned 12 matching, untruncated journal entries. The 15:47:34.867Z
sweep scanned 153 files, requested 153 Claude owners, updated 3,997 turns,
and spent 165,562.8 ms in that repair. The 15:49:47.649Z sweep scanned
7,673 files, requested 3,631 owners, updated 3,997 turns, and spent
65,703.8 ms in the repair. Both reported zero sweep errors. Their bound-input
fingerprints are respectively `afe412a62b886df9ab065f0f4c2bbb1f71ee687424d162cb1f6019a9d61453dc`
and `be795e2dbb510a33954c5c96ee11c41a8981dc65788532fcaf4ccf4daaa944a8`.
The next 15:50:41.170Z sweep requested 3,631 owners but updated zero turns
in 109.5 ms; its input hash also differs. The 153-file sweep's 4,000-turn
budget is consistent with its short scan, but the receipts do not retain row
identities or owner values. The equal 3,997 update counts do **not** establish
that the same rows changed twice, or why their two durations differ.

Source inspection showed that the existing `ownerBackfill` map was filled
inside the file loop, which stops at the turn/file budget, while the Claude
candidate discovery and birth-index lookup already cover the complete set.
The existing private integration fixture ingests 4,099 Claude turns over two
sweeps. A new assertion requiring the first sweep's owner map to include all
179 candidate sessions failed in both isolated child cases before the fix.
The source now fills that map in the existing complete Claude candidate pass,
retaining the birth-index override and the prior duplicate-ID order, and
does not refill it from the budget-limited loop. The regression also requires
the partial and continuation sweeps to bind the same ordered owner-map hash.
The final current-build integration run passed **2/2**, zero skips, exit 0
at 17:17:56Z; private HOME/datadir removal and port closure remained checked.
Scoped `lint:tsc` checked both edited files and reported zero errors at
17:18:32Z; scoped `git diff --check` passed. Final source/test SHA-256s are
`017d2fc2c7ba534d7d56b672fc978a95dcae7108be278b06989147831a346719`
and `84f07e35f88ed540c246cc2a3abc21da13bd772ddc9502a8a3810a8766258b61`.

The coordinated D-006 runtime owner loaded a bg-host bundle at 17:12:07Z
from the earlier fork-owner source (`b1dc08570e06…1f18f`). PID 1373881's
command/cwd point at `apps/operator/dist-host/hono-host.mjs`; that bundle
contains the birth-index lookup and still fills the owner map inside the
budget-limited loop. It predates the partial-map edit above. Therefore the
fork-owner fix has a loaded-source marker, while this new guard remains
current-build only. No shared restart, live-gate operation, acceptance binding
or shipment is claimed. The source-level budget defect is fixed and guarded;
the historical 1,123,628 ms UPDATE's full wait decomposition and application
impact remain unproved, so **P-008/R-8 remains open**.

Commit and loaded-build handoff at 17:24Z: staging HEAD
`a83c8168dbcd7e18c8b53be03703fa32855124e8` contains the tested
source and test bytes (Git blobs `b5a0317f1eba3803b975aa3ce9eef19d964146c5`
and `6fbbd24ecbb2c5061565af8f4c5f1235a7c93e67`, respectively), matching
the SHA-256s above; the three edited paths were clean in that read. The
unique source marker is `a partial sweep cannot revert owners repaired by a
full sweep` at `session-ingest.ts:2986`. The first integration run ended
17:13:01Z with **two failures** on the new partial-map assertion against
the old source. The post-fix run ended 17:14:45Z with **2/2 passes**; a
second current-build run after adding the matching ordered-input-hash guard
ended 17:17:56Z with **2/2 passes**, zero skips. This is red/green proof
for the new fix, not a report that its final test remains red. The approved
D-006 bg-host runtime owner received the final hashes and committed-byte
receipt; loaded adoption of this newer map fix remains to be verified.

### Coordinated owner-map adoption and first natural sweeps — October 2, 17:36Z

The D-006 bg-host runtime owner reported a coordinated `dev:restart` and a
17:31:45Z bundle build (coord receipts
`coord-send-230c7c7519d92ce972991d8c50a8c263f03dfa49e6b0d59160a19059cad9d82d`
and `coord-send-5e30fb6e6a1fee0a19f735b2a2989533309add1c9209e552f30769fb5696854d`).
An independent read found `papercusp-bg-host.service` MainPID **2457467**,
active since **17:32:06Z**. Its command is `node dist-host/hono-host.mjs`
from the canonical `apps/operator` directory. The bundle mtime is
**17:31:45.894Z**, SHA-256
`8dacf0b733bf8d26871fc2aa4e42fe7e97169443e8914ca8e04251448cf58e82`;
bundle line 225651 contains the pre-budget
`ownerBackfill.set(sessionId, selected2)` code. The current source SHA-256
still matches the verified and committed
`017d2fc2c7ba534d7d56b672fc978a95dcae7108be278b06989147831a346719`.
Esbuild strips the source comment used as the earlier requested marker, so
the **code**, process identity and bundle timestamp are the loaded-source
evidence. This does not claim a byte-for-byte source-to-bundle attestation.

One bounded `logs:read` of this unit since its new start returned **two**
`session-ingest` receipts, untruncated and without journal error. The
**17:33:41.278Z** natural sweep scanned 148 files, inserted 67 turns and 665
parts, reported zero errors and repaired **715** Claude turn owners from a
3,637-session map in **37,099 ms**. Its ordered input hash is
`3c47a9fce46f251efd101e688dbff496604cfede950b58844b87032a35ebdecc`.
The **17:35:36.651Z** sweep scanned 457 files, inserted 38 turns and 490
parts, reported zero errors and updated **zero** Claude turn owners from a
3,638-session map in **108.8 ms**. Its input hash is
`7cde5125fb0f9d692acfe22abc2938ec0171aeed0424e348098d8cc6c9e88bb7`.
Both sweeps requested 709 Claude part-owner repairs and updated zero parts.
The maps have different sizes and hashes; the receipts do not identify the
715 repaired rows or prove that an identical map was replayed. They do show
one successful post-adoption repair followed by an ordinary zero-update
sweep on the loaded build. No new private test run was needed: the source/test
bytes are unchanged from the 17:17:56Z passing two-child regression above.

A bounded, read-only `pg_stat_statements` read matched query ID
`-9170796359460262385` to this exact guarded
`UPDATE session_turns ... FROM UNNEST` statement. With
`track_io_timing=on`, the **17:36Z** cumulative row since its
**14:58:47Z** per-query stats start reported 195 calls, **517,419.0 ms**
total execution and **452,028.5 ms** shared-block read time, with
1,658,613 shared blocks read. This is **aggregate** evidence that data-file
reads occupied much of this statement class's recorded time after the
2026-10-02 14:52:50Z stats reset. It is not per-call I/O attribution and
cannot decompose the **October 1** 1,123,628 ms UPDATE, which predates the
reset. Neither the two natural receipts nor the cumulative PG statistics
measure application latency. The historical wait mechanism, exact repaired
row identity, app impact and R-8 disposition remain open; **P-008/R-8 is not
terminal**.

A second bounded read at **17:41Z** saw the same one top-level statement row
after 200 calls: `total_exec_time=517,687.880 ms`,
`max_exec_time=165,560.693 ms`, `shared_blk_read_time=452,040.716 ms`,
and zero parallel workers launched. With no parallel worker time to double
count, the longest call had at least **99,913.529 ms** of shared-block read
time: total read time minus the maximum possible execution time of all other
calls (`452,040.716 - (517,687.880 - 165,560.693)`). This identifies
data-file reads as a material part of **that current-window slowest call**.
Its duration closely matches the 15:47Z natural 165,562.8 ms repair receipt,
but the aggregate stats row has no per-call ID, so the two records are not
joined as the same call. This still does not measure the October 1 statement
or user-facing application latency.
