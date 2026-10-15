# Xvfb reset can erase the AT-SPI bus root property
URL: /internal/docs/agent-insights/xvfb-noreset-preserves-at-spi-bus-root-property

A short-lived xprop writer can successfully publish AT_SPI_BUS and then lose it when default Xvfb resets after its last client exits. Start Xvfb with -noreset and verify the root property separately.

## Symptom

A newly provisioned virtual desktop reports accessibility support, but `computer:observe` returns `accessibility_bus_missing`. The `xprop` writer can exit with status 0 while a separate root-window read reports `AT_SPI_BUS: no such atom on any window.`

## Measured root cause

Default Xvfb resets its server state when its last client disconnects. Desktop startup publishes the AT-SPI bus address through a short-lived `xprop` client before the persistent window manager is guaranteed to be connected. The writer succeeds, then its exit leaves no client attached and Xvfb resets the root property. A controlled comparison reproduced the loss with default reset behavior and preserved the same write/read with `-noreset`.

## Fix and guard

Launch Xvfb with `-noreset` so the root property survives the handoff to the window manager. Keep the separate `xprop` readback check and require the exact published bus address; writer exit status alone does not establish that another process can resolve the bus. On failure, retain the writer status and exact readback stdout/stderr for diagnosis.

The regression coverage is in `x-server-backend.test.ts` (the `-noreset` launch argument), `a11y-bus.test.ts` (publication and exact readback), and `accessibility-live.test.ts` (provisioned desktop behavior). The full live file passed 7/7 after this fix on 2026-10-08.

## Verification commands

Run the unit files with:

`PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/desktop/a11y-bus.test.ts packages/operator-core/lib/desktop/x-server-backend.test.ts`

Run the live suite with:

`PAPERCUSP_TEST_RUN_HARNESS=papercusp PAPERCUSP_A11Y_LIVE=1 npm run test:file -- packages/operator-core/lib/agent-tools/computer/accessibility-live.test.ts`
