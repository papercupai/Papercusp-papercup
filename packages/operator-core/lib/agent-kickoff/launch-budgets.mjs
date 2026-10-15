/** One timing contract for the existing spawner, verifiers and plain-Node CLI.
 * Keep the parent deadline outside every sequential child proof window. */
export const EARLY_EXIT_PROBE_MS = 1200;
export const HEADLESS_BOOT_RECEIPT_MS = 6000;
export const KICKOFF_PROOF_WINDOW_MS = 120_000;
export const FRESH_VERIFY_TIMEOUT_MS = 25_000;
export const RESUME_VERIFY_TIMEOUT_MS = 30_000;

// Reserve bounded preflight and durable receipt settlement outside the child
// proof waits. Fresh and resume verification are mutually exclusive.
const LAUNCH_CONTROL_SETTLEMENT_MS = 30_000;
export const AGENT_LAUNCH_HANDLER_TIMEOUT_SEC = Math.ceil((
  EARLY_EXIT_PROBE_MS + HEADLESS_BOOT_RECEIPT_MS + KICKOFF_PROOF_WINDOW_MS
  + Math.max(FRESH_VERIFY_TIMEOUT_MS, RESUME_VERIFY_TIMEOUT_MS)
  + LAUNCH_CONTROL_SETTLEMENT_MS
) / 1000);
// MCP adds its five-second settlement fence; the CLI leaves delivery margin.
export const AGENT_LAUNCH_CLIENT_TIMEOUT_MS = (AGENT_LAUNCH_HANDLER_TIMEOUT_SEC + 10) * 1000;
