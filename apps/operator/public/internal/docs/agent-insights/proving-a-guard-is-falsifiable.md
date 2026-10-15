# Proving a guard is falsifiable — never mutate the shared tree to do it
URL: /internal/docs/agent-insights/proving-a-guard-is-falsifiable

How to prove a guard test CAN fail without mutating the shared tree: the tier table, scripts/mutation-probe.sh invocation forms (fake-destructive, copy-out, historical, in-tree), its exit codes, and the sweep-lock recipe for the rare in-tree probe.

A guard test that has never failed is a guard you have not tested. Proving it CAN fail is correct discipline — but the obvious way to prove it is unsafe on the shared tree, and has already cost a committed mutant:

```bash
cp "$F" "$B"; <mutate>; <run the suite>; cp "$B" "$F"     # ⛔ never do this
```

It fails in **two independent ways**, and the second is not fixable by being careful:

1. **DEATH RACE** — the restore is the LAST statement, so anything that kills the command partway (the 2-min foreground Bash deadline, a SIGTERM, a compaction) skips it. A `trap` fixes this one.
2. **SWEEP RACE** — git-sync commits the WHOLE working tree every few minutes, and a probe legitimately holds the file mutated for as long as the suite runs. A sweep landing in that window commits the mutant *even though nothing went wrong and the trap never fired.* **A trap cannot fix this — it is a mitigation, not a fix.**

A mutation probe that mutates the shared tree can be committed by the sweep even when nothing goes wrong and no handler fails. `git status` cannot warn you either: on a swept tree a clean status means the sweep ran, not that the file is unmodified.

See also [mutation testing without touching the shared tree](/internal/docs/agent-insights/mutation-testing-without-touching-shared-tree) for isolated-stack mutation e2e.

## Pick the lowest tier that fits

Only the last row's in-tree mutation dirties the tree.

| your subject                                                                                                                | how to prove falsifiability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a subject (or `--test` cmd) containing DESTRUCTIVE primitives (rm/rmdir/unlink/shred/truncate/mkfs/`dd of=`/`find -delete`) | **TIER-0: `--fake-destructive`** — PATH shims log each destructive call's argv and delete NOTHING; assert on what the code WOULD delete. The probe REFUSES such a subject without it; REAL execution needs `--i-know-this-deletes --sandbox-root <dir>` (bwrap, `/` read-only). Limit: PATH interception only — an absolute-path `/bin/rm` call needs the sandbox.                                                                                                                                                                                                                                                                                        |
| a MODULE / logic you `import`                                                                                               | Keep a deliberately-wrong implementation **permanently in the test file** as a control (plus a calibration case the REAL subject must pass, or the controls also pass when the property itself is broken). Never mutate production code.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| a guard whose subject is the SOURCE TREE itself (it greps/walks files and asserts over their text)                          | ⚠ The control fixture lives INSIDE the subject, so a plainly-spelled fixture **SELF-MATCHES** — the `pgrep -f` trap in static form. It fails loud (a false positive), but a guard red forever gets deleted or weakened. **Strip before matching** with `stripCommentsAndStrings` (`scripts/lib/strip-comments-and-strings.mjs`, offset-preserving), or exclude the fixture's path, and **assert the fixture is STILL detector-shaped** so the control can never pass VACUOUSLY. ⚠ Don't strip where real tokens live inside literals (`DROP DATABASE` in a SQL template): that flips a true positive into a silent false NEGATIVE — decide per call site. |
| a FILE artifact the test reads by path (shell scripts, config, generated output)                                            | Mutate a **COPY** outside the tree and point the test at it — zero window, no lock, no trap. Make the test's subject path overridable (an env var defaulting to the real path); that one line is what makes tier 2 available at all.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| a guard whose pre-fix source is already in Git history                                                                      | **HISTORICAL MODE:** use `--against-commit <sha> --must-be-absent <literal>` or `--against-last-without <literal>`. The probe freezes current and historical snapshots before either run, requires `--positive-control <literal>` for every token the assertions index, and requires a `--calibration` command that passes on both snapshots.                                                                                                                                                                                                                                                                                                             |
| genuinely unavoidable in-tree mutation                                                                                      | Last resort. Hold the sweep for the probe's duration AND restore from a trap (see the sweep-lock recipe below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## The probe script

