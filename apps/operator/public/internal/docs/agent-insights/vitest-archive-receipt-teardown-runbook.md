# Vitest archive receipt teardown runbook
URL: /internal/docs/agent-insights/vitest-archive-receipt-teardown-runbook

Diagnose fork termination warnings caused by synchronous reporter validation blocking controller exit callbacks.

Vitest can warn about fork termination even after the test process has exited. A blocked controller can delay the exit callback that finishes the pool's stop promise. The warning alone does not prove leaked worker handles.

## Measured mechanism

The archive snapshot path used to call `readVerifierSourceReceiptSync` in the reporter's controller. Its full source census and synchronous Git reads prevent that controller from servicing fork shutdown callbacks. `readVerifierSourceReceipt` now runs the exact synchronous verifier in one owned native worker and resolves only after that worker exits. Source, symlink, executable, Git and submodule checks retain their existing fail-closed behavior; the synchronous API remains available to synchronous consumers.

The reduced maintained test uses the real Vitest pool and a tiny passing test. It instruments stop request, stopped acknowledgement, worker stop and exit. Both control paths validate the same independent receipt and use the same delayed Git shim. On Linux, the shim independently checks that the fork is absent or a zombie in `/proc`, before snapshot completion.

The synchronous control produces a termination warning and receives the fork-exit callback after snapshot completion, despite the OS exit observation. The asynchronous reporter receives the acknowledgement and completes fork shutdown during receipt validation, without that warning. This separates controller callback starvation from a live test worker retaining handles.

## Reproduce and interpret

1. Run `PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- libs/test-config/src/admin-test-runs-reporter.test.ts -t 'distinguishes real Vitest fork-stop callback'`.
2. Check the source stamp and terminal verdict. The test asserts both control outcomes and reports complete event traces on an ordering failure.
3. Run the full reporter file after changing this shared path; preserve source-mutation and changed-Git-identity rejection.
4. Diagnose a historical warning from its own saved process/event evidence. A current reduced reproduction proves the mechanism, not the cause of every earlier warning.

## Probe preconditions

Vitest 4 selects built-in pool names before custom initializers. The probe therefore uses a distinct `receipt-forks` initializer that delegates to the real `ForksPoolWorker`, and asserts that instrumentation was selected.

Reporter entry and stop scheduling can race through microtasks. The probe awaits the actual stop request before receipt work; it does not assume a universal ordering. In the measured synchronous run, stopped acknowledgement and worker-stop already preceded the reporter census: the delayed phase was the exit callback.

Evidence: EI-25891108828268139; focused ledger row 21244507 and full reporter row 21244514. Full local reporter invocation passed 167 assertions, with no skipped cases; both rows explicitly record a dirty working tree. Original c866 warning attribution remains unknown. The separate historical checkout timeout in EI-25892586878606558 also lacks measured frozen/active timing and must not be attributed from these teardown controls.
