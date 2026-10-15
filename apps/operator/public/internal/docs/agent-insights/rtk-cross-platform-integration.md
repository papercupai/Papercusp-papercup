# RTK (Rust Token Killer) integration — the four shell seams, the pinned installer, the alarms, and why it was lost in August 2026
URL: /internal/docs/agent-insights/rtk-cross-platform-integration

How RTK output compression is wired into every agent shell: native Claude Bash (inside the egress guard, the single Bash rewriter), capability:bash (at the spawn seam) and Codex's native shell (its own PreToolUse hook, allow + updatedInput, code-mode script calls left verbatim). Also: the pinned sha256 installer, the two alarms that make a loss visible, the tests that fail if the wiring is removed, and the 2026-08 root cause. OMP's native bash is the fourth seam (the coord hook's tool_call input replacement, WI-6554700010010472); an older desktop package reverting the installed hooks is covered too (WI-6554700010010534).

**Status (verified 2026-10-12, WI-6554700010009291 and WI-6554700010009447, owner directives #1759 / #1764):** RTK is installed and wired into all four agent shells on the Linux dev box (OMP native `bash` added 2026-10-13, WI-6554700010010472).

* Binary: `~/.local/bin/rtk`, **v0.51.0**, provisioned by `apps/operator/scripts/install-rtk.sh` (pinned release, sha256-verified). Desktop installs run the same script (WI-6554700010009448, see Provisioning).
* Native Claude `Bash`: a fresh `git status` came back in RTK form and rtk's ledger gained a row (15 -> 16) once `install-standalone-mcp.sh` had re-copied the hooks.
* `capability:bash`: on the staging build (:3170) the result header carried `rtk-compressed (prefix RTK_DISABLED=1 for raw output)`, and rtk's ledger recorded `git status -- apps/operator/scripts/install-rtk.sh` (48 tokens saved). The release build (:3070) serves `capability:bash` without the seam until the next deploy.
* Codex native shell: a real `codex exec` (0.162.1, through the Papercusp Codex gateway) executed `/bin/bash -lc 'rtk git status'` after our hook's output, PostToolUse saw `rtk git status`, the output was RTK's compressed form, and the ledger gained a row (2026-10-12 23:38:26Z). See "Codex native shell" below for what this does and does not reach.

RTK (`rtk-ai/rtk`, Apache-2.0) is a single Rust binary that rewrites a shell command into a wrapper that runs the same command and compresses its output (`git status` -> `rtk git status`, `cat f` -> `rtk read f`). Exit codes and porcelain formats pass through.

## Why it disappeared (the 2026-08 root cause)

RTK was lost twice over, and nothing noticed either loss for weeks.

1. **The binary.** It lived in the Homebrew prefix (`/home/linuxbrew/.linuxbrew/bin/rtk`, installed 2026-07-06). On **2026-08-15 at about 23:47 UTC** the whole Homebrew installation was deleted and rebuilt (the Cellar directory's mtime is 2026-08-15 19:50 EDT). Only Node, Python and SQLite were reinstalled. RTK was not, and the same rebuild also lost `autossh`, which broke a database tunnel on 2026-08-27. Who rebuilt it is **not attributable**: session logs on disk start 2026-09-05.
2. **The hook.** `rtk hook claude` shared a `PreToolUse` entry in `~/.claude/settings.json` with one of our hooks. An old bug in our settings installer deleted every command that shared an entry with one of our hooks (its own comment names rtk as the example). That is almost certainly how the hook entry vanished; no settings backup old enough survives to prove it. The installer bug is fixed.
3. **Why nobody noticed.** Both paths fail OPEN by design: `command -v rtk || exit 0`. That is the right safety choice for any single command and the wrong observability choice for the fleet. An agent found the missing binary on 2026-09-05 (EI-22418311654376080) and documented it here, but nothing reinstalled it.

**The general lesson:** a fail-open integration needs a separate signal that notices when it has been failing open for weeks. A native-tool integration must also be wired into our replacement tool (`capability:bash`), or the native-tool cutover silently drops it (owner #1764).

## Wiring — four seams, one contract

### Native Claude `Bash`: inside the egress guard

`apps/operator/scripts/hooks/cc/pretooluse-restricted-egress-guard.mjs` is the ONE `Bash` hook that returns `updatedInput`, and RTK runs inside it. Claude Code resolves several hooks that each return `updatedInput` **by completion order (the last to finish wins)**. A separate `rtk hook claude` entry could therefore race the guard and silently drop its network sandbox. So the old inline entry is gone from `apps/operator/scripts/worker-plugin/hooks/hooks.json`. The guard:

1. rewrites with RTK first (`rtkRewriteSync`, calling `rtk rewrite <cmd>`, 2 s timeout);
2. sandboxes that RTK form when the session is network-restricted, so both survive;
3. judges every deny on the ORIGINAL command, never the rewritten one.

`rtk rewrite` exit codes: `0` rewritten · `3` rewritten but rtk would ask (we use stdout only; the hook never delegates permission to rtk) · `1` no equivalent · `2` denied by rtk's own rules. Only `0`/`3` change the command.

The installed copy under `~/.papercusp/hooks/cc/` is what runs. Nothing re-copies it automatically: after editing the hook, re-run `bash apps/operator/scripts/install-standalone-mcp.sh`. The installed-hook drift watchdog alarms on a stale copy.

### `capability:bash`: at the spawn seam

`packages/operator-core/lib/agent-tools/capability/rtk-rewrite.ts` (`rtkCommandForCapabilityBash`), called from `capability/bash.ts` just before spawn. Fleet roles lose native Bash (`FLEET_CAPABILITY_REPLACED_TOOLS`), so without this seam none of their shell output would be compressed. Every gate before and after judges the original command; only the spawned text is the RTK form. The rtk binary's directory is prepended to the child `PATH` when absent. A rewritten result carries `rtk-compressed (prefix RTK_DISABLED=1 for raw output)` in its header and as an `rtk` field on background launches.

The `hooks.json` entry that covers `capability:bash` with the resource gate is deliberately SEPARATE from the native `Bash` entry and holds no rewriter.

### Codex native shell: its own PreToolUse hook

`apps/operator/scripts/hooks/cc/pretooluse-codex-rtk-rewrite.mjs` (`decideCodexRtk`), registered under matcher `^Bash$` on BOTH su and role Codex homes by `writeCodexLockHooks` in `packages/operator-core/lib/role-codex-home.ts`. It imports `rtkRewriteSync` from the egress guard, so the rewrite policy is identical to Claude's (vitest exclusion, `RTK_DISABLED=1`, size cap, 2 s timeout, `PAPERCUSP_RTK_BIN`, fail-open). It does NOT run `rtk hook codex`, whose rules differ.

Codex's hook contract differs from Claude's in ways that each cost a silent no-op if missed (read from `openai/codex` at tag `rust-v0.162.1`, the installed version, and confirmed by a live run):

* **`updatedInput` is applied ONLY with `permissionDecision: 'allow'`** (`hooks/src/engine/output_parser.rs`). Claude accepts a bare `updatedInput`; Codex silently ignores one. So this hook cannot reuse the egress guard's output shape. `allow` grants nothing extra: managed Codex homes already run `approval_policy = "never"`, and any deny from another hook still wins.
* Every shell handler (`exec_command`, unified exec, `shell`) reports `tool_name: "Bash"` with a string `tool_input.command`, which `updatedInput.command` must replace.
* Competing rewrites resolve by completion order (last to finish wins), the same race as Claude. This must stay the ONLY Codex hook that returns `updatedInput`; every other Codex hook only denies.
* Codex hands hooks the full parent `PATH` (measured: `~/.local/node25/bin` present, `node` resolves), so `#!/usr/bin/env node` hooks start.

**What it reaches — and why that is very little.** Current Codex models work in code mode: the model writes an `exec` script, and the script calls `tools.exec_command`. Those nested calls fire this same hook, with `tool_use_id` `exec-<uuid>` instead of the API's `call_*`. The hook leaves them VERBATIM, because the script reads the output before the model does and may parse it (`git status --porcelain`, `cat file.json`): the same structured-caller rule `capability:bash` follows. Measured over 24 h on 2026-10-12: 52,628 nested Codex `Bash` calls against 19 direct ones (`agent_activity`), and 124,568 `exec` calls against 175 direct `exec_command` calls (rollouts). With the code-mode host disabled, the tested model had no shell at all rather than falling back to a direct one. So the seam closes the gap for direct calls, and the real lever for Codex output volume is bounding `exec` output (WI-6554700010008932), not a shell compressor.

**Verifying it live.** A throwaway `CODEX_HOME` with the gateway provider block copied from a managed su home (the newest home by mtime can lack it: pick one whose `config.toml` has `[model_providers.papercusp-codex-gateway]`). Copy the hooks in the INSTALLED layout, `hooks/cc/` beside `hooks/inject/`: the egress guard imports `../inject/core.mjs`, and a flat copy crashes on import, which Codex reports only as `hook: PreToolUse Failed`. On 2026-10-12, a shim that called the real `decideCodexRtk` with a direct-style id produced the rewrite and ledger row above; the production hook on the same nested call printed nothing, exited 0 and left `git status` verbatim with no ledger row.

### OMP native `bash`: the coord hook's `tool_call` input replacement

`apps/operator/scripts/hooks/omp/coord-hook.ts` (installed as `~/.papercusp/papercusp-coord.ts`, loaded by `omp-su` via `-e`) applies RTK in its registered `tool_call` handler (WI-6554700010010472, owner directive #1798). OMP 18.0.3 lets a non-blocking `tool_call` handler return `input`, the raw input the tool executes with, and its extension wrapper re-resolves approval against that revised input (`extensibility/shared-events.ts`, `ToolCallEventResult`). Every gate in `onToolCall` judges the original command; only the executed text changes.

* `ompBashRtkResult` rewrites only OMP's `bash` tool and keeps every other parameter (`env`, `timeout`, `cwd`, `async`). It leaves the call alone when it is blocked, runs on a PTY (an interactive program), sets `RTK_DISABLED=1` in its `env`, or RTK has no rewrite.
* The rewriter is the shared `rtkRewriteSync`, imported at runtime from `~/.papercusp/hooks/cc/pretooluse-restricted-egress-guard.mjs`. A static `../cc/` import cannot work: the hook runs as `~/.papercusp/papercusp-coord.ts` (copied by `install-standalone-mcp.sh`, copied or esbuild-bundled by the desktop installer), where `../cc` resolves to `~/cc`. If the import fails, commands run verbatim.
* Fleet roles under the capability-only cutover have no native `bash` (`fleetOmpToolsArgs` passes `--tools read,find,glob,grep,web_search`) and get RTK through `capability:bash`. Interactive psu OMP sessions keep native `bash`.
* Verified 2026-10-13 with the installed rewriter and rtk 0.51.0: `git status` became `rtk git status` and `ls -la …` became `rtk ls -la …`; vitest, PTY and `python` calls were unchanged. Not yet observed in a live OMP session (OMP use was 6 sessions in the prior 7 days).

### Shared contract (all seams)

* **Binary resolution:** `PAPERCUSP_RTK_BIN` (an empty value disables RTK), then `~/.local/bin/rtk`, then `PATH`.
* **Never offered to rtk:** vitest commands (EI-9471: rtk's vitest wrapper once dropped a single-file filter and ran the full suite), commands prefixed `RTK_DISABLED=1`, commands over 16,384 chars, structured / code-mode callers of `capability:bash`, and Codex code-mode script calls (their scripts parse the output).
* **Fail-open:** a missing, failing, slow or denying rtk runs the original command unchanged. `rtk-rewrite.ts` returns a reason for every unchanged outcome (`flag-off`, `structured-caller`, `opt-out`, `vitest`, `too-long`, `rtk-missing`, `no-equivalent`, `rtk-denied`, `rtk-error`, `rtk-timeout`).
* **Raw output for one command:** prefix it with `RTK_DISABLED=1`.
* **Kill-switch:** flag `papercusp-capability-bash-rtk` (default ON) turns the `capability:bash` seam off fleet-wide. The native hooks ignore it: to disable RTK there, remove the binary or set `PAPERCUSP_RTK_BIN=`.

## Provisioning: `install-rtk.sh`

`apps/operator/scripts/install-rtk.sh` installs a **pinned** release (`RTK_VERSION=0.51.0`), sha256-verified, to `~/.local/bin/rtk`, outside any package manager's prefix. It is idempotent (a binary already at the pin is left alone) and is the ONE source of the version and hashes for both install paths. Pinned platforms: Linux x86\_64 (musl), Linux aarch64, macOS x86\_64, macOS arm64. Any other platform exits 2 and RTK stays disabled, failing open. Exit codes: `0` installed or current · `1` download/verify/install failed · `2` unsupported platform.

* **Dev box:** `install-standalone-mcp.sh` step 4i calls it on every install.
* **Desktop:** `build-desktop-sidecar.sh` ships the script to `sidecar/apps/operator/scripts/install-rtk.sh`, and `installPapercuspFiles` (`packages/operator-core/lib/desktop-install/papercusp-files.ts`, `provisionRtk`) runs it. Because the installer runs on launch paths, it never blocks one: if `~/.local/bin/rtk --version` already reports the script's `RTK_VERSION`, nothing runs; otherwise the script starts in the BACKGROUND (one run per process, 5-minute ceiling), and a failure is logged and retried on the next install. `InstallResult.rtkProvision.status` reports `current`, `started`, `in-flight`, `unsupported-platform` (Windows), `script-missing`, or `home-override`. Only the real user's home is provisioned, because every seam reads rtk from `$HOME`; a test or sandbox install with an overridden `home` installs nothing and never downloads.
* **Windows:** no pinned asset, deliberately. Windows is not an agent target, the RTK hooks are bash/node, and the script needs bash.

**Upgrading:** bump `RTK_VERSION`, replace every pinned hash with the `.tar.gz` lines from that release's `checksums.txt`, then run `apps/operator/scripts/__tests__/install-rtk.test.ts`. Both install paths pick the new pin up from the script.

⚠ **Never `cargo install rtk`.** crates.io's `rtk` is "Rust Type Kit", an unrelated FFI tool with no `hook` or `rewrite` subcommand. If you must build from source: `cargo install --git https://github.com/rtk-ai/rtk`.

Both installers refuse to publish an uncommitted hook source, so a new hook reaches `~/.papercusp/hooks/cc/` only after git-sync commits it.

## The alarms: making a silent loss loud

`packages/operator-core/lib/system-health/rtk-liveness.ts` runs on the existing hourly installed-hook-drift watchdog timer (no new scheduler). It raises two per-host severe-event conditions:

* **`alarm:rtk-liveness:<host>`**: rtk cannot be found or `rtk --version` fails. Opens on missing/not-runnable and resolves when healthy. Not gated on the kill-switch flag, because the native hooks call rtk regardless.
* **`alarm:rtk-recording:<host>`**: rtk is installed but **no seam reaches it**. It reads rtk's own ledger via `rtk gain --daily --format json`. If the newest day with a recorded command is more than 48 h old while at least 200 `capability:bash` calls ran in the last 24 h (`harness_shared.tool_invocations`), it opens. A quiet host (fewer calls) and the kill-switch flag OFF never alarm. An unreadable ledger or activity count is reported as NOT MEASURED, which leaves the condition untouched (neither a false alarm nor a false resolve). This is the detector for the August hook-entry deletion, where the binary would have been present and nothing reached it.

## Tests that fail if the wiring is removed again

| Removal                                                                                                                                         | Test that fails                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RTK dropped from the egress guard, or the sandbox wraps the original instead of the RTK form                                                    | `apps/operator/scripts/hooks/cc/__tests__/restricted-egress-guard.test.ts` ("RTK composed into the single Bash rewrite", `rtkRewriteSync`, script wiring)                                                          |
| OMP's `tool_call` handler stops applying the rewrite, rewrites a blocked or PTY call, or looks for the rewriter outside `~/.papercusp/hooks/cc` | `apps/operator/scripts/hooks/omp/__tests__/coord-hook.test.ts` ("RTK output compression for OMP native bash")                                                                                                      |
| A packaged hook directory ships without dates, or the standalone installer stops stamping `hooks/cc`                                            | `apps/operator/scripts/__tests__/write-hook-source-provenance.test.ts`, `packages/operator-core/lib/desktop-install/stamp-installed-cc-hooks.test.ts`                                                              |
| A second Bash rewriter re-added to `hooks.json`, or rtk added to the `capability:bash` gate entry                                               | `apps/operator/scripts/worker-plugin/__tests__/worker-plugin.test.ts`                                                                                                                                              |
| `capability:bash` stops spawning the RTK form                                                                                                   | `packages/operator-core/lib/agent-tools/capability/rtk-rewrite.test.ts` (drives the real `bash.handler`)                                                                                                           |
| The Codex hook drops `permissionDecision: 'allow'`, or starts rewriting code-mode script calls                                                  | `apps/operator/scripts/hooks/cc/__tests__/codex-rtk-rewrite.test.ts`                                                                                                                                               |
| The Codex registration is removed, gets the wrong matcher, a second Codex rewriter is added, or resumed homes stop being repaired               | `packages/operator-core/lib/role-codex-home.test.ts` ("Codex RTK rewrite": "registers exactly one ^Bash$ rewrite on SU and role homes", the resume-repair test, and an end-to-end test through `~/.local/bin/rtk`) |
| The dev-box installer stops provisioning rtk                                                                                                    | `apps/operator/scripts/__tests__/install-rtk.test.ts` ("install-standalone-mcp.sh provisions rtk")                                                                                                                 |
| The desktop installer stops provisioning rtk, provisions a non-real home, or the sidecar stops shipping the script                              | `packages/operator-core/lib/desktop-install/__tests__/papercusp-files.test.ts` ("RTK binary provisioning", including an end-to-end run of the real script against a fake release)                                  |
| The alarms stop firing                                                                                                                          | `packages/operator-core/lib/system-health/rtk-liveness.test.ts`                                                                                                                                                    |

Every guard above was proven falsifiable with `scripts/mutation-probe.sh` (copy-out; every mutant caught). For the Codex seam: wrong matcher, resume repair dropped, `allow` dropped, nested-call skip dropped. ⚠ A probe whose replacement contains Perl's `$'` post-match variable produces a SYNTAX-ERROR mutant whose "caught" proves nothing; use `${1}` capture references and check `mutant_parse=ok` in the result.

## Verifying a seam actually ran

The authoritative signal is a **new ledger row**, or the compressed output format (for example `git status` without git's hint lines). The model's paraphrase of the output is not evidence. Ledger: `rtk gain` (summary), `rtk gain -d --format json` (per day), or the sqlite file `~/.local/share/rtk/history.db` (table `commands`: `timestamp, original_cmd, rtk_cmd, saved_tokens, project_path`). Every seam writes the same ledger.

rtk prints `[rtk] warning: failed to parse permissions from <repo>/.claude/settings.json` on stderr for `rtk rewrite`. All seams read stdout only, so it is harmless.

## An older desktop package can revert the installed hooks (2026-10-13)

At 14:50Z on 2026-10-13 the packaged desktop sidecar (0.0.26, built 2026-10-07) reinstalled `~/.papercusp/hooks/cc` from `/usr/lib/Papercusp Server/sidecar/...`. Its egress guard predates `rtkRewriteSync`, so Claude native Bash lost RTK and the installed Codex RTK hook failed at import (`does not provide an export named 'rtkRewriteSync'`). The OMP seam fails open the same way.

Cause: the installer's downgrade guard (`install-provenance.ts`, WI-37405) orders installs by git committer date. A packaged app has no repository, so it had no date and the guard let the install through (`dates-unknown`). `install-standalone-mcp.sh` also wrote no `.installed-from`, so the record kept naming the packaged source after a canonical reinstall.

Fix (WI-6554700010010534): `build-desktop-sidecar.sh` writes `.source-provenance.json` beside each packaged hook directory (`apps/operator/scripts/write-hook-source-provenance.mjs`), and `resolveSourceGitProvenance` reads it when git has no answer. `install-standalone-mcp.sh` now stamps `hooks/cc` with the same `CC_HOOK_FILES` scoping as the desktop installer (`stamp-installed-cc-hooks.ts`). A package built before this fix still overwrites newer hooks: upgrade the desktop app, or re-run `install-standalone-mcp.sh` after it restarts. Check with `node -e 'import(process.env.HOME + "/.papercusp/hooks/cc/pretooluse-restricted-egress-guard.mjs").then(m => console.log(typeof m.rtkRewriteSync))'` (`function` means RTK is present).

## Open follow-ups

* Codex output volume is dominated by code-mode `exec` output, which no shell compressor reaches by design (WI-6554700010008932).
* Measured savings so far are modest (about 5% of input tokens across the first \~34 commands on 2026-10-12). D-023/D-026 of plan `token-efficiency-prompts-cache-and-behavior-2026-10-11` hold the volume analysis.

## Historical: 2026-07-06 per-platform verification (su-d2654)

These rows describe RTK 0.43.0 via Homebrew, before the August loss. They were not re-verified with 0.51.0.

* **Linux**: full e2e through fresh `claude -p` sessions. `git status` was rewritten and recorded; `PAPERCUSP_AGENT_SESSION=1 git reset --hard HEAD` was still DENIED by the shared-tree guard (deny wins over a rewrite); failing `node --test` output was byte-identical raw vs rtk with exit 1 both times.
* **macOS** (x86\_64 Sonoma): full e2e. The output came back in rtk's compressed format and the ledger incremented.
* **Windows**: the binary was verified (0.43.0 prebuilt zip; 0.42.4 from git). `rtk hook claude` emits a correct `updatedInput`, so the claim that native Windows has no auto-rewrite hook is outdated. There was no live `claude -p` e2e, since Claude Code was not installed on the VM and Windows is not an agent target.

## Related

* `agent-insights/pretooluse-updatedinput-evades-deny-patterns` (WI-3159): why denies are judged on the original command.
* The 2026-09-05 absence finding: EI-22418311654376080.
* Reintegration: WI-6554700010009291 (owner #1759 / #1764). Codex seam: WI-6554700010009447. Desktop provisioning: WI-6554700010009448.