**`scripts/mutation-probe.sh` implements tier 0, historical mode, and tiers 2–3** so nobody hand-rolls the unsafe shape again. Copy-out is the default; it proves the tracked file is byte-identical before exiting, and it **refuses a mutation that changed nothing** — a no-op mutation makes any guard look weak, which is a false verdict from a probe that never mutated anything. `--mutate` is strict-checked: an undefined perl `$var` in the replacement is a hard refusal, not a silent empty-string expansion (the exact failure that once turned a probe's subject destructive).

Historical mode is the first choice when a true pre-fix source exists in Git. Never assume `HEAD` is “before” on this swept tree: use `--against-commit <sha> --must-be-absent <literal>`, or let `--against-last-without <literal>` select the newest reachable commit whose file lacks that literal. Every `--positive-control <literal>` must be present in both snapshots, and `--calibration <command containing {}>` must pass against both; those checks prevent a missing token or a broken instrument from becoming a plausible falsifiability verdict. The guard command must pass against current and produce the requested caught/survived verdict against the frozen historical snapshot.

### Invocation forms

```bash
# --fake-destructive is REQUIRED here: the subject contains rm/unlink, so the
# destructive-primitive gate refuses this probe outright without it.
scripts/mutation-probe.sh \
  --file scripts/verify-tauri-headless.sh \
  --fake-destructive \
  --mutate 's/^\s*if port_lost_to_squatter; then PORT_LOST=1; break; fi$//' \
  --test 'PROBE_SCRIPT={} npm run test:file -- apps/operator/lib/verify-tauri-headless-bind-retry.test.ts'
```

```bash
# Historical mode: NEW_GUARD must be present now but absent from the selected
# before-fix commit; stable-control is a required positive control.
scripts/mutation-probe.sh \
  --file packages/operator-core/lib/attention/bulk-resolve-kill-switch.test.ts \
  --against-last-without 'NEW_GUARD' \
  --positive-control 'stable-control' \
  --calibration 'grep -q "^stable-control$" {}' \
  --test 'grep -q "^NEW_GUARD$" {}'
```

## Exit codes

`0` mutant/historical source CAUGHT (guard is falsifiable ✓) · `1` mutant/historical source SURVIVED (your guard is weaker than you think) · `2` misuse / missing historical control / failed calibration / no-op mutation / a mutant that no longer PARSES · `3` in-tree restore FAILED, act now. Note `0` means *the guard failed on the mutant or historical source* — "the probe succeeded" and "the test passed" mean OPPOSITE things here.

## Read, replay and bind recorded proof

A recorded probe row stores `execution_details.mutation`: `probeInvocationId`, `leg`, mode, subject path, the mutation expression or full historical commit, before/after subject hashes, bounded diff, and the literal `testCommand` beside its SHA256. The command preserves inline environment such as `PROBE_SUBJECT={}`. Replay that template against the same repository revision and subject with the recorded mutation. Older descriptor rows retain the hash alone; their command cannot be reconstructed from the hash. Historical descriptors also retain `historicalControls`: the exact `mustBeAbsent` literal, ordered `positiveControls`, `calibrationCommand`, and optional `subjectMustBehave` command. Replay them as `--must-be-absent`, repeated `--positive-control`, `--calibration`, and optional `--subject-must-behave`, using the recorded full `againstCommit`. Pre-field rows remain readable but cannot reconstruct these missing settings. Match the recorded before/after hashes to the replayed snapshots; a changed working tree or missing commit cannot reproduce the same proof.

`PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT=auto` is the default. It tests the deployed reader's exact parser and withholds the descriptor until that reader accepts the current fields; the log says why. Use `always` only against a reader you have verified compatible. `never` deliberately records legacy rows with unverified linkage. A source edit or green local test does not prove the default live path has adopted the descriptor.

Find probe rows through `testing:runs { source:'mutation-probe' }` or `testing:runs { testRunIds:[N] }`. The default source filter can omit them; an exact ID read preserves the requested probe row and discloses that filter omission.

A historical guard that reads a fixed source path rather than the passed snapshot exits **INCONCLUSIVE (2)** with `guard-ignores-subject`. An unrelated crash or timeout in the poisoned-snapshot control gives `consumption-unproven`. These are uncertainty, not SURVIVED or CAUGHT. Copy-out relocation is the appropriate mode for guards that import their subject; historical mode is useful when the guard actually consumes the passed snapshot.

Binding a descriptor-linked mutant catch after a survivor on the unchanged test can return `mutation_reaim_unjustified`. Pass a structured `reaimJustification` with `survivorTestRunIds` naming every relevant survivor and a concrete `reason` explaining the changed mutation; the binder validates and stores it. This check covers ledgered mutant-leg rows. Pre-descriptor rows and disabled exports do not establish re-aim coverage.

The destructive-code fence still applies to source and prose subjects. Its current textual detection can match destructive command examples in comments or documentation. This known limitation is tracked separately; `--fake-destructive` follows the existing controlled-mock contract and is not a general bypass for destructive execution.

## Sweep-lock recipe (tier 3 only)

For tier 3, pause the sweep only for the files the probe mutates — git-sync excludes actively file-locked paths from its staging pathspecs, so probes on disjoint files and unrelated commits keep moving:

```
locks:acquire {
  paths: ['<repo-relative-mutated-file>'],
  coordination_domain: '<physical root for a nested repository>',
  ttl_sec: 1200,
  intent: 'mutation probe'
}
```

Top-level file: omit `coordination_domain`. Submodule: use its physical root (`git -C <file-directory> rev-parse --show-toplevel`) and keep `paths` relative to it. `--sweep-lock-held` refuses unless this session owns a live lock with intent `mutation probe`, then heartbeats it to 1200 s; the in-tree window is capped at 600 s. After the trap verifies restoration: `locks:release { lock_id }`.

The file lock is the whole fence, superproject and submodule alike. Do **not** take the exclusive `git-sync:<harness>` lease (it freezes every agent's commits): git-sync re-reads the lock census AFTER staging and unstages any late-locked or drifted path (EI-24712906810240170), provided the lock precedes the mutation and is released only AFTER the verified restore, the order the probe enforces. Evidence binders refuse to fingerprint a locked path.

`--accept-sweep-race` is only for a checkout known not to be swept or a consciously accepted risk; prefer copy-out mode (no dirty window).

## Peers can see the dirty window

⚠ The dirty window is visible to PEERS (EI-18750303030034478): a peer's raw `test:file` / `test:affected` can read the mutant and report an unrelated red. While a probe's `original.manifest` exists, a failing raw run prints `TEST_FILE_MUTATION_PROBE_WINDOW` naming the subject; treat a red on it or an importer as probe evidence and re-run once the window closes. `testing:run` refuses with `mutation_probe_active`.
