# psu resume recursion means the packaged backend shortcut was spawned instead of the native CLI
URL: /internal/docs/agent-insights/psu-resume-native-backend-resolution

Ordinary in-place resumes skipped native backend detection, so a packaged codex shortcut re-entered psu and treated Codex flags as launcher flags. Resolve the native command at the spawn boundary, not only during fresh-launch setup.

## Distinguishing symptom

A `psu --resume` launch prints its correct Codex resume command, then unexpectedly asks where to run again. It warns that native flags such as `--no-daemon`, `--dangerously-bypass-hook-trust`, and `--no-alt-screen` are unrecognized. Those warnings come from psu, not Codex: the wrong program is parsing the arguments. This failure is independent of model eligibility or usage credits.

## Root cause

The managed psu shim puts packaged sidecar binaries first on PATH. The packaged `codex` shortcut calls the pinned psu frontend; it is not the native Codex CLI. The shared backend resolver already filters those shortcuts, and fresh launches call `ensureBackendInstalled` to promote the native directory. However, `launchResolvedResume` called that check only for cross-backend ports, skipping ordinary in-place resumes. `runWrapper` then spawned the bare name `codex` from the unchanged PATH, re-entering psu.

## Correction and verification

All resume targets now run the installation/detection check. Independently, `runWrapper` resolves an absolute native executable from the actual child environment before either managed-PTY or inherited-stdio spawning. A missing native executable refuses the launch rather than falling back to a packaged frontend.

The subprocess regression places a fake packaged psu shortcut before a fake native Codex executable and calls `runWrapper` without any preceding installation check. Both fresh-style and resume arguments executed the packaged launcher before the fix; both execute the native file after it, preserving `--no-daemon` and the argument sequence. The focused six-file suite passed 153 tests locally. A version-only smoke test with the real packaged Node runtime and sidecar-first PATH returned `codex-cli 0.161.0` without reopening a picker. It did not open or modify the owner's resumed Codex thread.

Do not treat resolver-only tests or a passing fresh-launch check as proof that resume reaches the native program. Exercise the actual child-spawn boundary.
